// Pure helpers for the context gauge: no engine calls, so tests can hit them directly.

export const GREEN = '#22c55e'
export const ORANGE = '#f59e0b'
export const RED = '#ef4444'

/** Where the bar starts turning orange. */
export const ORANGE_AT = 50
/** The second, louder toast. */
export const CRITICAL_AT = 90

const MIN_BAR = 4
const MAX_BAR = 40

/** The configured warning percentage, defaulting to 80 and kept within 1..100. */
export function warnLevel(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 80
  return Math.min(100, Math.round(n))
}

/** green below 50%, orange below `warnAt`, red from it. */
export function colorFor(percent: number, warnAt: number): string {
  if (percent >= warnAt) return RED
  if (percent >= Math.min(ORANGE_AT, warnAt)) return ORANGE
  return GREEN
}

/** 620000 → "620k", 1000000 → "1M", 1500000 → "1.5M", 950 → "950". */
export function formatTokens(n: number): string {
  const trim = (x: number) => (Math.round(x * 10) / 10).toString()
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`
  if (n >= 1_000) return `${n >= 100_000 ? Math.round(n / 1_000) : trim(n / 1_000)}k`
  return String(Math.round(n))
}

/** The text after the bar: " 62% · 620k / 1M", plus " · /compact soon" from `warnAt`. */
export function label(percent: number, tokens: number, window: number): string {
  return ` ${percent}% · ${formatTokens(tokens)} / ${formatTokens(window)}`
}

export const HINT = ' · /compact soon'

/** Cells the bar gets: what is left of `bodyColumns` after the prefix, brackets and label; 0 when under 4. */
export function barWidth(bodyColumns: number, textColumns: number): number {
  const room = Math.min(MAX_BAR, bodyColumns - textColumns - 2)
  return room < MIN_BAR ? 0 : room
}

export type Segment = { text: string; color: string | null }

/**
 * The bar as runs of same-coloured cells: each filled cell is shaded by its own
 * position (so a fuller bar reads green → orange → red), empty cells are `null`.
 */
export function segments(percent: number, width: number, warnAt: number): Segment[] {
  if (width <= 0) return []
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  const out: Segment[] = []
  for (let i = 0; i < width; i++) {
    const isFilled = i < filled
    const color = isFilled ? colorFor(((i + 0.5) / width) * 100, warnAt) : null
    const last = out[out.length - 1]
    const ch = isFilled ? '█' : '░'
    if (last && last.color === color) last.text += ch
    else out.push({ text: ch, color })
  }
  return out
}

/** The thresholds that warn: `warnAt` and 90, deduplicated and ascending. */
export function thresholds(warnAt: number): number[] {
  return [...new Set([warnAt, CRITICAL_AT])].filter(t => t > 0 && t <= 100).sort((a, b) => a - b)
}

/**
 * The highest threshold the fill crossed going up from `prev` to `now`, or null.
 * A drop (a compaction) re-arms the thresholds it falls below.
 */
export function crossed(prev: number | null, now: number, warnAt: number): number | null {
  const before = prev ?? 0
  const hit = thresholds(warnAt).filter(t => before < t && now >= t)
  return hit.length ? hit[hit.length - 1]! : null
}

export function toastText(percent: number, threshold: number): string {
  return threshold >= CRITICAL_AT
    ? `Context ${percent}% full: run /compact now or the session will auto-compact soon`
    : `Context ${percent}% full: consider /compact soon`
}
