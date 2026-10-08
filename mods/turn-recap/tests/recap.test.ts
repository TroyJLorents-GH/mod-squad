import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { clip, tidy } from '../hooks/register'

const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// Stands in for the engine beneath: core answers turn.complete with the answer itself,
// and the model either answers with `reply`, declines, or (reply === 'throw') refuses.
function world(on: On, reply?: string) {
  const calls: { model: string; prompt: string; system?: string }[] = []
  mock.store(on)
  on('model.complete', ($, e) => {
    calls.push({ model: e.model, prompt: e.prompt, system: e.system })
    if (reply === 'throw') throw new Error('refused')
    return {
      value:
        reply === undefined
          ? { isAnswered: false as const, reason: 'empty-reply' as const, usage }
          : { isAnswered: true as const, text: reply, usage },
    }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return calls
}

const long = 'Here is a long answer. '.repeat(80)
const turn = { answer: long, durationMs: 5000, isAborted: false, turnId: 't1', reason: 'answer' } as const
const cmd = (args: string) =>
  ({ command: 'recap', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } }) as never

describe('turn-recap', () => {
  test('a short, quick answer gets no recap and no model call', async ($, on) => {
    const calls = world(on, 'Short.')
    const r = await $.turn.complete({ ...turn, answer: 'Done.' })
    expect(r.text).toBe('Done.')
    expect(calls.length).toBe(0)
  })

  test('a long answer gets a TL;DR line from Haiku', async ($, on) => {
    const calls = world(on, '**"The fix renames the config key and updates both callers."**')
    const r = await $.turn.complete(turn)
    expect(r.text).toBe('TL;DR: The fix renames the config key and updates both callers.')
    expect(calls.length).toBe(1)
    expect(calls[0]?.model).toBe('claude-haiku-5-5')
    expect(calls[0]?.prompt).toContain('long answer')
  })

  test('a long-running turn is recapped even when the answer is short', async ($, on) => {
    const calls = world(on, 'Tests pass after the migration was rewritten.')
    const r = await $.turn.complete({ ...turn, answer: 'All green now.', durationMs: 120_000 })
    expect(r.text).toBe('TL;DR: Tests pass after the migration was rewritten.')
    expect(calls.length).toBe(1)
  })

  test('thresholds come from the options', { options: { minChars: 10, minSeconds: 1000 } }, async ($, on) => {
    world(on, 'A tiny answer was recapped here.')
    const r = await $.turn.complete({ ...turn, answer: 'Twelve chars' })
    expect(r.text).toBe('TL;DR: A tiny answer was recapped here.')
  })

  test('an unanswered model call leaves the result unchanged', async ($, on) => {
    world(on)
    const r = await $.turn.complete(turn)
    expect(r.text).toBe(long)
  })

  test('a refused model call leaves the result unchanged', async ($, on) => {
    world(on, 'throw')
    const r = await $.turn.complete(turn)
    expect(r.text).toBe(long)
  })

  test('a rambling reply is rejected', async ($, on) => {
    world(on, 'word '.repeat(40))
    const r = await $.turn.complete(turn)
    expect(r.text).toBe(long)
  })

  test('subagent turns are ignored', async ($, on) => {
    const calls = world(on, 'Should not appear in the output.')
    const r = await $.turn.complete({ ...turn, agentId: 'a1' })
    expect(r.text).toBe(long)
    expect(calls.length).toBe(0)
  })

  test('interrupted and errored turns are ignored', async ($, on) => {
    const calls = world(on, 'Should not appear in the output.')
    await $.turn.complete({ ...turn, reason: 'aborted', isAborted: true })
    await $.turn.complete({ ...turn, reason: 'error' })
    expect(calls.length).toBe(0)
  })

  test('/recap off stops recaps; /recap on resumes; bare /recap reports', async ($, on) => {
    const calls = world(on, 'The answer explains the cache layout in detail.')
    expect((await $.command.run(cmd('off'))).text).toContain('off')
    expect((await $.turn.complete(turn)).text).toBe(long)
    expect(calls.length).toBe(0)

    await $.command.run(cmd('on'))
    expect((await $.turn.complete(turn)).text).toBe('TL;DR: The answer explains the cache layout in detail.')

    const status = (await $.command.run(cmd(''))).text
    expect(status).toContain('Turn recap: on')
    expect(status).toContain('Last: TL;DR: The answer explains the cache layout in detail.')
  })

  test('helpers: tidy and clip', async () => {
    expect(tidy('TL;DR: It works. Also more stuff here.')).toBe('It works. Also more stuff here.')
    expect(tidy('The parser now handles nested quotes. Other details follow.')).toBe('The parser now handles nested quotes.')
    expect(tidy('- `Cache` is **warm** now and ready.')).toBe('Cache is warm now and ready.')
    expect(tidy('   ')).toBeNull()
    const c = clip('a'.repeat(5000) + 'b'.repeat(5000))
    expect(c.length).toBeLessThanOrEqual(8000)
    expect(c.startsWith('a')).toBe(true)
    expect(c.endsWith('b')).toBe(true)
  })
})
