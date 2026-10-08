export type Block = {
  /** When it was blocked, ms since epoch. */
  at: number
  tool: string
  what: string
  why: string
}

declare module 'claude-code' {
  interface PluginState {
    'safety-net': {
      /** False after /safety-net off, for the rest of the session. */
      enabled: boolean
      /** Blocks this session. */
      blocked: number
      /** The most recent blocks, newest last. */
      recent: Block[]
    }
  }
}
