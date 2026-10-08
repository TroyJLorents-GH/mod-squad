// Turns a View into panels of plain text segments sized to the pane: no elements here, so it is testable as data.

import type { View } from './aggregate'

export type Seg = { text: string; color?: string; bold?: boolean; dim?: boolean }
export type Line = Seg[]
export type Panel = { id: string; title: string; color: string; width: number; lines: Line[] }
export type Layout = { twoColumns: boolean; rows: Panel[][] }

export const COLORS = {
  header: '#eab308',
  daily: '#06b6d4',
  project: '#a855f7',
  model: '#f59e0b',
  activity: '#22c55e',
  tools: '#3b82f6',
  shell: '#ec4899',
  mcp: '#14b8a6',
  cost: '#facc15',
} as const

/** Columns from which two panels sit side by side. */
export const TWO_COLUMN_MIN = 100
/** Rows each list panel shows besides Daily Activity. */
export const LIST_ROWS = 8
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

export function fmtCost(n: number): string {
  if (n >= 10_000) return `$${Math.round(n).toLocaleString('en-US')}`
  if (n >= 1000) return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return `$${n.toFixed(2)}`
}

export function fmtCount(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${trim(n / 1e9)}B`
  if (n >= 1e6) return `${trim(n / 1e6)}M`
  if (n >= 1e3) return `${trim(n / 1e3)}k`
  return String(Math.round(n))
}

function trim(x: number): string {
  return x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, '')
}

export function fmtPct(f: number): string {
  return `${Math.round(f * 100)}%`
}

/** A bar `width` cells wide filled to `frac` (0..1) with eighth-block precision. */
export function bar(frac: number, width: number): string {
  if (width <= 0) return ''
  const f = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0))
  const eighths = Math.round(f * width * 8)
  const full = Math.floor(eighths / 8)
  const part = EIGHTHS[eighths % 8] ?? ''
  const drawn = '█'.repeat(full) + part
  // A non-zero value always shows at least a sliver.
  const shown = drawn === '' && f > 0 ? '▏' : drawn
  return shown + ' '.repeat(Math.max(0, width - shown.length))
}

/** Green → lime → amber → red as the share of the largest value grows. */
export function heat(frac: number): string {
  if (frac >= 0.75) return '#ef4444'
  if (frac >= 0.5) return '#f59e0b'
  if (frac >= 0.25) return '#a3e635'
  return '#22c55e'
}

export function truncate(s: string, width: number): string {
  if (width <= 0) return ''
  if (s.length <= width) return s
  if (width === 1) return '…'
  return `${s.slice(0, width - 1)}…`
}

function padEnd(s: string, w: number) {
  return truncate(s, w).padEnd(w)
}

function padStart(s: string, w: number) {
  return truncate(s, w).padStart(w)
}

/** A table row: name, bar, then right-aligned columns, fitted to `inner` cells. */
function row(inner: number, name: string, frac: number, cols: { text: string; width: number; color?: string; dim?: boolean }[]): Line {
  const colsW = cols.reduce((n, c) => n + c.width + 1, 0)
  let nameW = Math.max(6, Math.min(22, Math.floor(inner * 0.34)))
  let barW = inner - nameW - 1 - colsW
  if (barW < 3) {
    nameW = Math.max(4, nameW + barW - 3)
    barW = Math.max(0, inner - nameW - 1 - colsW)
  }
  const line: Line = [{ text: padEnd(name, nameW) + ' ' }]
  if (barW > 0) line.push({ text: bar(frac, barW), color: heat(frac) })
  for (const c of cols) line.push({ text: ' ' + padStart(c.text, c.width), color: c.color, dim: c.dim })
  return line
}

function header(inner: number, labels: { text: string; width: number }[]): Line {
  const colsW = labels.reduce((n, c) => n + c.width + 1, 0)
  const rest = Math.max(0, inner - colsW)
  return [{ text: ' '.repeat(rest) + labels.map(l => ' ' + padStart(l.text, l.width)).join(''), dim: true }]
}

function empty(text: string): Line[] {
  return [[{ text, dim: true }]]
}

function maxOf(xs: number[]): number {
  return xs.reduce((m, x) => Math.max(m, x), 0)
}

/** How many day rows fit, given the pane body's rows (the rest of the dashboard sits around them). */
export function dailyRowsFor(bodyRows: number, twoColumns: boolean): number {
  const chrome = twoColumns ? 12 : 13
  return Math.max(3, Math.min(60, bodyRows - chrome))
}

/** Panel widths and the list panels for a view, sized to `columns` x `bodyRows`. */
export function layout(view: View, columns: number, bodyRows: number): Layout {
  const twoColumns = columns >= TWO_COLUMN_MIN
  const gap = 1
  const half = Math.floor((columns - gap) / 2)
  const w = twoColumns ? half : columns
  // Border (2) and paddingX (2) eat 4 cells.
  const inner = Math.max(10, w - 4)
  const COST = 9

  const dayRows = dailyRowsFor(bodyRows, twoColumns)
  const days = view.daily.slice(0, dayRows)
  const maxDay = maxOf(days.map(d => d.cost))
  const daily: Panel = {
    id: 'daily',
    title: 'Daily Activity',
    color: COLORS.daily,
    width: w,
    lines:
      days.length === 0
        ? empty('No activity in this range.')
        : [
            header(inner, [{ text: 'cost', width: COST }, { text: 'calls', width: 6 }]),
            ...days.map(d => row(inner, d.day, maxDay > 0 ? d.cost / maxDay : 0, [
              { text: fmtCost(d.cost), width: COST, color: COLORS.cost },
              { text: fmtCount(d.calls), width: 6, dim: true },
            ])),
            [{ text: `Showing 1–${days.length} of ${view.daily.length} days`, dim: true }],
          ],
  }

  const listRows = twoColumns ? Math.max(LIST_ROWS, Math.min(dayRows, 20)) : LIST_ROWS
  const projects = view.projects.slice(0, listRows)
  const maxProj = maxOf(projects.map(p => p.cost))
  const project: Panel = {
    id: 'project',
    title: 'By Project',
    color: COLORS.project,
    width: w,
    lines:
      projects.length === 0
        ? empty('No projects in this range.')
        : [
            header(inner, [{ text: 'cost', width: COST }, { text: 'avg/sess', width: 8 }, { text: 'sess', width: 4 }]),
            ...projects.map(p => row(inner, p.name, maxProj > 0 ? p.cost / maxProj : 0, [
              { text: fmtCost(p.cost), width: COST, color: COLORS.cost },
              { text: fmtCost(p.perSession), width: 8, dim: true },
              { text: fmtCount(p.sessions), width: 4, dim: true },
            ])),
          ],
  }

  const models = view.models.slice(0, LIST_ROWS)
  const maxModel = maxOf(models.map(m => m.cost))
  const model: Panel = {
    id: 'model',
    title: 'By Model',
    color: COLORS.model,
    width: w,
    lines:
      models.length === 0
        ? empty('No model calls in this range.')
        : [
            header(inner, [{ text: 'cost', width: COST }, { text: 'cache', width: 5 }, { text: 'calls', width: 6 }]),
            ...models.map(m => row(inner, m.name, maxModel > 0 ? m.cost / maxModel : 0, [
              { text: fmtCost(m.cost), width: COST, color: COLORS.cost },
              { text: fmtPct(m.cacheHit), width: 5, dim: true },
              { text: fmtCount(m.calls), width: 6, dim: true },
            ])),
          ],
  }

  const acts = view.activities.slice(0, LIST_ROWS)
  const maxAct = maxOf(acts.map(a => a.cost))
  const activity: Panel = {
    id: 'activity',
    title: 'By Activity',
    color: COLORS.activity,
    width: w,
    lines:
      acts.length === 0
        ? empty('No turns in this range.')
        : [
            header(inner, [{ text: 'cost', width: COST }, { text: 'turns', width: 6 }]),
            ...acts.map(a => row(inner, a.name, maxAct > 0 ? a.cost / maxAct : 0, [
              { text: fmtCost(a.cost), width: COST, color: COLORS.cost },
              { text: fmtCount(a.turns), width: 6, dim: true },
            ])),
          ],
  }

  const countPanel = (id: string, title: string, color: string, items: { name: string; count: number }[], none: string): Panel => {
    const shown = items.slice(0, LIST_ROWS)
    const max = maxOf(shown.map(i => i.count))
    return {
      id,
      title,
      color,
      width: w,
      lines:
        shown.length === 0
          ? empty(none)
          : [
              ...shown.map(i => row(inner, i.name, max > 0 ? i.count / max : 0, [{ text: fmtCount(i.count), width: 7 }])),
              ...(items.length > shown.length ? [[{ text: `+${items.length - shown.length} more`, dim: true }]] : []),
            ],
    }
  }
  const tools = countPanel('tools', 'Core Tools', COLORS.tools, view.tools, 'No tool calls.')
  const shell = countPanel('shell', 'Shell Commands', COLORS.shell, view.shell, 'No shell commands.')
  const mcp = countPanel('mcp', 'MCP Servers', COLORS.mcp, view.mcp, 'No MCP tool calls.')

  const order = [daily, project, model, activity, tools, shell, mcp]
  const rows: Panel[][] = []
  if (twoColumns) for (let i = 0; i < order.length; i += 2) rows.push(order.slice(i, i + 2))
  else for (const p of order) rows.push([p])
  return { twoColumns, rows }
}

/** The header panel's lines. */
export function headerLines(view: View, rangeLabel: string, inner: number): Line[] {
  const span = view.from === '' ? `through ${view.to}` : view.from === view.to ? view.to : `${view.from} → ${view.to}`
  return [
    [
      { text: 'burn-rate  ', bold: true, color: COLORS.header },
      { text: rangeLabel, bold: true },
      { text: truncate(`  ${span} · est. at list price`, Math.max(0, inner - 11 - rangeLabel.length)), dim: true },
    ],
    [
      { text: fmtCost(view.cost), bold: true, color: COLORS.cost },
      {
        text: truncate(
          `  ${fmtCount(view.calls)} calls · ${fmtCount(view.sessions)} sessions · ${fmtPct(view.cacheHit)} cache hit`,
          Math.max(0, inner - fmtCost(view.cost).length),
        ),
      },
    ],
    [
      {
        text: truncate(
          `tokens  in ${fmtTokens(view.input)} · out ${fmtTokens(view.output)} · cached ${fmtTokens(view.cacheRead)} · written ${fmtTokens(view.cacheWrite)}`,
          inner,
        ),
        dim: true,
      },
    ],
  ]
}
