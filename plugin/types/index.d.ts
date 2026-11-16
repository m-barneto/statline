/** One plan-limit window as the band draws it. Times are epoch seconds. */
export type Limit = {
  pct: number
  /** Projected % by reset at the current pace (past 100 = runs out first). */
  projected: number
  /** When the limit would be hit, or null if it won't be before reset. */
  outAt: number | null
  resetsAt: number | null
}

/** Everything the band and the context nudge read. */
export type Snapshot = {
  model: string
  effort: string | null
  ctxTokens: number | null
  ctxWindow: number
  five: Limit | null
  week: Limit | null
  cost: number | null
  /** When this snapshot was taken (epoch seconds). */
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    statline: { snap: Snapshot | null }
  }
}
