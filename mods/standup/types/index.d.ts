export type Result = {
  day: string
  markdown: string
  projects: number
  sessions: number
  /** Sessions the model summarized / sessions that fell back to a plain digest. */
  summarized: number
  fallback: number
  /** Where the markdown was saved, or '' when saving is off or failed. */
  path: string
}

export type RunStatus = { isRunning: boolean; done: number; total: number; error?: string }

declare module 'claude-code' {
  interface PluginState {
    standup: {
      result: Result | null
      status: RunStatus
      /** The day picked in the pane: today | yesterday | YYYY-MM-DD. */
      pick: string
    }
  }
}
