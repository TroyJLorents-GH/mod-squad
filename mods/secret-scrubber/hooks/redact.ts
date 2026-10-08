// Pure redaction: no engine calls, no state. Every rule replaces a secret with
// `[REDACTED:<kind>]` and leaves the text around it as it was.

export type Rule = {
  kind: string
  /** Must carry the `g` flag. */
  re: RegExp
  /**
   * The capture group holding the secret. With it, only that group is replaced
   * and the rest of the match (a `KEY=` prefix, quotes) is kept; without it,
   * the whole match is replaced.
   */
  group?: number
  /** A last say on a match: false keeps it as it is. */
  check?: (secret: string) => boolean
}

export type Counts = Record<string, number>

export type Redacted = { text: string; counts: Counts; total: number }

export const marker = (kind: string) => `[REDACTED:${kind}]`

// A token's start may not sit inside a longer run of token or base64
// characters, so a key-shaped run inside an image's base64, a hash or an
// identifier is left alone.
const B = '(?<![A-Za-z0-9+/_-])'
const E = '(?![A-Za-z0-9+/_-])'

const mixed = (s: string) => /[0-9]/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s)

const ENV_KEYWORD = '(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]KEY)'
const SEG = '[A-Za-z0-9]+'

/** Values an env-style line holds that are not secrets: references, code, flags. */
function isEnvSecret(value: string): boolean {
  const v = value.replace(/^["']|["']$/g, '')
  if (v === '' || v.startsWith('[REDACTED:')) return false
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(v)) return false // $VAR, ${VAR}
  if (/^(?:true|false|null|none|nil|undefined|yes|no)$/i.test(v)) return false
  if (/^\d{1,5}$/.test(v)) return false // max_tokens=4096, TOKEN_TTL=300
  if (/^\*+$/.test(v)) return false // already masked
  // Code, not a value: process.env.X, os.environ["X"], getToken(), new Foo
  if (value === v && /^[A-Za-z_$][\w$]*(?:\.[\w$]|\(|\[)/.test(v)) return false
  return true
}

export const RULES: readonly Rule[] = [
  // PEM private key blocks; a block cut off by truncated output is taken to its end.
  {
    kind: 'private-key',
    re: /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----(?:[A-Za-z0-9+/=\s]|\\[nr]|(?<=\n)[A-Za-z-]+: [^\n]*)+?(?:-----END \1PRIVATE KEY-----|(?![\s\S]))/g,
  },
  { kind: 'jwt', re: new RegExp(`${B}eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}${E}`, 'g') },
  { kind: 'anthropic-key', re: new RegExp(`${B}sk-ant-[A-Za-z0-9_-]{20,}`, 'g') },
  {
    kind: 'openai-key',
    re: new RegExp(`${B}sk-(?:proj-|svcacct-|admin-)?([A-Za-z0-9_-]{32,})${E}`, 'g'),
    check: s => mixed(s.replace(/^sk-(?:proj-|svcacct-|admin-)?/, '')),
  },
  { kind: 'aws-access-key-id', re: new RegExp(`${B}(?:AKIA|ASIA)[A-Z0-9]{16}${E}`, 'g') },
  {
    kind: 'aws-secret',
    re: /(aws_secret_access_key["']?\s*[:=]\s*["']?)([A-Za-z0-9/+=]{20,})/gi,
    group: 2,
  },
  { kind: 'github-token', re: new RegExp(`${B}(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})`, 'g') },
  { kind: 'slack-token', re: new RegExp(`${B}xox[abposr]-[A-Za-z0-9-]{10,}`, 'g') },
  { kind: 'stripe-key', re: new RegExp(`${B}(?:sk|rk)_live_[A-Za-z0-9]{16,}`, 'g') },
  { kind: 'google-api-key', re: new RegExp(`${B}AIza[0-9A-Za-z_-]{35}${E}`, 'g') },
  // Azure: storage/service-bus keys and SAS signatures inside connection strings and URLs.
  { kind: 'azure-storage-key', re: /((?:AccountKey|SharedAccessKey)=)([A-Za-z0-9+/]{20,}={0,2})/g, group: 2 },
  { kind: 'azure-sas', re: /(SharedAccessSignature=)([^;\s"'<>]+)/g, group: 2 },
  { kind: 'azure-sas', re: /([?&;]sig=)([A-Za-z0-9%+/=]{16,})/g, group: 2 },
  // Azure OpenAI / Cognitive Services keys in headers and configs.
  {
    kind: 'azure-api-key',
    re: /((?<![A-Za-z0-9_])(?:api-key|ocp-apim-subscription-key)["']?\s*[:=]\s*["']?)([A-Za-z0-9]{32,})/gi,
    group: 2,
  },
  // .env-style KEY=value where KEY names a secret: only the value goes.
  {
    kind: 'env-secret',
    re: new RegExp(
      `((?<![A-Za-z0-9_.])(?:${SEG}[_.-])*${ENV_KEYWORD}(?:[_.-]${SEG})*["']?\\s*=(?!=)[ \\t]*)("[^"\\n]*"|'[^'\\n]*'|[^\\s"'&;,]+)`,
      'gi',
    ),
    group: 2,
    check: isEnvSecret,
  },
]

/**
 * Compiles the person's comma-separated extra patterns. Each valid one becomes
 * a `custom` rule; the ones that do not compile are handed back by text.
 */
export function compileExtra(spec: string | undefined): { rules: Rule[]; invalid: string[] } {
  const rules: Rule[] = []
  const invalid: string[] = []
  for (const raw of (spec ?? '').split(',')) {
    const source = raw.trim()
    if (!source) continue
    try {
      const re = new RegExp(source, 'g')
      if (re.test('')) invalid.push(source) // matches nothing at all: would mark every gap
      else rules.push({ kind: 'custom', re })
    } catch {
      invalid.push(source)
    }
  }
  return { rules, invalid }
}

function applyRule(text: string, rule: Rule, counts: Counts): string {
  rule.re.lastIndex = 0
  return text.replace(rule.re, (...args: unknown[]) => {
    const match = args[0] as string
    if (match === '') return match
    const g = rule.group
    if (g === undefined) {
      if (rule.check && !rule.check(match)) return match
      counts[rule.kind] = (counts[rule.kind] ?? 0) + 1
      return marker(rule.kind)
    }
    const secret = args[g] as string | undefined
    if (!secret || (rule.check && !rule.check(secret))) return match
    // Groups before `g` are the match's prefix; the secret is the match's tail
    // or sits right after them.
    let prefix = ''
    for (let i = 1; i < g; i++) prefix += (args[i] as string | undefined) ?? ''
    const rest = match.slice(prefix.length + secret.length)
    counts[rule.kind] = (counts[rule.kind] ?? 0) + 1
    // A quoted value keeps its quotes: KEY="[REDACTED:env-secret]".
    const q = secret[0]
    const quoted = secret.length >= 2 && (q === '"' || q === "'") && secret.endsWith(q)
    return prefix + (quoted ? q + marker(rule.kind) + q : marker(rule.kind)) + rest
  })
}

/** Redacts every secret the rules (built-ins, then `extra`) find in `text`. */
export function redactText(text: string, extra: readonly Rule[] = []): Redacted {
  const counts: Counts = {}
  let out = text
  for (const rule of RULES) out = applyRule(out, rule, counts)
  for (const rule of extra) out = applyRule(out, rule, counts)
  return { text: out, counts, total: sum(counts) }
}

export const sum = (counts: Counts) => Object.values(counts).reduce((a, b) => a + b, 0)

export function mergeCounts(into: Counts, from: Counts): Counts {
  const out = { ...into }
  for (const [k, n] of Object.entries(from)) out[k] = (out[k] ?? 0) + n
  return out
}

/** A content block as the Messages API spells it. */
export type Block = { type: string; [field: string]: unknown }

/**
 * Redacts the text a row's blocks carry: text blocks, and each tool_result's
 * `content` (a string, or a list whose text blocks are redacted). Images,
 * documents, tool_use and thinking blocks are passed through untouched.
 * `content` is the original array when nothing changed.
 */
export function redactBlocks(content: readonly Block[], extra: readonly Rule[] = []): { content: Block[]; counts: Counts; total: number } {
  let counts: Counts = {}
  let changed = false
  const text = (s: string) => {
    const r = redactText(s, extra)
    if (r.total > 0) {
      changed = true
      counts = mergeCounts(counts, r.counts)
    }
    return r.total > 0 ? r.text : s
  }
  const textBlock = (b: Block): Block => (b.type === 'text' && typeof b.text === 'string' ? withField(b, 'text', text(b.text)) : b)

  const out = content.map((b): Block => {
    if (b.type === 'text') return textBlock(b)
    if (b.type === 'tool_result') {
      const c = b.content
      if (typeof c === 'string') return withField(b, 'content', text(c))
      if (Array.isArray(c)) {
        const inner = (c as Block[]).map(textBlock)
        return inner.some((x, i) => x !== c[i]) ? { ...b, content: inner } : b
      }
    }
    return b
  })
  return { content: changed ? out : (content as Block[]), counts, total: sum(counts) }
}

function withField(b: Block, field: string, value: string): Block {
  return b[field] === value ? b : { ...b, [field]: value }
}

export const FAILURE_NOTICE = '[secret-scrubber: this output was withheld because redaction failed]'

/**
 * The fail-closed form of a row: every text block and every tool_result's
 * content replaced by a short notice. Written so it cannot throw on odd input.
 */
export function withheld(content: unknown): Block[] {
  if (!Array.isArray(content)) return [{ type: 'text', text: FAILURE_NOTICE }]
  return content.map((b): Block => {
    if (!b || typeof b !== 'object') return { type: 'text', text: FAILURE_NOTICE }
    const block = b as Block
    if (block.type === 'text') return { ...block, text: FAILURE_NOTICE }
    if (block.type === 'tool_result') return { ...block, content: FAILURE_NOTICE }
    return block
  })
}
