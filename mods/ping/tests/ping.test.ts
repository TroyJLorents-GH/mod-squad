import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { formatDuration } from '../hooks/register'

// Stands in for the engine beneath ping: records each sound played and toast raised.
function world(on: On, opts: { audioFails?: boolean; now?: number } = {}) {
  const played: string[] = []
  const toasts: string[] = []
  const clock = mock.clock(on, { now: opts.now ?? 1_000_000 })
  mock.store(on)
  on('audio.play', ($, e) => {
    if (opts.audioFails) return { deny: 'no audio player on this surface' }
    played.push('asset' in e.clip && e.clip.asset !== undefined ? e.clip.asset : '?')
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return { played, toasts, clock }
}

const turn = { answer: 'all done', turnId: 't1', isAborted: false } as const
const cmd = (args: string) =>
  ({ command: 'ping', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } }) as never

describe('ping', () => {
  test('a short turn makes no noise', async ($, on) => {
    const w = world(on)
    const r = await $.turn.complete({ ...turn, reason: 'answer', durationMs: 5_000 })
    expect(r.text).toBe('all done')
    expect(w.played).toEqual([])
    expect(w.toasts).toEqual([])
  })

  test('a long answer chimes done.wav and toasts the time', async ($, on) => {
    const w = world(on)
    const r = await $.turn.complete({ ...turn, reason: 'answer', durationMs: 134_000 })
    expect(r.text).toBe('all done')
    expect(w.played).toEqual(['sounds/done.wav'])
    expect(w.toasts).toEqual(['✔ Done in 2m 14s'])
  })

  test('an error plays error.wav', async ($, on) => {
    const w = world(on)
    await $.turn.complete({ ...turn, reason: 'error', durationMs: 63_000 })
    expect(w.played).toEqual(['sounds/error.wav'])
    expect(w.toasts).toEqual(['✖ Turn ended: error after 1m 3s'])
  })

  test('a refusal plays error.wav', async ($, on) => {
    const w = world(on)
    await $.turn.complete({ ...turn, reason: 'refusal', refusal: { category: null, explanation: null }, durationMs: 40_000 } as never)
    expect(w.played).toEqual(['sounds/error.wav'])
  })

  test('an aborted turn stays quiet', async ($, on) => {
    const w = world(on)
    await $.turn.complete({ ...turn, reason: 'aborted', isAborted: true, durationMs: 300_000 })
    expect(w.played).toEqual([])
    expect(w.toasts).toEqual([])
  })

  test("a subagent's turn stays quiet", async ($, on) => {
    const w = world(on)
    await $.turn.complete({ ...turn, reason: 'answer', durationMs: 300_000, agentId: 'a1' })
    expect(w.played).toEqual([])
  })

  test('/ping off silences it, /ping on brings it back', async ($, on) => {
    const w = world(on)
    expect((await $.command.run(cmd('off'))).text).toContain('off')
    await $.turn.complete({ ...turn, reason: 'answer', durationMs: 60_000 })
    expect(w.played).toEqual([])
    expect((await $.command.run(cmd(''))).text).toContain('Ping: off')
    await $.command.run(cmd('on'))
    await $.turn.complete({ ...turn, reason: 'answer', durationMs: 60_000 })
    expect(w.played).toEqual(['sounds/done.wav'])
  })

  test('/ping test plays done.wav', async ($, on) => {
    const w = world(on)
    await $.command.run(cmd('test'))
    expect(w.played).toEqual(['sounds/done.wav'])
  })

  test('sound: false shows the toast only', { options: { sound: false } }, async ($, on) => {
    const w = world(on)
    await $.turn.complete({ ...turn, reason: 'answer', durationMs: 60_000 })
    expect(w.played).toEqual([])
    expect(w.toasts).toEqual(['✔ Done in 1m 0s'])
  })

  test('minSeconds raises the bar', { options: { minSeconds: 120 } }, async ($, on) => {
    const w = world(on)
    await $.turn.complete({ ...turn, reason: 'answer', durationMs: 90_000 })
    expect(w.played).toEqual([])
  })

  test('audio that cannot play falls back to the toast and never throws', async ($, on) => {
    const w = world(on, { audioFails: true })
    const r = await $.turn.complete({ ...turn, reason: 'answer', durationMs: 60_000 })
    expect(r.text).toBe('all done')
    expect(w.toasts).toEqual(['✔ Done in 1m 0s'])
  })

  test('an approval ask late in a long turn plays attention.wav', async ($, on) => {
    const w = world(on)
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('tool.check', () => ({ decision: 'ask' as const }))
    await $.turn.start({ text: 'deploy', turnId: 't1' })
    const early = await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'u1' } as never)
    expect(early.decision).toBe('ask')
    expect(w.played).toEqual([])
    await w.clock.advance(45_000)
    await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'u2' } as never)
    expect(w.played).toEqual(['sounds/attention.wav'])
    expect(w.toasts[0]).toContain('Waiting for your approval (Bash)')
  })

  test('formatDuration', async () => {
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(134_000)).toBe('2m 14s')
    expect(formatDuration(3_780_000)).toBe('1h 3m')
  })
})
