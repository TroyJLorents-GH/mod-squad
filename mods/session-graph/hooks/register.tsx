import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Link, Pending, SessionRecord } from '../types'
import { SYSTEM, THRESHOLD, asRecord, clip, contextFor, extractPrompt, findLinks, mergeTopics, parseExtract } from './graph'
import type { Sensitivity } from './graph'

const PANE = 'session-graph'
const DEFAULT_MODEL = 'claude-haiku-5-5'
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type Effort = (typeof EFFORTS)[number]
// Higher effort spends output tokens thinking before the JSON, so the cap grows with it.
const MAX_TOKENS: Record<Effort, number> = { low: 350, medium: 2000, high: 6000, xhigh: 12000, max: 24000 }
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** The model is asked at most this often per session; between asks the graph is only re-read. */
const MIN_GAP_MS = 90_000
/** How often an idle session looks at the other sessions' files. */
const POLL_MS = 60_000
const MAX_OTHERS = 60

const enabledRef = atom({ plugin: 'session-graph', key: 'enabled' } as const, true)
const selfRef = atom({ plugin: 'session-graph', key: 'self' } as const, null as { title: string; summary: string; topics: string[]; files: string[] } | null)
const linksRef = atom({ plugin: 'session-graph', key: 'links' } as const, [] as Link[])
const trackedRef = atom({ plugin: 'session-graph', key: 'tracked' } as const, 0)
const pendingRef = atom({ plugin: 'session-graph', key: 'pending' } as const, null as Pending | null)

type Options = { model?: string; effort?: string; sensitivity?: string; windowDays?: number; folder?: string }
type Cfg = { model: string; effort: Effort; maxTokens: number; threshold: number; windowMs: number; folder: string; me: ReturnType<typeof newState> }

/** This session, as its engine's copy of the mod sees it. Nothing here outlives the session but the record on disk. */
function newState() {
  return {
    rec: null as SessionRecord | null,
    files: new Set<string>(),
    firstPrompt: '',
    lastPrompt: '',
    lastAsk: 0,
    filesAtAsk: 0,
    isLoaded: false,
    isPolling: false,
    isBusy: false,
  }
}

function config(options: unknown): Cfg {
  const o = (options ?? {}) as Options
  const days = Number(o.windowDays)
  const sens = (['strict', 'normal', 'loose'] as const).includes(o.sensitivity as Sensitivity) ? (o.sensitivity as Sensitivity) : 'normal'
  return {
    model: o.model?.trim() || DEFAULT_MODEL,
    effort: EFFORTS.includes(o.effort as Effort) ? (o.effort as Effort) : 'low',
    maxTokens: MAX_TOKENS[EFFORTS.includes(o.effort as Effort) ? (o.effort as Effort) : 'low'],
    threshold: THRESHOLD[sens],
    windowMs: (Number.isFinite(days) && days > 0 ? days : 7) * 86_400_000,
    folder: (o.folder ?? '').trim(),
    me: newState(),
  }
}

async function dir($: EngineInterface, cfg: Cfg): Promise<string> {
  if (cfg.folder !== '') return cfg.folder.replace(/[\\/]+$/, '')
  const h = (await $.env.get('HOME').catch(() => undefined)) ?? (await $.env.get('USERPROFILE').catch(() => undefined)) ?? ''
  return `${h.replace(/[\\/]+$/, '')}/.claude/session-graph`
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

/** This session's record: from memory, else from disk (a resumed session), else a new one. */
async function own($: EngineInterface, cfg: Cfg): Promise<SessionRecord> {
  if (cfg.me.rec !== null) return cfg.me.rec
  const sid = await $.session.id()
  const cwd = await $.session.cwd().catch(() => '')
  const project = cwd.split(/[\\/]+/).filter(Boolean).pop() ?? ''
  let rec: SessionRecord = { sid, project, cwd, title: cfg.me.firstPrompt, summary: '', notes: [], topics: [], files: [], updatedAt: 0, alerted: [] }
  if (!cfg.me.isLoaded) {
    cfg.me.isLoaded = true
    const raw = await $.fs.read(`${await dir($, cfg)}/${sid}.json`).catch(() => undefined)
    const prior = raw === undefined ? null : asRecord(safeParse(raw))
    if (prior !== null) {
      rec = { ...prior, project: project || prior.project, cwd: cwd || prior.cwd }
      for (const f of prior.files) cfg.me.files.add(f)
    }
  }
  cfg.me.rec = rec
  return rec
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function persist($: EngineInterface, cfg: Cfg) {
  if (cfg.me.rec === null) return
  await $.fs.write(`${await dir($, cfg)}/${cfg.me.rec.sid}.json`, JSON.stringify(cfg.me.rec)).catch(() => undefined)
}

async function readOthers($: EngineInterface, cfg: Cfg, sid: string): Promise<SessionRecord[]> {
  const d = await dir($, cfg)
  const now = await $.clock.now()
  const entries = await $.fs.list(d).catch(() => [])
  const recent = entries
    .filter(en => en.kind === 'file' && en.name.endsWith('.json') && en.name !== `${sid}.json` && now - en.mtimeMs <= cfg.windowMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_OTHERS)
  const recs = await Promise.all(
    recent.map(async en => {
      const raw = await $.fs.read(`${d}/${en.name}`).catch(() => undefined)
      return raw === undefined ? null : asRecord(safeParse(raw))
    }),
  )
  return recs.filter((r): r is SessionRecord => r !== null && r.off !== true)
}

/** Re-reads the other sessions, updates what the pane shows, and says so once for each new connection. */
async function refresh($: EngineInterface, cfg: Cfg) {
  if (!(await read($, enabledRef))) return
  const rec = await own($, cfg)
  const others = await readOthers($, cfg, rec.sid)
  const links = findLinks(rec, others, cfg.threshold)
  await update($, linksRef, () => links)
  await update($, trackedRef, () => others.length)

  const fresh = links.filter(l => !rec.alerted.includes(l.sid))
  if (fresh.length === 0) return
  rec.alerted = [...rec.alerted, ...fresh.map(l => l.sid)]
  await persist($, cfg)
  const top = fresh[0]
  if (top === undefined) return
  const what = top.topics.length > 0 ? top.topics.slice(0, 3).join(', ') : top.files.slice(0, 2).join(', ')
  const more = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''
  $.ui.toast(`session-graph: "${clip(top.summary || top.title || 'another session', 50)}" in ${top.project || 'another project'} also covers ${what}${more}. /graph to see it`, { timeoutMs: 15_000 })
}

/** After a turn: ask the model for topics (at most every MIN_GAP_MS), write the record, re-read the graph. */
async function onTurn($: EngineInterface, cfg: Cfg, answer: string) {
  if (cfg.me.isBusy || !(await read($, enabledRef))) return
  cfg.me.isBusy = true
  try {
    const rec = await own($, cfg)
    const now = await $.clock.now()
    const newFiles = cfg.me.files.size - cfg.me.filesAtAsk
    const isDue = rec.topics.length === 0 || now - cfg.me.lastAsk >= MIN_GAP_MS
    const isWorthIt = answer.length >= 150 || newFiles > 0
    if (isDue && isWorthIt) {
      cfg.me.lastAsk = now
      cfg.me.filesAtAsk = cfg.me.files.size
      const r = await $.model
        .complete({
          model: cfg.model,
          system: SYSTEM,
          prompt: extractPrompt(rec, cfg.me.lastPrompt, answer, [...cfg.me.files]),
          effort: cfg.effort,
          maxTokens: cfg.maxTokens,
          timeoutMs: cfg.effort === 'low' ? 20_000 : 120_000,
        })
        .catch(() => null)
      const x = r?.isAnswered ? parseExtract(r.text) : null
      if (x !== null) {
        rec.summary = x.summary || rec.summary
        rec.topics = mergeTopics(x.topics, rec.topics)
        rec.notes = x.notes.length > 0 ? x.notes : rec.notes
      }
      rec.title = rec.title || clip(cfg.me.firstPrompt, 80)
      rec.files = [...cfg.me.files].slice(-50)
      rec.updatedAt = now
      await persist($, cfg)
      await update($, selfRef, () => ({ title: rec.title, summary: rec.summary, topics: rec.topics, files: rec.files }))
    }
    await refresh($, cfg)
  } finally {
    cfg.me.isBusy = false
  }
}

/** An idle session still notices a new connection: look again every POLL_MS. */
function poll($: EngineInterface, cfg: Cfg) {
  if (cfg.me.isPolling) return
  cfg.me.isPolling = true
  tick($, cfg)
}

function tick($: EngineInterface, cfg: Cfg) {
  $.clock.after(POLL_MS, () => {
    void refresh($, cfg)
      .catch(() => undefined)
      .then(() => tick($, cfg))
  })
}

async function pull($: EngineInterface, link: Link) {
  const tz = await tzOffset($)
  await update($, pendingRef, () => ({ sid: link.sid, label: link.summary || link.title || link.project, text: contextFor(link, tz) }))
  $.ui.toast('session-graph: that session\'s findings will ride along with your next prompt')
}

async function drop($: EngineInterface) {
  await update($, pendingRef, () => null)
}

async function setEnabled($: EngineInterface, cfg: Cfg, on: boolean) {
  await update($, enabledRef, () => on)
  await $.store.set('enabled', on).catch(() => undefined)
  const rec = await own($, cfg)
  // Others skip a session that turned itself off; turning it on again writes the full record back.
  if (!on) await $.fs.write(`${await dir($, cfg)}/${rec.sid}.json`, JSON.stringify({ ...rec, off: true })).catch(() => undefined)
  else await persist($, cfg)
}

const OPEN = { id: PANE, title: 'Session graph', focus: true, closeOnEscape: true, rows: 30, columns: 90 } as const

const ago = (ms: number, now: number) => {
  const m = Math.max(0, Math.round((now - ms) / 60_000))
  return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}

export const register: Register = (on, options) => {
  const cfg = config(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'graph',
      description: 'Session graph: sessions that overlap this one. /graph pull <n> brings one in; on | off',
      argumentHint: '[pull <n> | on | off]',
      immediate: true,
    })
    const saved = await $.store.get('enabled').catch(() => undefined)
    if (saved === false) await update($, enabledRef, () => false)
    // A session with a surface (terminal or desktop) is a person's session; -p and SDK runs have none.
    if (e.isInteractive || e.surface !== null) {
      poll($, cfg)
      $.clock.after(3_000, () => void refresh($, cfg).catch(() => undefined))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    // A session that missed the start signal still begins polling at its first prompt.
    poll($, cfg)
    const text = e.text.trim()
    if (text !== '' && !text.startsWith('/')) {
      if (cfg.me.firstPrompt === '') cfg.me.firstPrompt = clip(text.replace(/\s+/g, ' '), 200)
      cfg.me.lastPrompt = text
    }
    const pending = await read($, pendingRef)
    if (pending === null || text.startsWith('/')) return next(e)
    await drop($)
    return next({ ...e, context: [...(e.context ?? []), pending.text] })
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (EDIT_TOOLS.has(String(e.tool)) && 'file_path' in e && typeof e.file_path === 'string') cfg.me.files.add(e.file_path)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.reason === 'answer') {
      // Off the turn's clock: nothing here may delay the answer.
      $.clock.after(1, () => void onTurn($, cfg, e.answer).catch(() => undefined))
    }
    return done
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'graph' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (verb === 'on' || verb === 'off') {
      await setEnabled($, cfg, verb === 'on')
      return { text: verb === 'on' ? 'Session graph: on.' : 'Session graph: off. Other sessions will skip this one.' }
    }
    if (verb === 'pull') {
      const links = await read($, linksRef)
      const l = links[Number(arg) - 1]
      if (l === undefined) return { text: `Usage: /graph pull <1-${Math.max(1, links.length)}>` }
      await pull($, l)
      return { text: `Session graph: "${l.summary || l.title}" will ride along with your next prompt.` }
    }
    await $.ui.open(OPEN).catch(() => undefined)
    await refresh($, cfg).catch(() => undefined)
    const links = await read($, linksRef)
    const tracked = await read($, trackedRef)
    return {
      text:
        links.length === 0
          ? `Session graph: no overlapping sessions yet (${tracked} other session${tracked === 1 ? '' : 's'} tracked).`
          : `Session graph: ${links.length} overlapping session${links.length === 1 ? '' : 's'}:\n${links.map((l, i) => `${i + 1}. ${l.project}: ${l.summary || l.title} [${l.topics.join(', ') || l.files.join(', ')}]`).join('\n')}`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const enabled = await read($, enabledRef)
    const self = await read($, selfRef)
    const links = await read($, linksRef)
    const tracked = await read($, trackedRef)
    const pending = await read($, pendingRef)
    const now = await $.clock.now()
    const cols = Math.max(20, e.props.bodyColumns)

    // Group by this session's topics: each shared topic lists the sessions that cover it.
    const byTopic = new Map<string, Link[]>()
    for (const l of links) for (const t of l.topics) byTopic.set(t, [...(byTopic.get(t) ?? []), l])

    return (
      <Box flexDirection="column" width={cols}>
        <Box borderStyle="round" borderColor="#06b6d4" paddingX={1} flexDirection="column" width={cols}>
          <Text bold color="#06b6d4">
            This session
          </Text>
          {!enabled ? (
            <Text dimColor>off: other sessions skip this one</Text>
          ) : self === null ? (
            <Text dimColor wrap="wrap">
              Nothing recorded yet. Topics are named after your first long answer or edit.
            </Text>
          ) : (
            <>
              <Text wrap="wrap">{self.summary || self.title}</Text>
              <Text dimColor wrap="wrap">
                {self.topics.length > 0 ? self.topics.join(' · ') : 'no topics yet'}
              </Text>
            </>
          )}
        </Box>

        <Box borderStyle="round" borderColor="#a855f7" paddingX={1} flexDirection="column" width={cols}>
          <Text bold color="#a855f7">
            {`Connections (${links.length}) · ${tracked} other session${tracked === 1 ? '' : 's'} tracked`}
          </Text>
          {links.length === 0 && (
            <Text dimColor wrap="wrap">
              No other session overlaps yet. You will get an alert when one does.
            </Text>
          )}
          {links.map((l, i) => (
            <Box flexDirection="column" marginTop={i === 0 ? 0 : 1}>
              <Text bold wrap="truncate">
                {`${i + 1}. ${l.project || 'unknown'} · ${ago(l.updatedAt, now)}`}
              </Text>
              <Text wrap="wrap">{l.summary || l.title}</Text>
              <Text dimColor wrap="wrap">
                {`shares: ${[...l.topics, ...l.files.map(f => f.split(/[\\/]/).pop() ?? f)].join(', ')}`}
              </Text>
              <Box>
                <Button key={`pull-${i + 1}`} label="Pull in" hotkey={i < 9 ? String(i + 1) : undefined} variant="secondary" onPress={() => pull($, l)} />
              </Box>
            </Box>
          ))}
        </Box>

        {byTopic.size > 0 && (
          <Box borderStyle="round" borderColor="#22c55e" paddingX={1} flexDirection="column" width={cols}>
            <Text bold color="#22c55e">
              Graph
            </Text>
            {[...byTopic].map(([topic, ls]) => (
              <Box flexDirection="column">
                <Text bold>{`● ${topic}`}</Text>
                <Text dimColor>{'  ├─ this session'}</Text>
                {ls.map((l, i) => (
                  <Text dimColor wrap="truncate">{`  ${i === ls.length - 1 ? '└' : '├'}─ ${l.project || 'unknown'}: ${l.summary || l.title}`}</Text>
                ))}
              </Box>
            ))}
          </Box>
        )}

        {pending !== null && (
          <Box paddingX={1} columnGap={1} width={cols}>
            <Text color="#f59e0b" wrap="truncate">{`Attached to your next prompt: ${pending.label}`}</Text>
            <Button key="drop" label="Cancel" variant="secondary" onPress={() => drop($)} />
          </Box>
        )}
      </Box>
    )
  })
}
