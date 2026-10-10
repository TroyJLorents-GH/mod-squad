import { clip } from './transcripts'
import type { SessionDigest } from './transcripts'

export type Summary = { title: string; done: string[]; open: string[] }

export const SYSTEM = `You write standup notes from a digest of one coding-assistant session.
Reply with JSON only: {"title":"<= 8 words","done":["past-tense bullet, <= 14 words", ... at most 5],"open":["unfinished item, <= 14 words", ... at most 3]}
"done" lists only what the digest shows was completed: commits, files changed, the assistant's closing message. Do not infer success from a request alone; if nothing was finished, leave "done" empty and put the goal in "open".
Be specific (name the feature, bug or file), not generic. No markdown, no preamble.`

const hhmm = (ms: number, tz: number) => new Date(ms + tz * 60_000).toISOString().slice(11, 16)

/** The text sent to the model for one session. About 6 KB at most. */
export function digestText(d: SessionDigest, tz: number): string {
  const lines = [`Project: ${d.project || 'unknown'}`, `Active: ${hhmm(d.first, tz)}-${hhmm(d.last, tz)}`]
  lines.push('Requests, in order:', ...d.prompts.slice(0, 15).map(p => `- ${clip(p, 300)}`))
  if (d.prompts.length > 15) lines.push(`- (${d.prompts.length - 15} more)`)
  if (d.commits.length > 0) lines.push('Commits:', ...d.commits.slice(0, 10).map(c => `- ${c}`))
  if (d.files.length > 0) lines.push(`Files changed (${d.files.length}):`, ...d.files.slice(0, 20).map(f => `- ${f}`))
  if (d.answer !== '') lines.push('Assistant\'s last message:', clip(d.answer, 700))
  return clip(lines.join('\n'), 6000)
}

export function parseSummary(reply: string): Summary | null {
  const json = reply.match(/\{[\s\S]*\}/)?.[0]
  if (!json) return null
  try {
    const v = JSON.parse(json) as Partial<Summary>
    const list = (x: unknown, n: number) =>
      Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map(s => clip(s.trim(), 140)).slice(0, n) : []
    const title = typeof v.title === 'string' ? clip(v.title.trim(), 80) : ''
    const done = list(v.done, 5)
    const open = list(v.open, 3)
    return title === '' && done.length === 0 && open.length === 0 ? null : { title, done, open }
  } catch {
    return null
  }
}

/** No model: commits when there are any, else the files touched; the first request as the goal. */
export function fallbackSummary(d: SessionDigest): Summary {
  const goal = clip(d.prompts[0] ?? 'Session', 80)
  if (d.commits.length > 0) return { title: goal, done: d.commits.slice(0, 5), open: [] }
  if (d.files.length > 0) {
    const names = d.files.slice(0, 3).map(f => f.split(/[\\/]/).pop() ?? f)
    return { title: goal, done: [`Edited ${d.files.length} file${d.files.length === 1 ? '' : 's'}: ${names.join(', ')}${d.files.length > 3 ? '…' : ''}`], open: [] }
  }
  return { title: goal, done: [], open: [goal] }
}

export type Entry = { d: SessionDigest; s: Summary; isModel: boolean }

/** Standup markdown: one section per project, bullets merged across that project's sessions. */
export function renderMarkdown(day: string, entries: Entry[]): string {
  const byProject = new Map<string, Entry[]>()
  for (const e of entries) byProject.set(e.d.project || 'unknown', [...(byProject.get(e.d.project || 'unknown') ?? []), e])
  const out = [`# Standup · ${day}`, '']
  if (entries.length === 0) return `${out.join('\n')}Nothing to report: no Claude Code activity found for this day.\n`

  const dedupe = (xs: string[]) => {
    const seen = new Set<string>()
    return xs.filter(x => (seen.has(x.toLowerCase()) ? false : (seen.add(x.toLowerCase()), true)))
  }
  for (const [project, es] of [...byProject].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    out.push(`## ${project}`)
    const done = dedupe(es.flatMap(e => e.s.done))
    const open = dedupe(es.flatMap(e => e.s.open))
    if (done.length === 0) out.push('- _No completed work found; see open items._')
    for (const x of done) out.push(`- ${x}`)
    if (open.length > 0) out.push('', '**Open**', ...open.map(x => `- ${x}`))
    const files = new Set(es.flatMap(e => e.d.files)).size
    const commits = es.reduce((n, e) => n + e.d.commits.length, 0)
    out.push('', `_${es.length} session${es.length === 1 ? '' : 's'} · ${files} file${files === 1 ? '' : 's'} changed${commits > 0 ? ` · ${commits} commit${commits === 1 ? '' : 's'}` : ''}_`, '')
  }
  return `${out.join('\n').trimEnd()}\n`
}
