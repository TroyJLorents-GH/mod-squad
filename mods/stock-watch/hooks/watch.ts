import type { Watch } from '../types'

export type Side = 'low' | 'high'

export type Cmd =
  | { kind: 'open' }
  | { kind: 'add'; sym: string; low?: number; high?: number }
  | { kind: 'rm'; sym: string }
  | { kind: 'chime'; on: boolean }
  | { kind: 'power'; on: boolean }
  | { kind: 'quiet'; sym: string; quiet: boolean }
  | { kind: 'list' | 'check' | 'test' | 'mute' | 'unmute' }
  | { kind: 'error'; text: string }

export const POWER_USAGE = 'Usage: /stock on | off  (off stops checking prices, alerts and the status line; the watch list is kept)'

export const CHIME_USAGE = 'Usage: /stock chime on | off  (every ticker)  ·  /stock AAPL chime on | off  (one ticker)'

export const USAGE =
  'Usage: /stock add AAPL low 180 high 200  ·  /stock AAPL 180 200 (low, high)  ·  /stock add AAPL (price only)  ·  /stock rm AAPL  ·  /stock list | check | test | mute | unmute'

const VERBS = new Set(['add', 'rm', 'remove', 'delete', 'list', 'check', 'refresh', 'test', 'mute', 'unmute'])
const LOW_WORDS = new Set(['low', 'below', 'under', '<', '<=', 'lo'])
const HIGH_WORDS = new Set(['high', 'above', 'over', '>', '>=', 'hi'])
// AAPL, BRK-B, BTC-USD, ^GSPC, EURUSD=X, 7203.T
const SYMBOL = /^[A-Z0-9^][A-Z0-9.=^-]{0,11}$/
const NUMBER = /^\$?\d[\d,]*\.?\d*$/

export const toNumber = (t: string): number | null => (NUMBER.test(t) ? Number(t.replace(/[$,]/g, '')) : null)

/** Parses what follows `/stock` (or what is typed in the pane's box). */
export function parseCommand(args: string): Cmd {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { kind: 'open' }
  const verb = (tokens[0] ?? '').toLowerCase()
  if (verb === 'on' || verb === 'off') return tokens.length === 1 ? { kind: 'power', on: verb === 'on' } : { kind: 'error', text: POWER_USAGE }
  if (verb === 'chime') {
    const v = (tokens[1] ?? '').toLowerCase()
    return v === 'on' || v === 'off' ? { kind: 'chime', on: v === 'on' } : { kind: 'error', text: CHIME_USAGE }
  }
  // /stock AAPL chime off: silences one ticker's chime; its toast still shows.
  if (tokens.length === 3 && (tokens[1] ?? '').toLowerCase() === 'chime') {
    const sym = verb.toUpperCase()
    const v = (tokens[2] ?? '').toLowerCase()
    if (!SYMBOL.test(sym) || (v !== 'on' && v !== 'off')) return { kind: 'error', text: CHIME_USAGE }
    return { kind: 'quiet', sym, quiet: v === 'off' }
  }
  if (verb === 'list' || verb === 'check' || verb === 'test' || verb === 'mute' || verb === 'unmute') return { kind: verb }
  if (verb === 'refresh') return { kind: 'check' }

  const rest = VERBS.has(verb) ? tokens.slice(1) : tokens
  const sym = (rest[0] ?? '').toUpperCase()
  if (verb === 'rm' || verb === 'remove' || verb === 'delete') return SYMBOL.test(sym) ? { kind: 'rm', sym } : { kind: 'error', text: USAGE }
  if (!SYMBOL.test(sym) || toNumber(sym) !== null) return { kind: 'error', text: USAGE }

  let low: number | undefined
  let high: number | undefined
  const bare: number[] = []
  for (let i = 1; i < rest.length; i++) {
    const t = (rest[i] ?? '').toLowerCase()
    const side = LOW_WORDS.has(t) ? 'low' : HIGH_WORDS.has(t) ? 'high' : null
    if (side !== null) {
      const n = toNumber(rest[i + 1] ?? '')
      if (n === null) return { kind: 'error', text: `"${t}" needs a price after it. ${USAGE}` }
      if (side === 'low') low = n
      else high = n
      i++
      continue
    }
    const n = toNumber(t)
    if (n === null) return { kind: 'error', text: `Did not understand "${rest[i]}". ${USAGE}` }
    bare.push(n)
  }
  if (bare.length > 2) return { kind: 'error', text: USAGE }
  if (bare.length === 1) return { kind: 'error', text: `One bare price is ambiguous: say "low ${bare[0]}" or "high ${bare[0]}".` }
  if (bare.length === 2 && low === undefined && high === undefined) [low, high] = [Math.min(...bare), Math.max(...bare)]
  // Price-only needs the explicit `add`, so a mistyped command is not mistaken for a ticker.
  if (low === undefined && high === undefined && verb !== 'add') return { kind: 'error', text: `To just watch ${sym}'s price, use /stock add ${sym}. ${USAGE}` }
  if (low !== undefined && high !== undefined && low >= high) return { kind: 'error', text: `The low (${low}) must be below the high (${high}).` }
  return { kind: 'add', sym, low, high }
}

/* -------------------------------------------------------------------- quotes */

export type Quote = { price: number; prev?: number; open?: number; name?: string; currency?: string }

/** Reads Yahoo Finance's chart response. Defensive: any other shape is an error message, never a throw. */
export function parseQuote(text: string): Quote | { error: string } {
  let j: any
  try {
    j = JSON.parse(text)
  } catch {
    return { error: 'the price service did not answer with data (it may be rate-limiting)' }
  }
  const err = j?.chart?.error
  if (err) return { error: String(err.description ?? err.code ?? 'unknown symbol') }
  const m = j?.chart?.result?.[0]?.meta
  const price = m?.regularMarketPrice
  if (typeof price !== 'number' || !Number.isFinite(price)) return { error: 'no price in the response' }
  const prev = typeof m.chartPreviousClose === 'number' ? m.chartPreviousClose : typeof m.previousClose === 'number' ? m.previousClose : undefined
  // Today's open is the latest daily candle's open; the previous close is the fallback baseline.
  const opens: unknown[] = j.chart.result[0].indicators?.quote?.[0]?.open ?? []
  const open = [...opens].reverse().find((v): v is number => typeof v === 'number' && Number.isFinite(v))
  return { price, prev, open, name: m.longName ?? m.shortName, currency: m.currency }
}

export const quoteUrl = (sym: string) => `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`

/* ------------------------------------------------------------------- alerting */

/**
 * What a new price does to a watch: which limit it is past (null inside the band), and whether that is a
 * fresh crossing worth an alert. A limit alerts once; it re-arms when the price comes back inside the band.
 */
export function evaluate(w: Watch, price: number): { side: Side | null; alert: Side | null } {
  const side: Side | null = w.low !== undefined && price <= w.low ? 'low' : w.high !== undefined && price >= w.high ? 'high' : null
  return { side, alert: side !== null && w.fired !== side ? side : null }
}

/* ----------------------------------------------------------------- formatting */

export const fmtPrice = (n: number | undefined): string =>
  n === undefined ? '-' : n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : n.toFixed(n >= 1 ? 2 : 4)

export function fmtChange(price: number | undefined, prev: number | undefined): { text: string; dir: 1 | -1 | 0 } {
  if (price === undefined || prev === undefined || prev === 0) return { text: '', dir: 0 }
  const pct = ((price - prev) / prev) * 100
  return { text: `${pct >= 0 ? '▲' : '▼'}${Math.abs(pct).toFixed(2)}%`, dir: pct > 0 ? 1 : pct < 0 ? -1 : 0 }
}

/** `[···●······]` with the price's place between the low and the high; `!` at a limit. */
export function rangeBar(w: Watch, width = 16): string {
  if (w.price === undefined || w.low === undefined || w.high === undefined) return ''
  const t = Math.min(1, Math.max(0, (w.price - w.low) / (w.high - w.low)))
  const at = Math.round(t * (width - 1))
  return `[${Array.from({ length: width }, (_, i) => (i === at ? (t === 0 || t === 1 ? '!' : '●') : '·')).join('')}]`
}

/** Prices without cents once they are large (83,094 not 83,094.31): the status line is narrow. */
export const fmtShort = (n: number | undefined): string => (n !== undefined && n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : fmtPrice(n))

/**
 * The pinned line under the prompt: the first few tickers with ▲ or ▼ from today's open (the previous close
 * until the open is known), HIGH or LOW once a limit has been hit, and +N for the ones not shown.
 */
export function statusText(ws: Watch[], count = 3): string | undefined {
  const shown = ws.filter(w => w.price !== undefined).slice(0, count)
  if (shown.length === 0) return undefined
  const parts = shown.map(w => {
    const dir = fmtChange(w.price, w.open ?? w.prev).dir
    return `${w.sym} ${fmtShort(w.price)}${dir > 0 ? ' ▲' : dir < 0 ? ' ▼' : ''}${w.fired === undefined ? '' : w.fired === 'high' ? ' HIGH' : ' LOW'}`
  })
  return `${parts.join(' · ')}${ws.length > shown.length ? ` +${ws.length - shown.length}` : ''}`
}

export function alertText(w: Watch, side: Side, price: number): string {
  const limit = side === 'high' ? w.high : w.low
  return `${side === 'high' ? '📈' : '📉'} ${w.sym} ${side === 'high' ? 'reached your high' : 'fell to your low'}: ${fmtPrice(price)}${w.currency ? ` ${w.currency}` : ''} (limit ${fmtPrice(limit)})`
}
