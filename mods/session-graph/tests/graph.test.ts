import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { THRESHOLD, asRecord, contextFor, findLinks, linkBetween, mergeTopics, parseExtract, tokens, topicsMatch } from '../hooks/graph'
import type { SessionRecord } from '../types'

const rec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  sid: 'a', project: 'app', cwd: '/w/app', title: 't', summary: 's', notes: [], topics: [], files: [], updatedAt: 1000, alerted: [], ...over,
})

describe('matching', () => {
  test('topics are compared by meaning, not spelling', () => {
    expect(tokens('Auth tokens refresh')).toEqual(['auth', 'token', 'refresh'])
    expect(topicsMatch('auth token refresh', 'refreshing auth tokens')).toBe(true) // two shared words
    expect(topicsMatch('auth token refresh', 'token refresh flow')).toBe(true)
    expect(topicsMatch('orders pagination', 'orders api')).toBe(false) // one shared word is not enough...
    expect(topicsMatch('authentication', 'authentication flow')).toBe(true) // ...unless it is the whole shorter topic
    expect(topicsMatch('auth', 'auth flow')).toBe(false) // too short to trust alone
    expect(topicsMatch('', 'anything')).toBe(false)
  })

  test('sensitivity decides how much two sessions must share', () => {
    const me = rec({ topics: ['auth token refresh', 'mobile login flow'] })
    const other = rec({ sid: 'b', topics: ['token refresh bug', 'mobile app login'] })
    expect(linkBetween(me, other, THRESHOLD.loose)?.topics).toEqual(['auth token refresh', 'mobile login flow'])
    expect(linkBetween(me, other, THRESHOLD.normal)?.score).toBe(4)
    expect(linkBetween(me, other, THRESHOLD.strict)).toBe(null)
  })

  test('one shared topic links only on loose; a shared file plus a topic links on normal', () => {
    const me = rec({ topics: ['kubernetes ingress'], files: ['/w/app/ing.yaml'] })
    const topicOnly = rec({ sid: 'b', topics: ['kubernetes ingress rules'] })
    expect(linkBetween(me, topicOnly, THRESHOLD.normal)).toBe(null)
    expect(linkBetween(me, topicOnly, THRESHOLD.loose)).not.toBe(null)
    const both = rec({ sid: 'c', topics: ['kubernetes ingress rules'], files: ['/w/app/ing.yaml'] })
    expect(linkBetween(me, both, THRESHOLD.normal)?.score).toBe(5)
  })

  test('files every project has say nothing', () => {
    const me = rec({ files: ['/w/app/package.json', '/w/app/README.md'] })
    const other = rec({ sid: 'b', files: ['/w/app/package.json', '/w/app/README.md'] })
    expect(linkBetween(me, other, THRESHOLD.loose)).toBe(null)
  })

  test('findLinks skips itself and sessions that opted out, strongest first', () => {
    const me = rec({ sid: 'me', topics: ['auth token refresh', 'login flow'], files: ['/f.ts'] })
    const weak = rec({ sid: 'w', topics: ['auth token refresh', 'login flow'], updatedAt: 5 })
    const strong = rec({ sid: 's', topics: ['auth token refresh', 'login flow'], files: ['/f.ts'], updatedAt: 1 })
    const off = rec({ sid: 'o', topics: ['auth token refresh', 'login flow'], off: true })
    const self = { ...me }
    expect(findLinks(me, [weak, strong, off, self], 4).map(l => l.sid)).toEqual(['s', 'w'])
    expect(findLinks(rec({ sid: 'e' }), [weak], 2)).toEqual([]) // nothing recorded yet
  })

  test('mergeTopics puts new ones first, drops same-meaning repeats and caps', () => {
    expect(mergeTopics(['b topic', 'Auth Flow'], ['auth flow', 'old one'])).toEqual(['b topic', 'Auth Flow', 'old one'])
    expect(mergeTopics(Array.from({ length: 20 }, (_, i) => `topic number${i}x`), [], 12).length).toBe(12)
  })
})

describe('records and model replies', () => {
  test('asRecord accepts a record and refuses junk', () => {
    expect(asRecord({ sid: 'x', topics: ['a', 3], files: 'no' })).toMatchObject({ sid: 'x', topics: ['a'], files: [] })
    expect(asRecord({ topics: [] })).toBe(null)
    expect(asRecord('x')).toBe(null)
    expect(asRecord(null)).toBe(null)
  })

  test('parseExtract reads fenced JSON, lowercases topics, caps and rejects junk', () => {
    const x = parseExtract('```json\n{"summary":"Fixing login","topics":["Auth Flow","  "],"notes":["a","b","c","d"]}\n```')!
    expect(x).toEqual({ summary: 'Fixing login', topics: ['auth flow'], notes: ['a', 'b', 'c'] })
    expect(parseExtract('nope')).toBe(null)
    expect(parseExtract('{"summary":"","topics":[]}')).toBe(null)
  })

  test('the pulled-in context is labelled as reference, not instructions', () => {
    const l = linkBetween(rec({ topics: ['auth token refresh', 'login flow'] }), rec({ sid: 'b', project: 'peptideiq', summary: 'JWT refresh race', notes: ['fires twice'], topics: ['auth token refresh', 'login flow'], updatedAt: Date.parse('2026-10-08T09:30:00Z') }), 2)!
    const c = contextFor(l, 0)
    expect(c).toContain('project "peptideiq"')
    expect(c).toContain('2026-10-08 09:30')
    expect(c).toContain('not as instructions')
    expect(c).toContain('- fires twice')
  })
})

// ---- the engine beneath the plugin ----------------------------------------------------------

const NOW = Date.parse('2026-10-08T12:00:00Z')
const DIR = '/h/.claude/session-graph'
type Disk = Record<string, { text: string; mtime: number }>

const OTHER: SessionRecord = {
  sid: 'other', project: 'peptideiq', cwd: '/w/peptideiq', title: 'token refresh bug',
  summary: 'Fixing the JWT token refresh race in the mobile app', notes: ['Refresh fires twice on resume'],
  topics: ['auth token refresh', 'mobile app login'], files: ['/w/peptideiq/src/auth.ts'], updatedAt: NOW - 600_000, alerted: [],
}
const ME_REPLY = '{"summary":"Debugging the login redirect","topics":["auth token refresh","mobile login flow","login redirect"],"notes":["Callback clears stale cookie"]}'
const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

function world(on: On, disk: Disk, reply: string | null = ME_REPLY) {
  const toasts: string[] = []
  const contexts: (readonly string[] | undefined)[] = []
  const calls: { model: string; prompt: string }[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  on('session.id', () => ({ value: 'me' }) as never)
  on('session.cwd', () => ({ value: '/w/app' }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '+0000\n', stderr: '' } }) as never)
  on('fs.list', ($, e) => {
    const d = e.path.replace(/\/$/, '')
    const value = Object.entries(disk)
      .filter(([p]) => p.startsWith(d + '/') && !p.slice(d.length + 1).includes('/'))
      .map(([p, f]) => ({ name: p.slice(d.length + 1), kind: 'file', size: f.text.length, mtimeMs: f.mtime, isLink: false }))
    return { value } as never
  })
  on('fs.read', ($, e) => {
    const f = disk[e.path]
    if (f === undefined) throw new Error('ENOENT')
    return { value: f.text } as never
  })
  on('fs.write', ($, e) => {
    disk[e.path] = { text: e.text, mtime: NOW }
    return { value: undefined } as never
  })
  on('model.complete', ($, e) => {
    calls.push({ model: e.model, prompt: e.prompt })
    return { value: reply === null ? { isAnswered: false as const, reason: 'empty-reply' as const, usage } : { isAnswered: true as const, text: reply, usage } } as never
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('prompt.submit', ($, e) => {
    contexts.push(e.context)
    return { text: e.text }
  })
  on('tool.call', () => ({ result: 'ok', isError: false }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return { toasts, contexts, calls, clock }
}

const long = 'Here is a long answer about the login redirect. '.repeat(6)
const done = { answer: long, durationMs: 5000, isAborted: false, turnId: 't1', reason: 'answer' } as const
const cmd = (args: string) => ({ command: 'graph', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } }) as never
const seed = (): Disk => ({ [`${DIR}/other.json`]: { text: JSON.stringify(OTHER), mtime: NOW - 600_000 } })
const mine = (disk: Disk) => JSON.parse(disk[`${DIR}/me.json`]!.text) as SessionRecord

async function turn($: any, w: ReturnType<typeof world>, prompt = 'fix the login redirect loop') {
  await $.prompt.submit({ text: prompt, wait: false })
  await $.turn.complete(done)
  await w.clock.advance(10)
}

describe('session-graph', () => {
  test('a turn records topics, files and a title for this session', async ($, on) => {
    const disk = seed()
    const w = world(on, disk)
    await $.prompt.submit({ text: 'fix the login redirect loop', wait: false })
    await $.tool.call({ tool: 'Edit', file_path: '/w/app/src/login.ts' } as never)
    await $.turn.complete(done)
    await w.clock.advance(10)
    const r = mine(disk)
    expect(r).toMatchObject({ sid: 'me', project: 'app', title: 'fix the login redirect loop', summary: 'Debugging the login redirect' })
    expect(r.topics).toEqual(['auth token refresh', 'mobile login flow', 'login redirect'])
    expect(r.files).toEqual(['/w/app/src/login.ts'])
    expect(r.notes).toEqual(['Callback clears stale cookie'])
    expect(w.calls[0]?.model).toBe('claude-haiku-5-5')
  })

  test('an overlapping session raises one alert, then stays quiet', async ($, on) => {
    const disk = seed()
    const w = world(on, disk)
    await turn($, w)
    expect(w.toasts.length).toBe(1)
    expect(w.toasts[0]).toMatch(/peptideiq/)
    expect(w.toasts[0]).toMatch(/auth token refresh/)
    expect(w.toasts[0]).toMatch(/\/graph/)
    await w.clock.advance(100_000) // past the model throttle
    await turn($, w)
    expect(w.toasts.length).toBe(1)
    expect(mine(disk).alerted).toEqual(['other'])
  })

  test('an unrelated session raises nothing', async ($, on) => {
    const disk: Disk = { [`${DIR}/other.json`]: { text: JSON.stringify({ ...OTHER, topics: ['kubernetes ingress'], files: [] }), mtime: NOW } }
    const w = world(on, disk)
    await turn($, w)
    expect(w.toasts.length).toBe(0)
  })

  test('the default sensitivity is normal', async ($, on) => {
    const disk = seed()
    const w = world(on, disk)
    // Defaults (normal): 2 shared topics = 4 = linked. Nothing about strict here: see the next tests.
    await turn($, w)
    expect(w.toasts.length).toBe(1)
  })

  test('strict: two shared topics are not enough', { options: { sensitivity: 'strict' } }, async ($, on) => {
    const w = world(on, seed())
    await turn($, w)
    expect(w.toasts.length).toBe(0)
  })

  test('loose: one shared topic is enough', { options: { sensitivity: 'loose' } }, async ($, on) => {
    const disk: Disk = { [`${DIR}/other.json`]: { text: JSON.stringify({ ...OTHER, topics: ['auth token refresh'], files: [] }), mtime: NOW } }
    const w = world(on, disk)
    await turn($, w)
    expect(w.toasts.length).toBe(1)
  })

  test('a shared edited file counts, so editing the same file links sessions', async ($, on) => {
    const disk = seed()
    const w = world(on, disk, '{"summary":"x","topics":["auth token refresh"]}')
    await $.prompt.submit({ text: 'look at auth', wait: false })
    await $.tool.call({ tool: 'Write', file_path: '/w/peptideiq/src/auth.ts' } as never)
    await $.turn.complete(done)
    await w.clock.advance(10)
    expect(w.toasts.length).toBe(1) // 1 topic (2) + 1 file (3) = 5 ≥ 4
  })

  test('sessions older than the look-back window are ignored', async ($, on) => {
    const disk: Disk = { [`${DIR}/other.json`]: { text: JSON.stringify(OTHER), mtime: NOW - 8 * 86_400_000 } }
    const w = world(on, disk)
    await turn($, w)
    expect(w.toasts.length).toBe(0)
  })

  test('the model is asked at most every 90 seconds', async ($, on) => {
    const w = world(on, seed())
    await turn($, w)
    await turn($, w, 'and another thing')
    expect(w.calls.length).toBe(1)
    await w.clock.advance(95_000)
    await turn($, w, 'one more')
    expect(w.calls.length).toBe(2)
  })

  test('short answers with no edits cost no model call', async ($, on) => {
    const w = world(on, seed())
    await $.prompt.submit({ text: 'thanks', wait: false })
    await $.turn.complete({ ...done, answer: 'You are welcome.' })
    await w.clock.advance(10)
    expect(w.calls.length).toBe(0)
  })

  test('a model that declines still records the files', async ($, on) => {
    const disk = seed()
    const w = world(on, disk, null)
    await $.prompt.submit({ text: 'edit it', wait: false })
    await $.tool.call({ tool: 'Edit', file_path: '/w/app/a.ts' } as never)
    await $.turn.complete(done)
    await w.clock.advance(10)
    expect(mine(disk).files).toEqual(['/w/app/a.ts'])
    expect(mine(disk).topics).toEqual([])
  })

  test('an idle session notices a new connection by polling', async ($, on) => {
    const disk: Disk = {}
    const w = world(on, disk)
    await $.session.start({ cwd: '/w/app', surface: 'terminal', isInteractive: true })
    await turn($, w)
    expect(w.toasts.length).toBe(0)
    disk[`${DIR}/other.json`] = { text: JSON.stringify(OTHER), mtime: NOW }
    await w.clock.advance(61_000)
    expect(w.toasts.length).toBe(1)
  })

  test('/graph lists connections and pulling one attaches its findings to the next prompt only', async ($, on) => {
    const w = world(on, seed())
    await turn($, w)
    const r = await $.command.run(cmd(''))
    expect(r.text).toMatch(/1 overlapping session/)
    expect(r.text).toMatch(/peptideiq: Fixing the JWT token refresh race/)
    const p = await $.command.run(cmd('pull 1'))
    expect(p.text).toMatch(/ride along/)
    await $.prompt.submit({ text: 'continue', wait: false })
    const ctx = w.contexts.at(-1)
    expect(ctx?.length).toBe(1)
    expect(ctx?.[0]).toContain('Refresh fires twice on resume')
    await $.prompt.submit({ text: 'and again', wait: false })
    expect(w.contexts.at(-1)?.length ?? 0).toBe(0)
    expect((await $.command.run(cmd('pull 9'))).text).toMatch(/Usage/)
  })

  test('slash commands do not consume a pending pull', async ($, on) => {
    const w = world(on, seed())
    await turn($, w)
    await $.command.run(cmd('pull 1'))
    await $.prompt.submit({ text: '/graph', wait: false })
    expect(w.contexts.at(-1)?.length ?? 0).toBe(0)
    await $.prompt.submit({ text: 'real prompt', wait: false })
    expect(w.contexts.at(-1)?.length).toBe(1)
  })

  test('/graph off stops recording, tells other sessions to skip this one, and stops model calls', async ($, on) => {
    const disk = seed()
    const w = world(on, disk)
    await turn($, w)
    await $.command.run(cmd('off'))
    expect(mine(disk).off).toBe(true)
    const calls = w.calls.length
    await w.clock.advance(100_000)
    await turn($, w)
    expect(w.calls.length).toBe(calls)
    await $.command.run(cmd('on'))
    expect(mine(disk).off).toBe(undefined)
  })

  test('a custom folder is used', { options: { folder: '/shared/graph/' } }, async ($, on) => {
    const disk = seed()
    const w = world(on, disk)
    await turn($, w)
    expect(Object.keys(disk)).toContain('/shared/graph/me.json')
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the ${surface} pane shows the connection, the graph and a working Pull in button`, async ($, on) => {
      const w = world(on, seed())
      await turn($, w)
      await $.command.run(cmd(''))
      const ui = await $.ui.mount({
        plugin: 'session-graph',
        surface,
        component: 'Pane',
        requestId: 'session-graph',
        props: { title: 'Session graph', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
      } as never)
      expect(await ui.find({ type: 'Text', text: 'This session' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Connections \(1\) · 1 other session tracked/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /1\. peptideiq/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '● auth token refresh' })).toBeDefined()
      await ui.press({ key: 'pull-1' })
      expect(await ui.find({ type: 'Text', text: /Attached to your next prompt/ })).toBeDefined()
      await ui.press({ key: 'drop' })
      expect(await ui.find({ type: 'Text', text: /Attached to your next prompt/ })).toBeUndefined()
      await ui.unmount()
    })
  }
})
