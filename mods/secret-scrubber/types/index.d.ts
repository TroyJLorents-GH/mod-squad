/** Secrets redacted this session, by kind. */
export type Counts = Record<string, number>

declare module 'claude-code' {
  interface PluginState {
    'secret-scrubber': {
      /** False after `/scrub off`, for the rest of the session. */
      enabled: boolean
      /** Secrets redacted this session, by kind (`github-token`, `jwt`, ...). */
      counts: Counts
    }
  }
}

