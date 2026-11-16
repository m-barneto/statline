import { expect, test } from 'claude-code/testing'

// Fri 6 Nov 2026, 3:00pm local-ish; the 5h window opened 2h ago (3h left).
const NOW = Date.UTC(2026, 10, 6, 20, 0, 0)
const iso = (s: number) => new Date(NOW + s * 1000).toISOString()

const usage = (fivePct: number, weekPct: number) => ({
  startedAt: NOW - 3_600_000,
  context: { tokens: 110_000, window: 1_000_000, percent: 11 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: fivePct, resetsAt: iso(3 * 3600) },
    { kind: 'seven_day', percentUsed: weekPct, resetsAt: iso(2 * 86400) },
  ],
  cost: { usd: 1.23 },
})

const BAND = {
  plugin: 'statline',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false, isCollapsed: false, isWorking: false,
    maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 10 },
  },
} as const

/** Stand in for the engine: no home dir, so no history file. */
function engine(on: Parameters<Parameters<typeof test>[1]>[1], fivePct: number, weekPct: number) {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: usage(fivePct, weekPct) }))
  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
  on('clock.now', () => ({ value: NOW }))
  on('env.get', () => ({ value: undefined }))
  // The engine projects a { key } read off the whole object.
  on('settings.read', () => ({ value: { modelSettings: { 'claude-opus-5-5': { effortLevel: 'medium' } } } }))
  on('ui.log', () => ({ value: {} }))
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
}

test('the band shows model, effort, context and both limits on every surface', async ($, on) => {
  engine(on, 60, 50)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const line = (await ui.find({ type: 'Text', text: /Opus 5\.5/ }))?.text ?? ''
    expect(line).toContain('Opus 5.5')
    expect(line).toContain('●●○○○')          // medium effort from settings
    expect(line).toContain('110k/1M')
    // 60% after 2h of the 5h window -> 30%/h -> ~150% by reset, out in 1h20m.
    expect(line).toContain('~150%')
    await ui.unmount()
  }
})
