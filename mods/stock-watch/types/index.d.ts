/** One ticker being watched. Stored in the plugin's store, shared by every session on the machine. */
export type Watch = {
  sym: string
  low?: number
  high?: number
  /** Which limit already alerted. Cleared when the price is back inside the band, which re-arms it. */
  fired?: 'low' | 'high'
  price?: number
  /** Today's open, the baseline for the up/down colour. Falls back to the previous close when absent. */
  open?: number
  prev?: number
  /** This ticker's chime is off. Its toast still shows. */
  quiet?: boolean
  name?: string
  currency?: string
  /** When the price was last fetched (ms since epoch). */
  at?: number
  /** Why the last fetch failed, if it did. */
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'stock-watch': {
      watches: Watch[]
      muted: boolean
      /** Off: prices are not checked and no alerts or status line. Remembered. */
      enabled: boolean
      /** The last poll: when it ended, and whether one is running now. */
      poll: { isRunning: boolean; at: number }
    }
  }
}
