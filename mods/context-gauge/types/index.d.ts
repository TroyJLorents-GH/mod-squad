export type Reading = {
  /** Input tokens the last main-loop response was answered over. */
  tokens: number
  /** The session model's context window, in tokens. */
  window: number
  /** tokens / window as a whole percentage. */
  percent: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-gauge': {
      /** The latest context reading; null before the first response or right after a compaction. */
      reading: Reading | null
      /** Whether the band is hidden (/gauge hide). */
      isHidden: boolean
    }
  }
}
