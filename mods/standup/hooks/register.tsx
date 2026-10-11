import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Result, RunStatus } from '../types'
import { SYSTEM, digestText, fallbackSummary, parseSummary, renderMarkdown } from './digest'
import type { Entry, Summary } from './digest'
import { dayKey, dayStart, parseSession } from './transcripts'
import type { SessionDigest } from './transcripts'

const PANE = 'standup'
const FS_READ_MAX = 4_000_000
/** Files over the read limit are read from their last ~3.5 MB, which holds the recent days. */
const TAIL_BYTES = 3_500_000
const BATCH = 4
const DEFAULT_MODEL = 'claude-haiku-5-5'
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type Effort = (typeof EFFORTS)[number]
// Higher effort spends output tokens thinking before the JSON, so the cap grows with it.
const MAX_TOKENS: Record<Effort, number> = { low: 400, medium: 2000, high: 6000, xhigh: 12000, max: 24000 }

const IDLE: RunStatus = { isRunning: false, done: 0, total: 0 }
const resultRef = atom({ plugin: 'standup', key: 'result' } as const, null as Result | null)
const statusRef = atom({ plugin: 'standup', key: 'status' } as const, IDLE)
const pickRef = atom({ plugin: 'standup', key: 'pick' } as const, 'today')

type Options = { model?: string; effort?: string; folder?: string; maxSessions?: number }
type Cfg = { model: string; effort: Effort; maxTokens: number; folder: string; maxSessions: number }
type Found = { path: string; size: number; mtime: number }

let isBusy = false

function config(options: unknown): Cfg {
  const o = (options ?? {}) as Options
  const n = Number(o.maxSessions)
  return {
    model: o.model?.trim() || DEFAULT_MODEL,
    effort: EFFORTS.includes(o.effort as Effort) ? (o.effort as Effort) : 'low',
    maxTokens: MAX_TOKENS[EFFORTS.includes(o.effort as Effort) ? (o.effort as Effort) : 'low'],
    folder: (o.folder ?? '').trim(),
    maxSessions: Number.isFinite(n) && n > 0 ? Math.floor(n) : 40,
  }
}

async function tzOffset($: EngineInterface): Promise<number> {
  try {
    const r = await $.process.run(['date', '+%z'], { timeoutMs: 3000 })
    const m = /^([+-])(\d{2})(\d{2})/.exec(r.stdout.trim())
    if (m) return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
  } catch {
    // No process available: use the environment's own offset.
  }
  return -new Date().getTimezoneOffset()
}

async function home($: EngineInterface): Promise<string> {
  const h = (await $.env.get('HOME').catch(() => undefined)) ?? (await $.env.get('USERPROFILE').catch(() => undefined)) ?? ''
  return h.replace(/[\\/]+$/, '')
}

async function configRoots($: EngineInterface): Promise<string[]> {
  const roots: string[] = []
  const configured = await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)
  if (configured) for (const p of configured.split(',')) if (p.trim() !== '') roots.push(p.trim())
  const h = await home($)
  if (h !== '') roots.push(`${h}/.claude`)
  return [...new Set(roots.map(r => r.replace(/[\\/]+$/, '')))]
}

async function walk($: EngineInterface, dir: string, depth: number, out: Found[]) {
  const entries = await $.fs.list(dir).catch(() => [])
  for (const en of entries) {
    const path = `${dir}/${en.name}`
    if (en.kind === 'file' && en.name.endsWith('.jsonl')) out.push({ path, size: en.size, mtime: en.mtimeMs })
    // Subagent transcripts are part of their parent session's work, so they are not listed on their own.
    else if (en.kind === 'dir' && depth > 0 && en.name !== 'subagents' && en.name !== 'tool-results') await walk($, path, depth - 1, out)
  }
}

async function readTranscript($: EngineInterface, f: Found): Promise<string> {
  if (f.size <= FS_READ_MAX) return $.fs.read(f.path)
  const r = await $.process.run(['sh', '-c', 'tail -c "$1" "$2"', 'standup', String(TAIL_BYTES), f.path], { timeoutMs: 30_000 })
  return r.stdout
}

/** Resolves `today`, `yesterday` or YYYY-MM-DD to a local day. Null for anything else. */
function resolveDay(pick: string, now: number, tz: number): string | null {
  if (pick === 'today' || pick === '') return dayKey(now, tz)
  if (pick === 'yesterday') return dayKey(now - 86_400_000, tz)
  return /^\d{4}-\d{2}-\d{2}$/.test(pick) ? pick : null
}

async function summarize($: EngineInterface, d: SessionDigest, day: string, tz: number, cfg: Cfg): Promise<Entry> {
  const key = `s:${d.sid}:${day}:${d.last}`
  const cached = (await $.store.get(key).catch(() => undefined)) as Summary | undefined
  if (cached !== undefined) return { d, s: cached, isModel: true }
  const r = await $.model
    .complete({ model: cfg.model, system: SYSTEM, prompt: digestText(d, tz), effort: cfg.effort, maxTokens: cfg.maxTokens, timeoutMs: cfg.effort === 'low' ? 25_000 : 120_000 })
    .catch(() => null)
  const s = r?.isAnswered ? parseSummary(r.text) : null
  if (s === null) return { d, s: fallbackSummary(d), isModel: false }
  await $.store.set(key, s).catch(() => undefined)
  return { d, s, isModel: true }
}

async function save($: EngineInterface, cfg: Cfg, day: string, markdown: string): Promise<string> {
  if (cfg.folder.toLowerCase() === 'off') return ''
  const dir = cfg.folder !== '' ? cfg.folder.replace(/[\\/]+$/, '') : `${await home($)}/standups`
  if (dir === '/standups') return '' // no home folder to put it in
  const path = `${dir}/${day}.md`
  try {
    await $.fs.write(path, markdown)
    return path
  } catch {
    return ''
  }
}

async function generate($: EngineInterface, cfg: Cfg) {
  if (isBusy) return
  isBusy = true
  try {
    await update($, statusRef, () => ({ isRunning: true, done: 0, total: 0 }))
    const tz = await tzOffset($)
    const day = resolveDay(await read($, pickRef), await $.clock.now(), tz)
    if (day === null) throw new Error('pick today, yesterday or a YYYY-MM-DD date')
    const since = dayStart(day, tz)

    const found: Found[] = []
    for (const root of await configRoots($)) await walk($, `${root}/projects`, 2, found)
    const recent = [...new Map(found.filter(f => f.mtime >= since).map(f => [f.path, f])).values()].sort((a, b) => b.mtime - a.mtime)

    const digests: SessionDigest[] = []
    for (const f of recent) {
      try {
        const d = parseSession(await readTranscript($, f), day, tz)
        if (d !== null && d.sid !== '') digests.push(d)
      } catch {
        // An unreadable file is skipped; the rest still make the standup.
      }
    }
    // A session resumed from another file shows up twice; keep the busier one.
    const bySid = new Map<string, SessionDigest>()
    for (const d of digests) {
      const prev = bySid.get(d.sid)
      if (prev === undefined || d.prompts.length > prev.prompts.length) bySid.set(d.sid, d)
    }
    const picked = [...bySid.values()].sort((a, b) => b.last - a.last).slice(0, cfg.maxSessions)
    await update($, statusRef, () => ({ isRunning: true, done: 0, total: picked.length }))

    const entries: Entry[] = []
    for (let i = 0; i < picked.length; i += BATCH) {
      entries.push(...(await Promise.all(picked.slice(i, i + BATCH).map(d => summarize($, d, day, tz, cfg)))))
      await update($, statusRef, () => ({ isRunning: true, done: Math.min(i + BATCH, picked.length), total: picked.length }))
    }

    const markdown = renderMarkdown(day, entries)
    const path = await save($, cfg, day, markdown)
    const result: Result = {
      day,
      markdown,
      projects: new Set(entries.map(e => e.d.project)).size,
      sessions: entries.length,
      summarized: entries.filter(e => e.isModel).length,
      fallback: entries.filter(e => !e.isModel).length,
      path,
    }
    await update($, resultRef, () => result)
    await $.store.set('last', result).catch(() => undefined)
    await update($, statusRef, () => IDLE)
    $.ui.toast(`standup: ${result.sessions} session${result.sessions === 1 ? '' : 's'}, ${result.projects} project${result.projects === 1 ? '' : 's'}${path !== '' ? `, saved to ${path}` : ''}`)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await update($, statusRef, () => ({ isRunning: false, done: 0, total: 0, error })).catch(() => undefined)
  } finally {
    isBusy = false
  }
}

/** Starts a run on the clock, so no hook waits for it. */
function start($: EngineInterface, cfg: Cfg) {
  $.clock.after(1, () => {
    void generate($, cfg)
  })
}

async function choose($: EngineInterface, pick: string) {
  await update($, pickRef, () => pick)
}

const OPEN = { id: PANE, title: 'Standup', focus: true, closeOnEscape: true, rows: 40, columns: 100 } as const

export const register: Register = (on, options) => {
  const cfg = config(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'standup',
      description: 'Standup: write up what you got done, from your local sessions',
      argumentHint: '[today | yesterday | YYYY-MM-DD]',
      immediate: true,
    })
    const last = (await $.store.get('last').catch(() => undefined)) as Result | undefined
    if (last !== undefined) await update($, resultRef, () => last)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'standup' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    await $.ui.open(OPEN).catch(() => undefined)
    if (arg !== '') {
      await choose($, arg)
      start($, cfg)
      return { text: `Standup for ${arg}: generating…` }
    }
    const r = await read($, resultRef)
    return { text: r === null ? 'Standup: press Generate in the pane.' : `Standup (${r.day}): ${r.sessions} sessions, ${r.projects} projects${r.path !== '' ? `, saved to ${r.path}` : ''}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const result = await read($, resultRef)
    const status = await read($, statusRef)
    const pick = await read($, pickRef)
    const cols = Math.max(20, e.props.bodyColumns)

    const note = status.isRunning
      ? `working… ${status.total > 0 ? `${status.done}/${status.total} sessions` : 'reading transcripts'}`
      : status.error !== undefined
        ? `failed: ${status.error}`
        : result !== null
          ? `${result.day} · ${result.sessions} sessions · ${result.projects} projects${result.fallback > 0 ? ` · ${result.fallback} without a model summary` : ''}${result.path !== '' ? ` · saved to ${result.path}` : ''}`
          : 'Pick a day, then Generate.'

    return (
      <Box flexDirection="column" width={cols}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} width={cols}>
          <Button key="gen" label="Generate" hotkey="g" variant="primary" onPress={() => start($, cfg)} />
          <Button key="today" label="Today" hotkey="t" variant={pick === 'today' ? 'primary' : 'secondary'} onPress={() => choose($, 'today')} />
          <Button key="yday" label="Yesterday" hotkey="y" variant={pick === 'yesterday' ? 'primary' : 'secondary'} onPress={() => choose($, 'yesterday')} />
        </Box>
        <Text dimColor wrap="wrap">
          {note}
        </Text>
        <Box marginTop={1} flexDirection="column" width={cols}>
          {result !== null && <Markdown text={result.markdown} />}
        </Box>
      </Box>
    )
  })
}
