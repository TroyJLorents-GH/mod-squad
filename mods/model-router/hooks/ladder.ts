import type { Effort, ModelKey } from '../types'

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// Cheapest first. Prices are $/MTok (input, output, cache read). Haiku 5.5 bills a higher
// tier once a prompt passes 100k tokens.
export const MODELS = [
  {
    key: 'haiku', id: 'claude-haiku-5-5', label: 'Haiku 5.5', input: 0.1, output: 0.5, cacheRead: 0.01,
    long: { input: 0.5, output: 2.5, cacheRead: 0.05 },
  },
  { key: 'sonnet', id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', input: 2, output: 10, cacheRead: 0.2 },
  { key: 'opus', id: 'claude-opus-5-5', label: 'Opus 5.5', input: 4, output: 20, cacheRead: 0.2 },
  { key: 'fable', id: 'claude-fable-5-1', label: 'Fable 5.1', input: 10, output: 50, cacheRead: 0.25 },
] as const satisfies readonly {
  key: ModelKey
  id: string
  label: string
  input: number
  output: number
  cacheRead: number
  long?: { input: number; output: number; cacheRead: number }
}[]

export type ModelInfo = (typeof MODELS)[number]

export const RUNGS = MODELS.length * EFFORTS.length
export const TOP = RUNGS - 1

export const rungOf = (model: ModelKey, effort: Effort) =>
  MODELS.findIndex(m => m.key === model) * EFFORTS.length + EFFORTS.indexOf(effort)

export const modelAt = (rung: number): ModelInfo => MODELS[Math.floor(rung / EFFORTS.length)] ?? MODELS[0]
export const effortAt = (rung: number): Effort => EFFORTS[rung % EFFORTS.length] ?? 'medium'
export const labelAt = (rung: number) => `${modelAt(rung).label} · ${effortAt(rung)}`

export const clamp = (rung: number, ceiling: ModelKey = 'fable') =>
  Math.max(0, Math.min(rung, rungOf(ceiling, 'max')))

/** Maps whatever model id the engine reports back onto the ladder; null when it's off-ladder (e.g. Haiku). */
export function rungFromSession(modelId: string, effort: unknown): number | null {
  const m = MODELS.findIndex(x => modelId.includes(x.id) || modelId.includes(x.key))
  if (m < 0) return null
  const ei = typeof effort === 'string' ? EFFORTS.indexOf(effort as Effort) : -1
  return m * EFFORTS.length + (ei < 0 ? 1 : ei)
}

// Green → orange → red along the ladder.
export function colorAt(rung: number): string {
  const green = [0x22, 0xc5, 0x5e]
  const orange = [0xf5, 0x9e, 0x0b]
  const red = [0xef, 0x44, 0x44]
  const t = rung / TOP
  const [a, b, u] = t < 0.5 ? [green, orange, t * 2] : [orange, red, (t - 0.5) * 2]
  const hex = a.map((c, i) => Math.round(c + ((b[i] ?? c) - c) * u).toString(16).padStart(2, '0'))
  return `#${hex.join('')}`
}

// Rungs worth stopping on when escalating: max effort on a cheaper model is rarely
// better value than the next model up at medium. Haiku low/medium/high, Sonnet medium/high,
// Opus medium..xhigh, Fable high..max.
const STOPS = [0, 1, 2, 6, 7, 11, 12, 13, 17, 18, 19]
export const bump = (rung: number) => STOPS.find(s => s > rung) ?? TOP

/* ------------------------------------------------------------------ prompts */

type Rule = { re: RegExp; rung: number; why: string }

// Highest matching rung wins. Ordered roughly by rung for readability only.
const RULES: Rule[] = [
  { re: /\b(typo|rename|reformat|format this|lint|spelling|bump (the )?version)\b/i, rung: 1, why: 'mechanical edit' },
  { re: /^(what|who|when|where|which|is|are|does|do|can|how do i)\b.{0,160}\??$/is, rung: 1, why: 'short question' },
  { re: /\b(explain|summari[sz]e|what does|tl;?dr|describe)\b/i, rung: 1, why: 'explanation' },
  { re: /\b(git (status|log|diff|add|commit|checkout|branch)|ls|cat|grep|run (the )?(tests?|build))\b/i, rung: 1, why: 'routine command' },
  { re: /\b(write|add|create|generate)\b.{0,40}\b(script|function|method|test|endpoint|component|query|regex|dockerfile|yaml|readme)\b/i, rung: 7, why: 'single-unit code' },
  { re: /\b(fix|debug)\b.{0,40}\b(bug|error|exception|failing|crash|warning)\b/i, rung: 7, why: 'targeted fix' },
  { re: /\b(implement|build|feature|integrate|wire up|hook up|add support for)\b/i, rung: 11, why: 'feature work' },
  { re: /\b(agent(ic)?|llm|rag|embedding|tool[- ]?use|mcp server|semantic kernel|ai foundry|azure openai)\b/i, rung: 11, why: 'LLM/agent system' },
  { re: /\b(refactor|restructure|across (the|all|every)|multi[- ]?file|whole (codebase|repo|project)|migrate|migration|upgrade to)\b/i, rung: 12, why: 'multi-file / migration' },
  { re: /\b(architect(ure)?|design (the|a) system|trade-?offs?|scalab|security|auth(n|z|entication|orization)?|vulnerab|performance|optimi[sz]e|memory leak)\b/i, rung: 12, why: 'design / security / perf' },
  { re: /\b(race condition|deadlock|concurren|thread[- ]safe|distributed|consensus|flaky|intermittent|heisenbug|non-?determin)/i, rung: 13, why: 'concurrency / nondeterminism' },
  { re: /\b(from scratch|end[- ]to[- ]end|entire (app|system|platform)|production[- ]ready|long[- ]running|until (it|all) (works|pass))/i, rung: 13, why: 'long-horizon build' },
  { re: /\b(prove|proof|formal(ly)?|invariant|novel algorithm|compiler|type system|cryptograph|research)\b/i, rung: 17, why: 'deep reasoning' },
]

/** Scores a prompt on the ladder from its wording and shape alone. */
export function classifyHeuristic(text: string): { rung: number; reason: string } {
  const t = text.trim()
  let rung = t.length < 40 ? 1 : 6
  const why: string[] = []

  for (const r of RULES) {
    if (r.re.test(t) && r.rung >= rung) {
      if (r.rung > rung) why.length = 0
      rung = r.rung
      why.push(r.why)
    }
  }

  // Shape: long specs, pasted code and stack traces all mean more to hold in mind.
  const codeBlocks = (t.match(/```/g) ?? []).length / 2
  const hasTrace = /(at [\w.$<>]+\(.*:\d+\)|Traceback \(most recent|Exception:|panicked at|\bE\d{4}\b|CS\d{4})/.test(t)
  if (t.length > 2500 || codeBlocks >= 2) (rung = bump(rung)), why.push('long / code-heavy prompt')
  if (hasTrace && rung < 11) (rung = Math.max(rung, 7)), why.push('stack trace')

  // Explicit user dials.
  if (/\bultrathink\b|\bthink (really|very) hard\b/i.test(t)) (rung = Math.max(rung, 18)), why.push('asked for max thinking')
  else if (/\b(think hard|carefully|thorough(ly)?|deep dive|double[- ]check)\b/i.test(t)) (rung = bump(rung)), why.push('asked for care')
  if (/\b(quick(ly)?|just|briefly|tiny|small|simple)\b/i.test(t) && rung > 1) (rung = Math.max(0, rung - (rung >= 11 ? 4 : 1))), why.push('asked for quick')

  return { rung, reason: why.length ? why.join(', ') : 'general chat' }
}

/* ---------------------------------------------------------- Haiku grading */

export const CLASSIFIER_SYSTEM = `You route a coding assistant's next turn to the cheapest model and reasoning effort that will do it well.
Models, cheapest first: haiku (Haiku 5.5, $0.10/$0.50 per MTok — fastest; classification, lookups, short answers, mechanical edits), sonnet (Sonnet 5.5, $2/$10 per MTok — strong everyday coding), opus (Opus 5.5, $4/$20 — hard multi-file engineering, design, subtle debugging), fable (Fable 5.1, $10/$50 — only for the hardest reasoning, novel algorithms, long-horizon autonomous builds, or after cheaper models failed).
Effort: low | medium | high | xhigh | max. Prefer a stronger model at lower effort over a weaker model at max.
Guide: chat, lookups, short explanations, git/shell one-liners, mechanical edits -> haiku low/medium (haiku skips checks at low, so use medium for anything with tool use). Longer explanations, small scripts -> haiku high or sonnet medium. Single-file edits, scripts, small fixes, tests -> sonnet high. Features touching a few files, LLM/agent code, non-trivial debugging -> opus medium. Refactors, migrations, architecture, security, performance -> opus high. Concurrency, flaky failures, end-to-end builds -> opus xhigh. Proofs, novel algorithms, repeated failure -> fable high/xhigh.
Reply with JSON only: {"model":"haiku|sonnet|opus|fable","effort":"low|medium|high|xhigh|max","reason":"<= 8 words"}`

export function classifierPrompt(text: string, current: number | null): string {
  const clipped = text.length > 6000 ? `${text.slice(0, 3000)}\n…\n${text.slice(-3000)}` : text
  const now = current === null ? 'unknown' : labelAt(current)
  return `Currently running: ${now}.\n\n<next_user_message>\n${clipped}\n</next_user_message>`
}

export function parseClassifier(reply: string): { rung: number; reason: string } | null {
  const json = reply.match(/\{[\s\S]*\}/)?.[0]
  if (!json) return null
  try {
    const v = JSON.parse(json) as { model?: string; effort?: string; reason?: string }
    if (!MODELS.some(m => m.key === v.model) || !EFFORTS.includes(v.effort as Effort)) return null
    return { rung: rungOf(v.model as ModelKey, v.effort as Effort), reason: String(v.reason ?? '').slice(0, 80) || 'graded' }
  } catch {
    return null
  }
}

/* --------------------------------------------------------- shell commands */

const RISKY = /\b(terraform (apply|destroy)|kubectl (apply|delete|rollout)|helm (upgrade|install|uninstall)|az (deployment|webapp|functionapp|aks|sql)\b|func azure functionapp publish|dotnet ef database update|prisma migrate|alembic upgrade|drop (table|database)|rm -rf|git push (-f|--force)|docker push)/i

/** Rung floor a shell command implies, with why; null when the command says nothing. */
export function commandFloor(cmd: string): { rung: number; reason: string } | null {
  if (RISKY.test(cmd)) return { rung: rungOf('opus', 'high'), reason: `risky command: ${cmd.slice(0, 32)}` }
  return null
}

/* -------------------------------------------------------------------- cost */

type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  model?: string
}

export function costUsd(u: Usage): number {
  const base = MODELS.find(x => u.model?.includes(x.id)) ?? MODELS.find(x => x.key === 'opus') ?? MODELS[0]
  const promptTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
  const m = 'long' in base && promptTokens > 100_000 ? { ...base, ...base.long } : base
  const mtok =
    (u.input_tokens ?? 0) * m.input +
    (u.cache_creation_input_tokens ?? 0) * m.input * 1.25 +
    (u.cache_read_input_tokens ?? 0) * m.cacheRead +
    (u.output_tokens ?? 0) * m.output
  return mtok / 1e6
}
