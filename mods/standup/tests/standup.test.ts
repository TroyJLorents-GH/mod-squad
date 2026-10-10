import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { digestText, fallbackSummary, parseSummary, renderMarkdown } from '../hooks/digest'
import { commitMessage, dayKey, dayStart, parseSession, shortProject } from '../hooks/transcripts'

// ---- synthetic transcript lines -------------------------------------------------------------

const DAY = '2026-10-08'
const line = (o: Record<string, unknown>) => JSON.stringify(o)
const user = (sid: string, cwd: string, ts: string, text: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: 'user', sessionId: sid, cwd, timestamp: ts, message: { role: 'user', content: text }, ...extra })
const assistant = (sid: string, cwd: string, ts: string, content: unknown[]) =>
  line({ type: 'assistant', sessionId: sid, cwd, timestamp: ts, message: { role: 'assistant', content } })
const text = (t: string) => ({ type: 'text', text: t })
const edit = (f: string) => ({ type: 'tool_use', id: 'e', name: 'Edit', input: { file_path: f } })
const bash = (c: string) => ({ type: 'tool_use', id: 'b', name: 'Bash', input: { command: c } })
const jsonl = (...ls: string[]) => ls.join('\n') + '\n'

const WEB = '/work/acme/webapp'
const API = '/work/acme/api'

const webSession = () =>
  jsonl(
    user('s1', WEB, '2026-10-08T09:00:00Z', 'fix the login redirect loop'),
    assistant('s1', WEB, '2026-10-08T09:01:00Z', [edit(`${WEB}/src/login.ts`), bash('git commit -m "Fix login redirect loop"')]),
    assistant('s1', WEB, '2026-10-08T09:02:00Z', [text('Fixed: the callback now clears the stale cookie.')]),
    user('s1', WEB, '2026-10-07T23:00:00Z', 'yesterday only'),
  )
const apiSession = () =>
  jsonl(
    user('s2', API, '2026-10-08T10:00:00Z', 'add pagination to /orders'),
    assistant('s2', API, '2026-10-08T10:05:00Z', [edit(`${API}/orders.py`), edit(`${API}/tests/test_orders.py`)]),
  )

describe('transcript parsing', () => {
  test('keeps one local day: prompts, files (relative), commits, last answer', () => {
    const d = parseSession(webSession(), DAY, 0)!
    expect(d.sid).toBe('s1')
    expect(d.project).toBe('webapp')
    expect(d.prompts).toEqual(['fix the login redirect loop'])
    expect(d.files).toEqual(['src/login.ts'])
    expect(d.commits).toEqual(['Fix login redirect loop'])
    expect(d.commands).toBe(1)
    expect(d.answer).toContain('stale cookie')
  })

  test('a different day, harness rows, tool results and sidechains do not count', () => {
    const t = jsonl(
      user('s', WEB, '2026-10-08T09:00:00Z', '<command-name>/clear</command-name>'),
      user('s', WEB, '2026-10-08T09:00:01Z', [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]),
      user('s', WEB, '2026-10-08T09:00:02Z', 'real', { isSidechain: true }),
      user('s', WEB, '2026-10-08T09:00:03Z', 'meta', { isMeta: true }),
      user('s', WEB, '2026-10-09T09:00:00Z', 'tomorrow'),
    )
    expect(parseSession(t, DAY, 0)).toBe(null)
  })

  test('typed text inside a block-array message counts', () => {
    const t = jsonl(user('s', WEB, '2026-10-08T09:00:00Z', [{ type: 'text', text: 'hello there' }]))
    expect(parseSession(t, DAY, 0)!.prompts).toEqual(['hello there'])
  })

  test('the day follows the timezone', () => {
    const t = jsonl(user('s', WEB, '2026-10-08T23:30:00Z', 'late'))
    expect(parseSession(t, DAY, 0)).not.toBe(null)
    expect(parseSession(t, DAY, 120)).toBe(null) // 01:30 on the 9th in UTC+2
    expect(parseSession(t, '2026-10-09', 120)).not.toBe(null)
    expect(dayKey(Date.parse('2026-10-08T23:30:00Z'), -300)).toBe(DAY)
    expect(dayStart(DAY, 120)).toBe(Date.parse('2026-10-07T22:00:00Z'))
  })

  test('a cut first line (tail read) is ignored', () => {
    const t = `ssage":{"x":1}}\n${user('s', WEB, '2026-10-08T09:00:00Z', 'ok')}\n`
    expect(parseSession(t, DAY, 0)!.prompts).toEqual(['ok'])
  })

  test('commit messages: quoted, single-quoted and heredoc', () => {
    expect(commitMessage('git commit -m "Add thing" && git push')).toBe('Add thing')
    expect(commitMessage("git commit -am 'Tidy up'")).toBe(null) // -am is not -m: no message found
    expect(commitMessage("git add . && git commit -m 'Tidy up'")).toBe('Tidy up')
    expect(commitMessage("git commit -m \"$(cat <<'EOF'\nAdd the router\n\nbody\nEOF\n)\"")).toBe('Add the router')
    expect(commitMessage('npm test')).toBe(null)
  })

  test('project names come from the last folder, either slash style', () => {
    expect(shortProject('/a/b/app')).toBe('app')
    expect(shortProject('C:\\work\\api\\')).toBe('api')
  })
})

describe('digest and markdown', () => {
  test('the digest carries requests, commits, files and the closing message', () => {
    const t = digestText(parseSession(webSession(), DAY, 0)!, 0)
    for (const part of ['Project: webapp', 'fix the login redirect loop', 'Fix login redirect loop', 'src/login.ts', 'stale cookie', '09:00-09:02']) {
      expect(t).toContain(part)
    }
  })

  test('parseSummary reads fenced JSON, trims, caps and rejects junk', () => {
    const s = parseSummary('```json\n{"title":"Login fix","done":["Fixed redirect loop"," "],"open":["Add test"]}\n```')!
    expect(s).toEqual({ title: 'Login fix', done: ['Fixed redirect loop'], open: ['Add test'] })
    expect(parseSummary('no json here')).toBe(null)
    expect(parseSummary('{"title":"","done":[],"open":[]}')).toBe(null)
    expect(parseSummary('{"done":["a","b","c","d","e","f","g"]}')!.done.length).toBe(5)
  })

  test('fallback prefers commits, then files, then the goal', () => {
    const web = parseSession(webSession(), DAY, 0)!
    expect(fallbackSummary(web).done).toEqual(['Fix login redirect loop'])
    const api = parseSession(apiSession(), DAY, 0)!
    expect(fallbackSummary(api).done).toEqual(['Edited 2 files: orders.py, test_orders.py'])
    const none = { ...api, files: [], commits: [] }
    expect(fallbackSummary(none).open).toEqual(['add pagination to /orders'])
  })

  test('markdown groups by project, merges sessions and drops repeats', () => {
    const a = parseSession(webSession(), DAY, 0)!
    const b = { ...a, sid: 's3', commits: [] }
    const md = renderMarkdown(DAY, [
      { d: a, s: { title: 't', done: ['Fixed redirect loop', 'Added tests'], open: ['Ship it'] }, isModel: true },
      { d: b, s: { title: 't', done: ['fixed redirect loop'], open: [] }, isModel: true },
    ])
    expect(md).toContain('# Standup · 2026-10-08')
    expect(md.match(/## webapp/g)?.length).toBe(1)
    expect(md.match(/edirect loop/g)?.length).toBe(1)
    expect(md).toContain('- Added tests')
    expect(md).toContain('**Open**')
    expect(md).toContain('2 sessions · 1 file changed · 1 commit')
  })

  test('an empty day says so', () => {
    expect(renderMarkdown(DAY, [])).toContain('no Claude Code activity')
  })
})

// ---- the engine beneath the plugin ----------------------------------------------------------

type Replies = Record<string, string | null>

function world(
  on: On,
  files: Record<string, { text: string; mtime: number; size?: number }>,
  replies: Replies = {},
  run: (argv: string[]) => string = () => '+0000\n',
) {
  const now = '2026-10-08T12:00:00Z'
  const written: Record<string, string> = {}
  const modelCalls: { model: string; prompt: string }[] = []
  const toasts: string[] = []
  const clock = mock.clock(on, { now: Date.parse(now) })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  on('process.run', ($, e) => ({ value: { exitCode: 0, stdout: run((e as { argv: string[] }).argv), stderr: '' } }) as never)
  on('fs.list', ($, e) => {
    const dir = e.path.replace(/\/$/, '')
    const names = new Map<string, 'dir' | { text: string; mtime: number; size?: number }>()
    for (const [path, f] of Object.entries(files)) {
      if (!path.startsWith(dir + '/')) continue
      const [head = '', ...more] = path.slice(dir.length + 1).split('/')
      names.set(head, more.length > 0 ? 'dir' : f)
    }
    const value = [...names].map(([name, f]) =>
      f === 'dir'
        ? { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
        : { name, kind: 'file', size: f.size ?? f.text.length, mtimeMs: f.mtime, isLink: false },
    )
    return { value } as never
  })
  on('fs.read', ($, e) => {
    const f = files[e.path]
    if (f === undefined) throw new Error('ENOENT')
    return { value: f.text } as never
  })
  on('fs.write', ($, e) => {
    written[e.path] = e.text
    return { value: undefined } as never
  })
  on('model.complete', ($, e) => {
    modelCalls.push({ model: e.model, prompt: e.prompt })
    const key = Object.keys(replies).find(k => e.prompt.includes(k))
    const reply = key === undefined ? null : replies[key]
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return {
      value: reply === null || reply === undefined ? { isAnswered: false as const, reason: 'empty-reply' as const, usage } : { isAnswered: true as const, text: reply, usage },
    } as never
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  return { clock, written, modelCalls, toasts }
}

const MAIN = '/h/.claude/projects/-work-acme-webapp/s1.jsonl'
const OTHER = '/h/.claude/projects/-work-acme-api/s2.jsonl'
const SUBAGENT = '/h/.claude/projects/-work-acme-webapp/s1/subagents/agent-1.jsonl'

const WEB_REPLY = '{"title":"Login fix","done":["Fixed login redirect loop"],"open":["Add a regression test"]}'
const API_REPLY = '{"title":"Orders paging","done":["Added pagination to /orders"],"open":[]}'
const replies = { 'fix the login redirect loop': WEB_REPLY, 'add pagination': API_REPLY }
const files = () => ({
  [MAIN]: { text: webSession(), mtime: Date.parse('2026-10-08T09:02:00Z') },
  [OTHER]: { text: apiSession(), mtime: Date.parse('2026-10-08T10:05:00Z') },
  [SUBAGENT]: { text: webSession(), mtime: Date.parse('2026-10-08T09:02:00Z') },
})
const cmd = (args: string) =>
  ({ command: 'standup', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } }) as never

describe('standup', () => {
  test('/standup today writes one section per project and saves the file', async ($, on) => {
    const w = world(on, files(), replies)
    await $.command.run(cmd('today'))
    await w.clock.advance(10)
    const md = w.written['/h/standups/2026-10-08.md']!
    expect(md).toContain('## webapp')
    expect(md).toContain('- Fixed login redirect loop')
    expect(md).toContain('- Add a regression test')
    expect(md).toContain('## api')
    expect(md).toContain('- Added pagination to /orders')
    expect(w.modelCalls.length).toBe(2) // the subagent transcript is not a third session
    expect(w.modelCalls.every(c => c.model === 'claude-haiku-5-5')).toBe(true)
    expect(w.toasts.some(t => /2 sessions, 2 projects, saved to \/h\/standups\/2026-10-08\.md/.test(t))).toBe(true)
  })

  test('a second run reuses the cached summaries', async ($, on) => {
    const w = world(on, files(), replies)
    await $.command.run(cmd('today'))
    await w.clock.advance(10)
    await $.command.run(cmd('today'))
    await w.clock.advance(10)
    expect(w.modelCalls.length).toBe(2)
  })

  test('a model that declines falls back to commits and files', async ($, on) => {
    const w = world(on, files(), {})
    await $.command.run(cmd('today'))
    await w.clock.advance(10)
    const md = w.written['/h/standups/2026-10-08.md']!
    expect(md).toContain('- Fix login redirect loop')
    expect(md).toContain('- Edited 2 files: orders.py, test_orders.py')
  })

  test('yesterday and explicit dates pick their own day', async ($, on) => {
    const w = world(on, files(), replies)
    await $.command.run(cmd('yesterday'))
    await w.clock.advance(10)
    expect(w.written['/h/standups/2026-10-07.md']).toContain('yesterday only')
    await $.command.run(cmd('2026-10-08'))
    await w.clock.advance(10)
    expect(w.written['/h/standups/2026-10-08.md']).toContain('## webapp')
  })

  test('a day with no activity reports so', async ($, on) => {
    const w = world(on, files(), replies)
    await $.command.run(cmd('2026-09-01'))
    await w.clock.advance(10)
    expect(w.written['/h/standups/2026-09-01.md']).toContain('no Claude Code activity')
  })

  test('the model and folder come from the options; off saves nothing', { options: { model: 'claude-sonnet-5-5', folder: 'off' } }, async ($, on) => {
    const w = world(on, files(), replies)
    await $.command.run(cmd('today'))
    await w.clock.advance(10)
    expect(w.modelCalls.every(c => c.model === 'claude-sonnet-5-5')).toBe(true)
    expect(Object.keys(w.written).length).toBe(0)
    expect(w.toasts.some(t => /2 sessions/.test(t) && !/saved/.test(t))).toBe(true)
  })

  test('a custom folder is used', { options: { folder: '/notes/daily/' } }, async ($, on) => {
    const w = world(on, files(), replies)
    await $.command.run(cmd('today'))
    await w.clock.advance(10)
    expect(Object.keys(w.written)).toEqual(['/notes/daily/2026-10-08.md'])
  })

  test('maxSessions keeps the most recently active', { options: { maxSessions: 1 } }, async ($, on) => {
    const w = world(on, files(), replies)
    await $.command.run(cmd('today'))
    await w.clock.advance(10)
    const md = w.written['/h/standups/2026-10-08.md']!
    expect(md).toContain('## api')
    expect(md).not.toContain('## webapp')
  })

  test('a bad day word fails in the pane, not with a crash', async ($, on) => {
    const w = world(on, files(), replies)
    await $.command.run(cmd('someday'))
    await w.clock.advance(10)
    expect(Object.keys(w.written).length).toBe(0)
  })

  test('files over 4 MiB are read from their tail through the shell', async ($, on) => {
    const big = { ...files(), [MAIN]: { text: webSession(), mtime: Date.parse('2026-10-08T09:02:00Z'), size: 5_000_000 } }
    let tailed = false
    const w = world(on, big, replies, argv => {
      if (argv[0] !== 'sh') return '+0000\n'
      tailed = true
      return big[argv[5] as keyof typeof big]!.text
    })
    await $.command.run(cmd('today'))
    await w.clock.advance(10)
    expect(tailed).toBe(true)
    expect(w.written['/h/standups/2026-10-08.md']).toContain('## webapp')
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the ${surface} pane shows the standup and its buttons work`, async ($, on) => {
      const w = world(on, files(), replies)
      await $.command.run(cmd(''))
      const ui = await $.ui.mount({
        plugin: 'standup',
        surface,
        component: 'Pane',
        requestId: 'standup',
        props: { title: 'Standup', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
      } as never)
      expect(await ui.find({ type: 'Text', text: /Pick a day/ })).toBeDefined()
      await ui.press({ key: 'gen' })
      await w.clock.advance(10)
      expect(await ui.find({ type: 'Markdown', props: { text: /## webapp/ } } as never)).toBeDefined()
      expect(await ui.find({ type: 'Markdown', props: { text: /## api/ } } as never)).toBeDefined()
      await ui.press({ key: 'yday' })
      await ui.press({ key: 'gen' })
      await w.clock.advance(10)
      expect(await ui.find({ type: 'Markdown', props: { text: /Standup · 2026-10-07/ } } as never)).toBeDefined()
      await ui.unmount()
    })
  }
})
