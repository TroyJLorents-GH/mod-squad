import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Range, ScanStatus, View } from '../types'
import { RANGES, RANGE_HOTKEY, RANGE_LABEL, aggregateAll, isRange } from './aggregate'
import { COLORS, fmtCost, headerLines, layout } from './layout'
import type { Line } from './layout'
import { dayKey, emptyFile, indexAtByte, parseText } from './parse'
import type { FileState } from './parse'
import { costOf } from './pricing'

const PANE = 'burn-rate'
/** Files up to this size are read whole with $.fs.read (which refuses anything over 4 MiB). */
const FS_READ_MAX = 4_000_000
/** Larger files are read this many bytes at a time through `tail | head`. */
const CHUNK = 3_000_000
/** Lists kept per view (the pane shows fewer). */
const KEEP = 40
const STORE_PREFIX = 'f:'

const IDLE: ScanStatus = { isScanning: false, done: 0, total: 0, parsed: 0, skipped: 0, finishedAt: 0 }

const rangeRef = atom({ plugin: 'burn-rate', key: 'range' } as const, null as Range | null)
const viewsRef = atom({ plugin: 'burn-rate', key: 'views' } as const, null as Record<Range, View> | null)
const statusRef = atom({ plugin: 'burn-rate', key: 'status' } as const, IDLE)
const sinceRef = atom({ plugin: 'burn-rate', key: 'sinceScan' } as const, 0)

type Options = { defaultRange?: string }
type Found = { path: string; size: number; mtime: number }
type Summary = { day: string; cost: number; tz: number }

// Parsed aggregates by path, so a scan in this module's life re-reads nothing unchanged.
// A hot reload empties it; $.store holds the same aggregates across sessions.
const memory = new Map<string, FileState>()
let isBusy = false

/** Minutes east of UTC, from the host's `date` (the plugin's own clock may run in UTC). */
async function tzOffset($: EngineInterface): Promise<number> {
  try {
    const r = await $.process.run(['date', '+%z'], { timeoutMs: 3000 })
    const m = /^([+-])(\d{2})(\d{2})/.exec(r.stdout.trim())
    if (m) return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
  } catch {
    // No process (desktop sandbox, tests): fall back to the environment's own idea.
  }
  return -new Date().getTimezoneOffset()
}

/** The Claude config folders whose projects/ hold transcripts. */
async function configRoots($: EngineInterface): Promise<string[]> {
  const roots: string[] = []
  const configured = await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)
  if (configured) for (const p of configured.split(',')) if (p.trim() !== '') roots.push(p.trim())
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? (await $.env.get('USERPROFILE').catch(() => undefined))
  if (home) roots.push(`${home.replace(/[\\/]+$/, '')}/.claude`)
  return [...new Set(roots.map(r => r.replace(/[\\/]+$/, '')))]
}

/** Every *.jsonl under `dir`, subagent folders included, `depth` levels down. */
async function walk($: EngineInterface, dir: string, depth: number, out: Found[]) {
  const entries = await $.fs.list(dir).catch(() => [])
  for (const en of entries) {
    const path = `${dir}/${en.name}`
    if (en.kind === 'file' && en.name.endsWith('.jsonl')) out.push({ path, size: en.size, mtime: en.mtimeMs })
    else if (en.kind === 'dir' && depth > 0 && en.name !== 'tool-results') await walk($, path, depth - 1, out)
  }
}

async function discover($: EngineInterface): Promise<Found[]> {
  const out: Found[] = []
  for (const root of await configRoots($)) await walk($, `${root}/projects`, 3, out)
  const seen = new Set<string>()
  return out.filter(f => (seen.has(f.path) ? false : (seen.add(f.path), true)))
}

/** `count` bytes of `path` from byte `from`, through the shell (for files $.fs.read refuses). */
async function readChunk($: EngineInterface, path: string, from: number, count: number): Promise<string> {
  const r = await $.process.run(
    ['sh', '-c', 'tail -c +"$1" "$2" | head -c "$3"', 'burn-rate', String(from + 1), path, String(count)],
    { timeoutMs: 30_000 },
  )
  return r.stdout
}

/** Bytes in the line starting at `from` (for a single line longer than a chunk, which is skipped). */
async function lineLength($: EngineInterface, path: string, from: number): Promise<number> {
  const r = await $.process.run(['sh', '-c', 'tail -c +"$1" "$2" | head -n 1 | wc -c', 'burn-rate', String(from + 1), path], {
    timeoutMs: 30_000,
  })
  return Number(r.stdout.trim()) || 0
}

async function storedState($: EngineInterface, path: string): Promise<FileState | undefined> {
  const held = memory.get(path)
  if (held !== undefined) return held
  const raw = (await $.store.get(STORE_PREFIX + path).catch(() => undefined)) as FileState | undefined
  return raw && raw.v === 2 ? raw : undefined
}

/** Brings one file's aggregate up to date, reading only what was appended since last time. */
async function scanFile($: EngineInterface, f: Found, tz: number): Promise<{ state: FileState; isParsed: boolean }> {
  const prev = await storedState($, f.path)
  if (prev !== undefined && prev.size === f.size && prev.mtime === f.mtime) return { state: prev, isParsed: false }

  // Transcripts are append-only: carry on from where the last parse stopped, unless the file shrank.
  const state: FileState =
    prev !== undefined && f.size >= prev.off ? (JSON.parse(JSON.stringify(prev)) as FileState) : emptyFile()

  if (f.size <= FS_READ_MAX) {
    const text = await $.fs.read(f.path)
    state.off += parseText(state, text.slice(indexAtByte(text, state.off)), tz)
  } else {
    for (let guard = 0; state.off < f.size && guard < 10_000; guard++) {
      const text = await readChunk($, f.path, state.off, CHUNK)
      if (text === '') break
      const used = parseText(state, text, tz)
      if (used > 0) state.off += used
      else if (text.length < CHUNK && !text.includes('\n')) break // a partial last line still being written
      else state.off += Math.max(1, await lineLength($, f.path, state.off))
    }
  }
  state.size = f.size
  state.mtime = f.mtime
  memory.set(f.path, state)
  await $.store.set(STORE_PREFIX + f.path, state).catch(() => undefined)
  return { state, isParsed: true }
}

function trimView(v: View): View {
  return {
    ...v,
    projects: v.projects.slice(0, KEEP),
    models: v.models.slice(0, KEEP),
    tools: v.tools.slice(0, KEEP),
    shell: v.shell.slice(0, KEEP),
    mcp: v.mcp.slice(0, KEEP),
  }
}

function statusLine(todayCost: number): string {
  return `🔥 ${fmtCost(todayCost)} today`
}

/** Scans every transcript (incrementally) and publishes all ranges' views. Runs off any hook's clock. */
async function runScan($: EngineInterface) {
  if (isBusy) return
  isBusy = true
  try {
    await update($, statusRef, s => ({ ...(s ?? IDLE), isScanning: true, done: 0, total: 0, error: undefined }))
    const tz = await tzOffset($)
    const found = await discover($)
    await update($, statusRef, s => ({ ...(s ?? IDLE), total: found.length }))

    const states: FileState[] = []
    let parsed = 0
    let skipped = 0
    for (let i = 0; i < found.length; i++) {
      const f = found[i]
      if (f === undefined) continue
      try {
        const r = await scanFile($, f, tz)
        states.push(r.state)
        if (r.isParsed) parsed++
      } catch {
        skipped++
        const prev = await storedState($, f.path)
        if (prev !== undefined) states.push(prev)
      }
      if (i % 10 === 9) await update($, statusRef, s => ({ ...(s ?? IDLE), done: i + 1 }))
    }

    // Transcripts Claude Code has since cleaned up still count: their aggregates stay in the store.
    const live = new Set(found.map(f => f.path))
    for (const key of await $.store.keys().catch(() => [] as string[])) {
      if (!key.startsWith(STORE_PREFIX) || live.has(key.slice(STORE_PREFIX.length))) continue
      const kept = await storedState($, key.slice(STORE_PREFIX.length))
      if (kept !== undefined) states.push(kept)
    }

    const today = dayKey(await $.clock.now(), tz)
    const all = aggregateAll(states, today)
    const views = Object.fromEntries(RANGES.map(r => [r, trimView(all[r])])) as Record<Range, View>
    const finishedAt = await $.clock.now()
    // No transcripts at all: leave the views empty so the pane says so.
    await update($, viewsRef, () => (states.length === 0 ? null : views))
    await update($, sinceRef, () => 0)
    await update($, statusRef, () => ({ isScanning: false, done: found.length, total: found.length, parsed, skipped, finishedAt }))
    const summary: Summary = { day: today, cost: views.today.cost, tz }
    await $.store.set('summary', summary).catch(() => undefined)
    $.ui.status(statusLine(views.today.cost))
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await update($, statusRef, s => ({ ...(s ?? IDLE), isScanning: false, error })).catch(() => undefined)
  } finally {
    isBusy = false
  }
}

/** Starts a scan on the clock, so no hook waits for it. */
function startScan($: EngineInterface) {
  $.clock.after(1, () => {
    void runScan($)
  })
}

async function setRange($: EngineInterface, range: Range) {
  await update($, rangeRef, () => range)
  await $.store.set('range', range).catch(() => undefined)
}

const OPEN = { id: PANE, title: 'burn-rate', focus: true, closeOnEscape: true, rows: 40, columns: 110 } as const

export const register: Register = (on, options) => {
  const opts = (options ?? {}) as Options
  const defaultRange: Range = isRange(opts.defaultRange) ? opts.defaultRange : '7d'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'burn',
      description: 'burn-rate: cost dashboard from your local Claude Code transcripts (est. at list price)',
      argumentHint: '[today | 7d | 30d | month | 6m | lifetime]',
      immediate: true,
    })
    const saved = await $.store.get('range')
    if (isRange(saved)) await update($, rangeRef, () => saved)
    // Someone who has used the dashboard gets a fresh total in the status line shortly after start.
    const summary = (await $.store.get('summary')) as Summary | undefined
    if (summary !== undefined) $.clock.after(5_000, () => void runScan($))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'burn' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (isRange(arg)) await setRange($, arg)
    await $.ui.open(OPEN).catch(() => undefined)
    startScan($)
    const views = await read($, viewsRef)
    const range = (await read($, rangeRef)) ?? defaultRange
    const v = views?.[range]
    return {
      text:
        v === undefined
          ? 'burn-rate: scanning your transcripts…'
          : `burn-rate (${RANGE_LABEL[range]}): ${fmtCost(v.cost)} · ${v.calls} calls · ${v.sessions} sessions (est. at list price; refreshing)`,
    }
  })

  // Cheap: the last scan's total for today plus what each finished turn cost since.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const u = e.usage
    if (u !== undefined) {
      const cost = costOf(u.model, {
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens,
        cacheWrite5m: u.cache_creation_input_tokens,
        cacheWrite1h: 0,
      })
      await update($, sinceRef, n => (n ?? 0) + cost)
    }
    const since = await read($, sinceRef)
    const summary = (await $.store.get('summary')) as Summary | undefined
    const today = summary === undefined ? '' : dayKey(await $.clock.now(), summary.tz)
    $.ui.status(
      summary !== undefined && summary.day === today ? statusLine(summary.cost + since) : `🔥 ${fmtCost(since)} this session`,
    )
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const range = (await read($, rangeRef)) ?? defaultRange
    const views = await read($, viewsRef)
    const status = await read($, statusRef)
    const cols = Math.max(20, e.props.bodyColumns)
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 30
    const view = views?.[range]
    const inner = Math.max(10, cols - 4)

    const line = (l: Line) => (
      <Box>
        {l.map(s => (
          <Text color={s.color} bold={s.bold} dimColor={s.dim} wrap="truncate">
            {s.text}
          </Text>
        ))}
      </Box>
    )

    const progress = status.isScanning
      ? `scanning… ${status.total > 0 ? `${status.done}/${status.total} files` : ''}`
      : status.error !== undefined
        ? `scan failed: ${status.error}`
        : status.skipped > 0
          ? `${status.skipped} file(s) could not be read`
          : ''

    const top = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} width={cols}>
        {RANGES.map(r => (
          <Button
            key={`range-${r}`}
            label={RANGE_LABEL[r]}
            hotkey={RANGE_HOTKEY[r]}
            variant={r === range ? 'primary' : 'secondary'}
            onPress={() => setRange($, r)}
          />
        ))}
        <Button key="refresh" label="r refresh" hotkey="r" dimColor onPress={() => startScan($)} />
      </Box>
    )

    if (view === undefined) {
      const msg = status.isScanning
        ? 'scanning… reading ~/.claude/projects'
        : status.finishedAt > 0
          ? 'No transcripts found under ~/.claude/projects (or $CLAUDE_CONFIG_DIR/projects).'
          : 'No data yet: press r to scan.'
      return (
        <Box flexDirection="column" width={cols}>
          {top}
          <Box borderStyle="round" borderColor={COLORS.header} paddingX={1} flexDirection="column" width={cols}>
            <Text bold color={COLORS.header}>
              burn-rate
            </Text>
            <Text dimColor wrap="truncate">
              {msg}
            </Text>
            {progress !== '' && !status.isScanning && <Text dimColor>{progress}</Text>}
          </Box>
        </Box>
      )
    }

    const grid = layout(view, cols, bodyRows)
    return (
      <Box flexDirection="column" width={cols}>
        {top}
        <Box borderStyle="round" borderColor={COLORS.header} paddingX={1} flexDirection="column" width={cols}>
          {headerLines(view, RANGE_LABEL[range], inner).map(line)}
          {view.calls === 0 && <Text dimColor>No usage in this range.</Text>}
          {progress !== '' && (
            <Text dimColor wrap="truncate">
              {progress}
            </Text>
          )}
        </Box>
        {grid.rows.map(panels => (
          <Box flexDirection="row" columnGap={1} width={cols}>
            {panels.map(p => (
              <Box borderStyle="round" borderColor={p.color} paddingX={1} flexDirection="column" width={p.width}>
                <Text bold color={p.color}>
                  {p.title}
                </Text>
                {p.lines.map(line)}
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
