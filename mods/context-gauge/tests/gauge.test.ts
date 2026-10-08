import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { GREEN, ORANGE, RED, barWidth, colorFor, crossed, formatTokens, segments, thresholds, warnLevel } from '../hooks/gauge'

const composer = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } }

// Stands in for the engine beneath the gauge: `$.session.usage()` answers whatever `fill` holds,
// and every toast is recorded.
function world(on: On, fill: { tokens?: number; window: number; percent?: number }) {
  const toasts: string[] = []
  mock.store(on)
  on('session.usage', () => ({ value: { context: { ...fill }, rateLimits: [] } }) as never)
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  // The engine's own band beneath the plugin: an empty Box stands for "nothing drawn".
  on('ui.render', ($, e) => ({ type: 'Box', props: {}, children: [] }) as never)
  return toasts
}

const turnDone = { turnId: 't1', answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' } as const

async function band($: Parameters<Parameters<typeof test>[1]>[0], surface: 'terminal' | 'desktop', bodyColumns = 80) {
  return $.ui.mount({
    plugin: 'context-gauge',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns },
  } as never)
}

describe('context-gauge helpers', () => {
  test('formats token counts', async () => {
    expect(formatTokens(620_000)).toBe('620k')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_500_000)).toBe('1.5M')
    expect(formatTokens(200_000)).toBe('200k')
    expect(formatTokens(12_345)).toBe('12.3k')
    expect(formatTokens(950)).toBe('950')
  })

  test('colours green → orange → red', async () => {
    expect(colorFor(10, 80)).toBe(GREEN)
    expect(colorFor(62, 80)).toBe(ORANGE)
    expect(colorFor(80, 80)).toBe(RED)
    expect(colorFor(45, 40)).toBe(RED)
  })

  test('sizes and shades the bar', async () => {
    expect(barWidth(80, 30)).toBe(40)
    expect(barWidth(50, 30)).toBe(18)
    expect(barWidth(34, 30)).toBe(0)
    const segs = segments(62, 16, 80)
    expect(segs.map(s => s.text).join('')).toBe('██████████░░░░░░')
    expect(segs.map(s => s.color)).toEqual([GREEN, ORANGE, null])
    expect(segments(100, 10, 80).map(s => s.color)).toEqual([GREEN, ORANGE, RED])
    expect(segments(0, 5, 80)).toEqual([{ text: '░░░░░', color: null }])
  })

  test('thresholds fire once per crossing and re-arm after a drop', async () => {
    expect(thresholds(80)).toEqual([80, 90])
    expect(thresholds(95)).toEqual([90, 95])
    expect(crossed(70, 79, 80)).toBe(null)
    expect(crossed(70, 81, 80)).toBe(80)
    expect(crossed(81, 85, 80)).toBe(null)
    expect(crossed(85, 91, 80)).toBe(90)
    expect(crossed(null, 92, 80)).toBe(90)
    expect(crossed(30, 82, 80)).toBe(80)
    expect(warnLevel(undefined)).toBe(80)
    expect(warnLevel('70')).toBe(70)
    expect(warnLevel(-1)).toBe(80)
  })
})

describe('context-gauge engine', () => {
  test('draws nothing before the first reading', async ($, on) => {
    world(on, { window: 1_000_000 })
    await $.turn.complete(turnDone)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await band($, surface)
      expect(await ui.findAll({ type: 'Text', text: /context/ })).toHaveLength(0)
      await ui.unmount()
    }
  })

  test('draws the band after a turn, on terminal and desktop', async ($, on) => {
    world(on, { tokens: 620_000, window: 1_000_000, percent: 62 })
    await $.turn.complete(turnDone)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await band($, surface, 60)
      expect(await ui.find({ type: 'Text', text: 'context ' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: ' 62%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: ' · 620k / 1M' })).toBeDefined()
      expect(await ui.findAll({ type: 'Text', text: /compact soon/ })).toHaveLength(0)
      await ui.unmount()
    }
  })

  test('warns at 80% with a hint and one toast, then again at 90%', async ($, on) => {
    const fill: { tokens?: number; window: number; percent?: number } = { tokens: 820_000, window: 1_000_000, percent: 82 }
    const toasts = world(on, fill)
    await $.turn.complete(turnDone)
    await $.turn.complete(turnDone)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatch(/82% full/)

    const ui = await band($, 'terminal')
    expect(await ui.find({ type: 'Text', text: ' · /compact soon' })).toBeDefined()
    await ui.unmount()

    fill.tokens = 910_000
    fill.percent = 91
    await $.turn.complete(turnDone)
    await $.turn.complete(turnDone)
    expect(toasts).toHaveLength(2)
    expect(toasts[1]).toMatch(/91% full/)
  })

  test('respects warnAt from options', { options: { warnAt: 60 } }, async ($, on) => {
    const toasts = world(on, { tokens: 620_000, window: 1_000_000, percent: 62 })
    await $.turn.complete(turnDone)
    expect(toasts).toHaveLength(1)
  })

  test('/gauge reports numbers and /gauge hide hides the band', async ($, on) => {
    world(on, { tokens: 150_000, window: 200_000, percent: 75 })
    const shown = await $.command.run({ command: 'gauge', args: '', ...composer } as never)
    expect((shown as { text: string }).text).toMatch(/75% used · 150k of 200k/)

    await $.command.run({ command: 'gauge', args: 'hide', ...composer } as never)
    const ui = await band($, 'terminal')
    expect(await ui.findAll({ type: 'Text', text: /context/ })).toHaveLength(0)
    await ui.unmount()

    await $.command.run({ command: 'gauge', args: 'toggle', ...composer } as never)
    const ui2 = await band($, 'desktop')
    expect(await ui2.find({ type: 'Text', text: ' 75%' })).toBeDefined()
    await ui2.unmount()
  })

  test('a pushed session.measure updates the band without a turn', async ($, on) => {
    const toasts = world(on, { window: 200_000 })
    on('session.measure', ($, e) => ({ changed: e.changed }))
    await $.session.measure({ context: { tokens: 184_000, window: 200_000, percent: 92 }, rateLimits: [], changed: ['context'] })
    expect(toasts).toHaveLength(1)
    const ui = await band($, 'desktop')
    expect(await ui.find({ type: 'Text', text: ' 92%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' · 184k / 200k' })).toBeDefined()
    await ui.unmount()
  })

  test('yields to a survey', async ($, on) => {
    world(on, { tokens: 500_000, window: 1_000_000, percent: 50 })
    await $.turn.complete(turnDone)
    const ui = await $.ui.mount({
      plugin: 'context-gauge',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: true, isWorking: false, maxRows: 10, bodyColumns: 80 },
    } as never)
    expect(await ui.findAll({ type: 'Text', text: /context/ })).toHaveLength(0)
    await ui.unmount()
  })
})
