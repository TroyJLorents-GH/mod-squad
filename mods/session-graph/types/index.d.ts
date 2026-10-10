/** What one session writes to the shared folder. */
export type SessionRecord = {
  sid: string
  project: string
  cwd: string
  /** The first thing the person asked, as a fallback name. */
  title: string
  /** What the session is about overall, written by the model. */
  summary: string
  /** Key results or decisions so far, most recent first. */
  notes: string[]
  /** Short noun phrases naming what the session covers, newest first. */
  topics: string[]
  /** Files the session edited. */
  files: string[]
  updatedAt: number
  /** Sessions already announced to the person, so each link alerts once. */
  alerted: string[]
  /** The person turned the graph off for this session: others skip it. */
  off?: boolean
}

/** Another session that overlaps this one. */
export type Link = {
  sid: string
  project: string
  title: string
  summary: string
  notes: string[]
  updatedAt: number
  /** Shared topics in this session's wording. */
  topics: string[]
  files: string[]
  score: number
}

export type Pending = { sid: string; label: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'session-graph': {
      enabled: boolean
      /** What this session has recorded so far; null before its first turn. */
      self: { title: string; summary: string; topics: string[]; files: string[] } | null
      links: Link[]
      /** Sessions found in the shared folder inside the look-back window, this one excluded. */
      tracked: number
      /** A linked session's findings waiting to ride along with the next prompt. */
      pending: Pending | null
    }
  }
}
