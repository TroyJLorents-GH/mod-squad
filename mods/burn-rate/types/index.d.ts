export type Range = 'today' | '7d' | '30d' | 'month' | '6m' | 'lifetime'

export type ActivityName =
  | 'Coding'
  | 'Debugging'
  | 'Feature Dev'
  | 'Exploration'
  | 'Refactoring'
  | 'Testing'
  | 'Docs'
  | 'Conversation'

/** Everything the dashboard shows for one date range. Costs are USD at list price. */
export type View = {
  range: Range
  /** First day included (YYYY-MM-DD, local), '' for lifetime; `to` is today. */
  from: string
  to: string
  cost: number
  calls: number
  sessions: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** cacheRead / (input + cacheRead + cacheWrite), 0..1. */
  cacheHit: number
  /** Newest first, days with calls only. */
  daily: { day: string; cost: number; calls: number }[]
  projects: { name: string; cost: number; sessions: number; perSession: number }[]
  models: { name: string; cost: number; calls: number; cacheHit: number }[]
  activities: { name: ActivityName; cost: number; turns: number }[]
  tools: { name: string; count: number }[]
  shell: { name: string; count: number }[]
  mcp: { name: string; count: number }[]
}

export type ScanStatus = {
  isScanning: boolean
  /** Files looked at so far / found, during a scan. */
  done: number
  total: number
  /** Files re-read (changed or new) by the last scan. */
  parsed: number
  /** Files skipped because they could not be read. */
  skipped: number
  /** When the last scan finished (ms since epoch), 0 before the first. */
  finishedAt: number
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'burn-rate': {
      /** The range picked in the pane; null until the person picks one (the `defaultRange` setting applies). */
      range: Range | null
      /** Every range's view from the last scan; null before the first. */
      views: Record<Range, View> | null
      status: ScanStatus
      /** Cost of turns finished since the last scan (for the status line). */
      sinceScan: number
    }
  }
}
