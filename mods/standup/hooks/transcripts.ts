// Reads one Claude Code transcript (JSONL) and boils a single local day of it down to a digest.

export type SessionDigest = {
  sid: string
  project: string
  cwd: string
  first: number
  last: number
  prompts: string[]
  files: string[]
  commits: string[]
  commands: number
  answer: string
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
// Notices and caveats the harness injects as "user" rows are not things the person typed.
const NOT_TYPED = /^(<|\[Request interrupted|Caveat:)/

/** YYYY-MM-DD of `ms` shifted by `tzOffsetMin` (minutes east of UTC). */
export function dayKey(ms: number, tzOffsetMin: number): string {
  return new Date(ms + tzOffsetMin * 60_000).toISOString().slice(0, 10)
}

/** Epoch ms of local midnight at the start of `day`. */
export function dayStart(day: string, tzOffsetMin: number): number {
  return Date.parse(`${day}T00:00:00Z`) - tzOffsetMin * 60_000
}

/** `/home/me/src/app` → `app`; `C:\\work\\api\\` → `api`. */
export function shortProject(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

export const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)

function userText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text: string } => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text')
    .map(b => b.text)
    .join('\n')
}

/** First line of the message of a `git commit`, quoted (`-m "…"`) or heredoc'd, or null. */
export function commitMessage(command: string): string | null {
  if (!/\bgit\s+commit\b/.test(command)) return null
  const heredoc = /<<-?\s*['"]?(\w+)['"]?\s*\n\s*([^\n]+)/.exec(command)
  if (heredoc?.[2]) return clip(heredoc[2].trim(), 120)
  const quoted = /-m\s+(?:"([^"]+)"|'([^']+)')/.exec(command)
  const msg = quoted?.[1] ?? quoted?.[2]
  return msg ? clip(msg.split('\n')[0]?.trim() ?? msg, 120) : null
}

/** What happened in one transcript on `day`, or null when the person did nothing that day. */
export function parseSession(text: string, day: string, tz: number): SessionDigest | null {
  const d: SessionDigest = { sid: '', project: '', cwd: '', first: 0, last: 0, prompts: [], files: [], commits: [], commands: 0, answer: '' }
  const files = new Set<string>()
  for (const line of text.split('\n')) {
    if (line.length < 2) continue
    let o: Record<string, any>
    try {
      o = JSON.parse(line)
    } catch {
      continue // a cut first line (tail read) or one still being written
    }
    if (o.isSidechain === true) continue
    const ts = Date.parse(String(o.timestamp ?? ''))
    if (Number.isNaN(ts) || dayKey(ts, tz) !== day) continue
    if (typeof o.sessionId === 'string') d.sid = o.sessionId
    if (typeof o.cwd === 'string' && o.cwd !== '') d.cwd = o.cwd
    d.first = d.first === 0 ? ts : Math.min(d.first, ts)
    d.last = Math.max(d.last, ts)

    if (o.type === 'user' && o.isMeta !== true) {
      const t = userText(o.message?.content).trim()
      if (t !== '' && !NOT_TYPED.test(t)) d.prompts.push(clip(t.replace(/\s+/g, ' '), 400))
    } else if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      for (const b of o.message.content) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') d.answer = b.text.trim()
        else if (b?.type === 'tool_use') {
          const input = b.input ?? {}
          if (EDIT_TOOLS.has(b.name)) {
            const f = input.file_path ?? input.notebook_path
            if (typeof f === 'string') files.add(f)
          } else if (b.name === 'Bash' && typeof input.command === 'string') {
            d.commands++
            const msg = commitMessage(input.command)
            if (msg !== null) d.commits.push(msg)
          }
        }
      }
    }
  }
  if (d.prompts.length === 0 && files.size === 0) return null
  d.project = shortProject(d.cwd)
  d.files = [...files].map(f => (d.cwd !== '' && f.startsWith(d.cwd) ? f.slice(d.cwd.length).replace(/^[\\/]+/, '') : f))
  return d
}
