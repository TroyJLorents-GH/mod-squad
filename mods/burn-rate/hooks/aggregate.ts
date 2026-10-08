// Folds per-file aggregates into what the dashboard shows for one date range.

import { CATEGORIES, classify } from './classify'
import type { Category } from './classify'
import type { FileState } from './parse'
import { modelLabel } from './pricing'
import type { Range, View } from '../types'

export type { Range, View }

export const RANGES = ['today', '7d', '30d', 'month', '6m', 'lifetime'] as const satisfies readonly Range[]

export const RANGE_LABEL: Readonly<Record<Range, string>> = {
  today: 'Today',
  '7d': '7 Days',
  '30d': '30 Days',
  month: 'This Month',
  '6m': '6 Months',
  lifetime: 'Lifetime',
}

export const RANGE_HOTKEY: Readonly<Record<Range, string>> = {
  today: 't',
  '7d': '7',
  '30d': '3',
  month: 'm',
  '6m': '6',
  lifetime: 'l',
}

export function isRange(v: unknown): v is Range {
  return typeof v === 'string' && (RANGES as readonly string[]).includes(v)
}

function shiftDay(key: string, days: number): string {
  const t = Date.parse(`${key}T00:00:00Z`) + days * 86_400_000
  return new Date(t).toISOString().slice(0, 10)
}

/** The first day a range covers, given today's YYYY-MM-DD. */
export function rangeStart(range: Range, today: string): string {
  switch (range) {
    case 'today':
      return today
    case '7d':
      return shiftDay(today, -6)
    case '30d':
      return shiftDay(today, -29)
    case 'month':
      return `${today.slice(0, 7)}-01`
    case '6m': {
      const y = Number(today.slice(0, 4))
      const m = Number(today.slice(5, 7)) - 6
      const yy = m <= 0 ? y - 1 : y
      const mm = m <= 0 ? m + 12 : m
      const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate()
      const dd = Math.min(Number(today.slice(8, 10)), last)
      return shiftDay(`${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`, 1)
    }
    case 'lifetime':
      return ''
  }
}

function add(map: Map<string, number>, key: string, by: number) {
  map.set(key, (map.get(key) ?? 0) + by)
}

function counts(map: Map<string, number>) {
  return [...map].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** Everything the dashboard shows for `range`, over every file's aggregate. */
export function aggregate(files: readonly FileState[], range: Range, today: string): View {
  const from = rangeStart(range, today)
  const inRange = (d: string) => d >= from && d <= today
  const view: View = {
    range,
    from,
    to: today,
    cost: 0,
    calls: 0,
    sessions: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheHit: 0,
    daily: [],
    projects: [],
    models: [],
    activities: [],
    tools: [],
    shell: [],
    mcp: [],
  }
  const daily = new Map<string, { cost: number; calls: number }>()
  const projects = new Map<string, { cost: number; sessions: Set<string> }>()
  const models = new Map<string, { cost: number; calls: number; read: number; prompt: number }>()
  const acts = new Map<Category, { cost: number; turns: number }>()
  const tools = new Map<string, number>()
  const shell = new Map<string, number>()
  const mcp = new Map<string, number>()
  const sessions = new Set<string>()

  files.forEach((f, i) => {
    const sid = f.sid ?? `file-${i}`
    for (const [dk, d] of Object.entries(f.days)) {
      if (!inRange(dk)) continue
      let dayCost = 0
      let dayCalls = 0
      for (const [model, r] of Object.entries(d.m)) {
        const [calls, input, output, read, w5, w1, cost] = r
        dayCost += cost
        dayCalls += calls
        view.input += input
        view.output += output
        view.cacheRead += read
        view.cacheWrite += w5 + w1
        const label = modelLabel(model)
        const m = models.get(label) ?? { cost: 0, calls: 0, read: 0, prompt: 0 }
        m.cost += cost
        m.calls += calls
        m.read += read
        m.prompt += input + read + w5 + w1
        models.set(label, m)
      }
      if (dayCalls > 0 || Object.keys(d.t).length + Object.keys(d.x).length > 0) sessions.add(sid)
      const dd = daily.get(dk) ?? { cost: 0, calls: 0 }
      dd.cost += dayCost
      dd.calls += dayCalls
      daily.set(dk, dd)
      if (dayCalls > 0) {
        const name = d.p ?? f.proj ?? '(unknown)'
        const p = projects.get(name) ?? { cost: 0, sessions: new Set<string>() }
        p.cost += dayCost
        p.sessions.add(sid)
        projects.set(name, p)
      }
      for (const [cat, [cost, turns]] of Object.entries(d.a) as [Category, [number, number]][]) {
        const a = acts.get(cat) ?? { cost: 0, turns: 0 }
        a.cost += cost
        a.turns += turns
        acts.set(cat, a)
      }
      for (const [k, n] of Object.entries(d.t)) add(tools, k, n)
      for (const [k, n] of Object.entries(d.s)) add(shell, k, n)
      for (const [k, n] of Object.entries(d.x)) add(mcp, k, n)
      view.cost += dayCost
      view.calls += dayCalls
    }
    // The turn still running (or the last one of the file) counts too.
    const t = f.turn
    if (t !== null && t.n > 0 && inRange(t.day)) {
      const cat = classify(t.s)
      const a = acts.get(cat) ?? { cost: 0, turns: 0 }
      a.cost += t.c
      a.turns += 1
      acts.set(cat, a)
    }
  })

  const prompt = view.input + view.cacheRead + view.cacheWrite
  view.cacheHit = prompt > 0 ? view.cacheRead / prompt : 0
  view.sessions = sessions.size
  view.daily = [...daily]
    .filter(([, d]) => d.calls > 0)
    .map(([day, d]) => ({ day, ...d }))
    .sort((a, b) => (a.day < b.day ? 1 : -1))
  view.projects = [...projects]
    .map(([name, p]) => ({ name, cost: p.cost, sessions: p.sessions.size, perSession: p.cost / Math.max(1, p.sessions.size) }))
    .sort((a, b) => b.cost - a.cost)
  view.models = [...models]
    .map(([name, m]) => ({ name, cost: m.cost, calls: m.calls, cacheHit: m.prompt > 0 ? m.read / m.prompt : 0 }))
    .sort((a, b) => b.cost - a.cost || b.calls - a.calls)
  view.activities = CATEGORIES.flatMap(name => {
    const a = acts.get(name)
    return a === undefined || a.turns === 0 ? [] : [{ name, cost: a.cost, turns: a.turns }]
  }).sort((a, b) => b.cost - a.cost)
  view.tools = counts(tools)
  view.shell = counts(shell)
  view.mcp = counts(mcp)
  return view
}

/** Every range at once, so switching is instant. */
export function aggregateAll(files: readonly FileState[], today: string): Record<Range, View> {
  const out = {} as Record<Range, View>
  for (const r of RANGES) out[r] = aggregate(files, r, today)
  return out
}
