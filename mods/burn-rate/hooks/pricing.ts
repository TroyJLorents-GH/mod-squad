// List prices in USD per million tokens. Cache writes are priced off `input`:
// 1.25x for the 5-minute TTL, 2x for the 1-hour TTL. Estimates only.

export type Price = {
  input: number
  output: number
  cacheRead: number
  /** A higher tier that applies when the prompt (input + cache read + cache write) exceeds `above` tokens. */
  long?: { above: number; input: number; output: number; cacheRead: number }
}

/** Matched by prefix, longest first, so `claude-opus-5-5` wins over `claude-opus-5`. */
export const PRICES: Readonly<Record<string, Price>> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    long: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 },
  },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
}

const PREFIXES = Object.keys(PRICES).sort((a, b) => b.length - a.length)

/** Token counts of one API response, cache writes split by TTL. */
export type Usage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

/** The price row for a model id (`claude-opus-5-5`, `claude-opus-5-5[1m]`, `us.anthropic.claude-...`), or undefined. */
export function priceOf(model: string): Price | undefined {
  const id = model.toLowerCase().replace(/^.*?(claude-)/, '$1')
  const key = PREFIXES.find(p => id.startsWith(p))
  return key === undefined ? undefined : PRICES[key]
}

/** USD for one response at list price; 0 for a model with no price. */
export function costOf(model: string, u: Usage): number {
  const p = priceOf(model)
  if (p === undefined) return 0
  const prompt = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h
  const tier = p.long !== undefined && prompt > p.long.above ? p.long : p
  const usd =
    u.input * tier.input +
    u.output * tier.output +
    u.cacheRead * tier.cacheRead +
    u.cacheWrite5m * tier.input * 1.25 +
    u.cacheWrite1h * tier.input * 2
  return usd / 1_000_000
}

/** `claude-opus-5-5` → `Opus 5.5`; an unpriced id → `(unpriced) <id>`. */
export function modelLabel(model: string): string {
  if (priceOf(model) === undefined) return `(unpriced) ${model}`
  const id = model.toLowerCase().replace(/^.*?claude-/, '').replace(/\[.*\]$/, '')
  const parts = id.split('-').filter(p => !/^\d{8}$/.test(p))
  const [family = '', ...ver] = parts
  const name = family.charAt(0).toUpperCase() + family.slice(1)
  return ver.length > 0 ? `${name} ${ver.join('.')}` : name
}
