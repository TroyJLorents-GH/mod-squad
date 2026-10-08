// Turns transcript JSONL lines into a small per-file aggregate that can be stored and extended.

import { EDIT_TOOLS, classify, freshSignals, isDocFile, isTestRun } from './classify'
import type { Category, TurnSignals } from './classify'
import { costOf } from './pricing'
import type { Usage } from './pricing'

/** Per model: [calls, input, output, cacheRead, cacheWrite5m, cacheWrite1h, costUsd]. */
export type ModelRow = [number, number, number, number, number, number, number]

/** One local day of one transcript file. */
export type DayAgg = {
  /** Project (last folder of `cwd`) last seen that day. */
  p?: string
  m: Record<string, ModelRow>
  /** Activity: [costUsd, turns] per category, for turns closed so far. */
  a: Partial<Record<Category, [number, number]>>
  /** Built-in tool calls by name. */
  t: Record<string, number>
  /** Shell commands by first word. */
  s: Record<string, number>
  /** MCP tool calls by server. */
  x: Record<string, number>
}

/** The turn still open at the end of what has been parsed. */
export type OpenTurn = { day: string; s: TurnSignals; c: number; n: number }

/** A response already counted: [id, model, day, input, output, cacheRead, cw5m, cw1h]. */
export type Seen = [string, string, string, number, number, number, number, number]

export type FileState = {
  v: 2
  /** Size and mtime when last parsed. */
  size: number
  mtime: number
  /** Bytes consumed (complete lines only). */
  off: number
  sid?: string
  proj?: string
  days: Record<string, DayAgg>
  /** The last few responses counted, so a streamed duplicate across a read boundary is still caught. */
  seen: Seen[]
  /** The last few tool_use ids counted. */
  tu: string[]
  turn: OpenTurn | null
}

const RECENT = 12

export function emptyFile(): FileState {
  return { v: 2, size: 0, mtime: 0, off: 0, days: {}, seen: [], tu: [], turn: null }
}

/** YYYY-MM-DD of `ms` shifted by `tzOffsetMin` (minutes east of UTC). */
export function dayKey(ms: number, tzOffsetMin: number): string {
  return new Date(ms + tzOffsetMin * 60_000).toISOString().slice(0, 10)
}

/** `/home/me/src/app` → `app`; `C:\\work\\api\\` → `api`. */
export function shortProject(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

const PREFIX_WORDS = new Set(['sudo', 'env', 'time', 'nohup', 'exec', 'command', 'builtin', 'nice'])

/**
 * The program a shell command runs: its first word, past `sudo`, `env X=y`,
 * `X=y` assignments, and leading `cd dir &&` / `cd dir;` / `X=y;` steps. Null when none.
 */
export function shellCommand(command: string): string | null {
  let s = command.trim()
  for (let guard = 0; guard < 8; guard++) {
    s = s.replace(/^[({]\s*/, '')
    // `cd dir &&`, `cd dir;`, and a bare `X=y;` / `export X=y &&` step before the real command.
    const step =
      /^(cd|pushd)\s+("[^"]*"|'[^']*'|[^\s;&|]+)(\s+\d?>>?\s*\S+)*\s*(&&|\|\||;|\n)\s*/.exec(s) ??
      /^(export\s+)?[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s;&|]*)\s*(&&|;|\n)\s*/.exec(s)
    if (step === null) break
    s = s.slice(step[0].length)
  }
  const words = s.split(/\s+/).filter(Boolean)
  let i = 0
  while (i < words.length) {
    const w = words[i] ?? ''
    if (PREFIX_WORDS.has(w)) i++
    else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++
    else if (w.startsWith('-') && i > 0 && PREFIX_WORDS.has(words[i - 1] ?? '')) i++
    else break
  }
  const first = (words[i] ?? '').replace(/^["']|["';|&)]+$/g, '')
  if (first === '' || /^[;&|]/.test(first)) return null
  const base = first.split(/[\\/]/).pop() ?? first
  return base === '' ? null : base
}

/** `mcp__github__create_issue` → `github`; anything else → null. */
export function mcpServer(tool: string): string | null {
  if (!tool.startsWith('mcp__')) return null
  const server = tool.slice(5).split('__')[0]
  return server ? server : null
}

function day(state: FileState, key: string): DayAgg {
  let d = state.days[key]
  if (d === undefined) {
    d = { m: {}, a: {}, t: {}, s: {}, x: {} }
    state.days[key] = d
  }
  return d
}

function bump(map: Record<string, number>, key: string, by = 1) {
  map[key] = (map[key] ?? 0) + by
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/** The usage of an assistant line, cache writes split 5m/1h (all 5m when the split is absent). */
export function usageOf(raw: unknown): Usage {
  const u = (raw ?? {}) as Record<string, unknown>
  const written = num(u.cache_creation_input_tokens)
  const split = (u.cache_creation ?? null) as Record<string, unknown> | null
  let w5 = written
  let w1 = 0
  if (split !== null && typeof split === 'object') {
    const a = num(split.ephemeral_5m_input_tokens)
    const b = num(split.ephemeral_1h_input_tokens)
    if (a + b > 0) {
      w1 = b
      w5 = Math.max(0, written - b)
    }
  }
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite5m: w5,
    cacheWrite1h: w1,
  }
}

function closeTurn(state: FileState) {
  const t = state.turn
  state.turn = null
  if (t === null || t.n === 0) return
  const cat = classify(t.s)
  const d = day(state, t.day)
  const row = d.a[cat] ?? [0, 0]
  d.a[cat] = [row[0] + t.c, row[1] + 1]
}

/** The text a person typed, or null for a row that is no prompt (tool results, meta, command records). */
function promptText(obj: Record<string, unknown>): string | null {
  if (obj.isMeta === true) return null
  const msg = obj.message as { content?: unknown } | undefined
  const c = msg?.content
  let text = ''
  if (typeof c === 'string') text = c
  else if (Array.isArray(c)) {
    const texts = c.filter(b => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text')
    if (texts.length === 0) return null
    text = texts.map(b => String((b as { text?: unknown }).text ?? '')).join('\n')
  } else return null
  text = text.trim()
  // Slash-command records, local command output and harness notices are not prompts.
  if (text === '' || text.startsWith('<')) return null
  return text
}

function addUsage(state: FileState, dayKeyStr: string, model: string, u: Usage, calls: number, cost: number) {
  const d = day(state, dayKeyStr)
  const row = d.m[model] ?? [0, 0, 0, 0, 0, 0, 0]
  row[0] += calls
  row[1] += u.input
  row[2] += u.output
  row[3] += u.cacheRead
  row[4] += u.cacheWrite5m
  row[5] += u.cacheWrite1h
  row[6] += cost
  d.m[model] = row
}

function ensureTurn(state: FileState, dk: string): OpenTurn {
  if (state.turn === null) state.turn = { day: dk, s: freshSignals(''), c: 0, n: 0 }
  return state.turn
}

function onAssistant(state: FileState, obj: Record<string, unknown>, tz: number) {
  if (obj.isApiErrorMessage === true) return
  const msg = (obj.message ?? {}) as Record<string, unknown>
  const model = typeof msg.model === 'string' ? msg.model : ''
  if (model === '' || model === '<synthetic>') return
  const ts = Date.parse(String(obj.timestamp ?? ''))
  const dk = Number.isFinite(ts) ? dayKey(ts, tz) : (state.turn?.day ?? '1970-01-01')
  const u = usageOf(msg.usage)
  const total = u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h
  if (total === 0) return

  const id = String(msg.id ?? obj.requestId ?? obj.uuid ?? '')
  const turn = ensureTurn(state, dk)
  const prior = id === '' ? undefined : state.seen.find(s => s[0] === id)
  if (prior === undefined) {
    const cost = costOf(model, u)
    addUsage(state, dk, model, u, 1, cost)
    turn.c += cost
    turn.n += 1
    if (id !== '') {
      state.seen.push([id, model, dk, u.input, u.output, u.cacheRead, u.cacheWrite5m, u.cacheWrite1h])
      if (state.seen.length > RECENT) state.seen.splice(0, state.seen.length - RECENT)
    }
  } else {
    // Same response streamed again: count only what grew (the last line carries the final output count).
    const old: Usage = { input: prior[3], output: prior[4], cacheRead: prior[5], cacheWrite5m: prior[6], cacheWrite1h: prior[7] }
    const merged: Usage = {
      input: Math.max(old.input, u.input),
      output: Math.max(old.output, u.output),
      cacheRead: Math.max(old.cacheRead, u.cacheRead),
      cacheWrite5m: Math.max(old.cacheWrite5m, u.cacheWrite5m),
      cacheWrite1h: Math.max(old.cacheWrite1h, u.cacheWrite1h),
    }
    const grew = (Object.keys(merged) as (keyof Usage)[]).some(k => merged[k] > old[k])
    if (grew) {
      const delta: Usage = {
        input: merged.input - old.input,
        output: merged.output - old.output,
        cacheRead: merged.cacheRead - old.cacheRead,
        cacheWrite5m: merged.cacheWrite5m - old.cacheWrite5m,
        cacheWrite1h: merged.cacheWrite1h - old.cacheWrite1h,
      }
      const cost = costOf(prior[1], merged) - costOf(prior[1], old)
      addUsage(state, prior[2], prior[1], delta, 0, cost)
      turn.c += cost
      prior[3] = merged.input
      prior[4] = merged.output
      prior[5] = merged.cacheRead
      prior[6] = merged.cacheWrite5m
      prior[7] = merged.cacheWrite1h
    }
  }

  const content = Array.isArray(msg.content) ? msg.content : []
  for (const block of content) {
    const b = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown }
    if (!b || b.type !== 'tool_use' || typeof b.name !== 'string') continue
    const bid = typeof b.id === 'string' ? b.id : ''
    if (bid !== '') {
      if (state.tu.includes(bid)) continue
      state.tu.push(bid)
      if (state.tu.length > RECENT) state.tu.splice(0, state.tu.length - RECENT)
    }
    const d = day(state, dk)
    const input = (b.input ?? {}) as Record<string, unknown>
    turn.s.t += 1
    const server = mcpServer(b.name)
    if (server !== null) {
      bump(d.x, server)
      continue
    }
    bump(d.t, b.name)
    if (b.name === 'Bash' && typeof input.command === 'string') {
      const cmd = shellCommand(input.command)
      if (cmd !== null) bump(d.s, cmd)
      if (isTestRun(input.command)) turn.s.r = true
    }
    if (EDIT_TOOLS.has(b.name)) {
      turn.s.e += 1
      const path = input.file_path ?? input.notebook_path
      if (typeof path === 'string' && isDocFile(path)) turn.s.d += 1
    }
  }
}

/** Applies one parsed JSONL object to the state. */
export function applyLine(state: FileState, obj: Record<string, unknown>, tz: number) {
  if (typeof obj.sessionId === 'string' && state.sid === undefined) state.sid = obj.sessionId
  if (typeof obj.cwd === 'string' && obj.cwd !== '') state.proj = shortProject(obj.cwd)
  if (obj.type === 'user') {
    const text = promptText(obj)
    if (text === null) return
    closeTurn(state)
    const ts = Date.parse(String(obj.timestamp ?? ''))
    const dk = Number.isFinite(ts) ? dayKey(ts, tz) : '1970-01-01'
    state.turn = { day: dk, s: freshSignals(text), c: 0, n: 0 }
    if (state.proj !== undefined) day(state, dk).p = state.proj
  } else if (obj.type === 'assistant') {
    onAssistant(state, obj, tz)
    if (state.proj !== undefined && state.turn !== null) {
      const d = state.days[state.turn.day]
      if (d !== undefined && d.p === undefined) d.p = state.proj
    }
  }
}

/** UTF-8 byte length of a string. */
export function byteLength(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** The index in `s` where its first `bytes` UTF-8 bytes end. */
export function indexAtByte(s: string, bytes: number): number {
  let n = 0
  let i = 0
  while (i < s.length && n < bytes) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4
      i++
    } else n += 3
    i++
  }
  return i
}

/**
 * Parses the complete lines of `text` (everything up to its last newline) into `state`
 * and returns how many bytes that was; a trailing partial line is left for next time.
 */
export function parseText(state: FileState, text: string, tz: number): number {
  const end = text.lastIndexOf('\n')
  if (end < 0) return 0
  const body = text.slice(0, end + 1)
  for (const line of body.split('\n')) {
    if (line.length < 2 || line.charCodeAt(0) !== 123 /* { */) continue
    // Cheap skip of rows that never matter before paying for JSON.parse.
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes('"type": "')) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (obj && typeof obj === 'object') applyLine(state, obj as Record<string, unknown>, tz)
  }
  return byteLength(body)
}

/** The category the open turn would get if it ended now (for display). */
export function openTurnCategory(t: OpenTurn): Category {
  return classify(t.s)
}
