import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { aggregate, rangeStart } from '../hooks/aggregate'
import { classify, freshSignals, isTestRun, keywordOf } from '../hooks/classify'
import { bar, dailyRowsFor, fmtCost, fmtTokens, layout } from '../hooks/layout'
import { dayKey, emptyFile, mcpServer, parseText, shellCommand, usageOf } from '../hooks/parse'
import { costOf, modelLabel, priceOf } from '../hooks/pricing'

// ---- synthetic transcript lines -------------------------------------------------------------

const SID = 'sess-1'
const CWD = '/work/acme/webapp'

function user(text: string, ts: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ type: 'user', sessionId: SID, cwd: CWD, timestamp: ts, message: { role: 'user', content: text }, ...extra })
}

function toolResult(ts: string) {
  return JSON.stringify({
    type: 'user',
    sessionId: SID,
    cwd: CWD,
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
  })
}

type U = { input?: number; output?: number; read?: number; w5?: number; w1?: number }

function assistant(id: string, model: string, ts: string, u: U, content: unknown[] = [{ type: 'text', text: 'ok' }]) {
  const w5 = u.w5 ?? 0
  const w1 = u.w1 ?? 0
  return JSON.stringify({
    type: 'assistant',
    sessionId: SID,
    cwd: CWD,
    timestamp: ts,
    requestId: `req-${id}`,
    message: {
      id,
      model,
      role: 'assistant',
      content,
      usage: {
        input_tokens: u.input ?? 0,
        output_tokens: u.output ?? 0,
        cache_read_input_tokens: u.read ?? 0,
        cache_creation_input_tokens: w5 + w1,
        cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 },
      },
    },
  })
}

function bash(id: string, command: string) {
  return { type: 'tool_use', id, name: 'Bash', input: { command } }
}

function close(a: number | undefined, b: number, digits = 9) {
  expect(Math.abs((a ?? NaN) - b) < 10 ** -digits).toBe(true)
}

const jsonl = (...lines: string[]) => lines.join('\n') + '\n'

// ---- the engine beneath the plugin ----------------------------------------------------------

/** `size` overrides the listed size (to push a file onto the chunked-read path). */
type FakeFile = { text: string; mtime: number; size?: number }

/** HOME=/h, files under /h/.claude/projects, and a count of reads per path. */
function world(on: On, files: Record<string, FakeFile>, now = Date.parse('2026-10-08T12:00:00Z')) {
  const reads: Record<string, number> = {}
  const statuses: (string | undefined)[] = []
  const clock = mock.clock(on, { now })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  const chunks: string[] = []
  // `date +%z`, and the `tail -c +N file | head -c M` pipeline used for files over 4 MiB.
  on('process.run', ($, e) => {
    const argv = (e as { argv: string[] }).argv
    if (argv[0] === 'sh') {
      const from = Number(argv[4]) - 1
      const path = argv[5] ?? ''
      chunks.push(path)
      const bytes = new TextEncoder().encode(files[path]?.text ?? '')
      const out = bytes.slice(from, from + Number(argv[6]))
      return { value: { exitCode: 0, stdout: new TextDecoder().decode(out), stderr: '' } } as never
    }
    return { value: { exitCode: 0, stdout: '+0000\n', stderr: '' } } as never
  })
  on('fs.list', ($, e) => {
    const dir = e.path.replace(/\/$/, '')
    const names = new Map<string, FakeFile | 'dir'>()
    for (const [path, f] of Object.entries(files)) {
      if (!path.startsWith(dir + '/')) continue
      const rest = path.slice(dir.length + 1)
      const [head = '', ...more] = rest.split('/')
      names.set(head, more.length > 0 ? 'dir' : f)
    }
    if (names.size === 0) return { value: [] } as never
    const value = [...names].map(([name, f]) =>
      f === 'dir'
        ? { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
        : { name, kind: 'file', size: f.size ?? new TextEncoder().encode(f.text).length, mtimeMs: f.mtime, isLink: false },
    )
    return { value } as never
  })
  on('fs.read', ($, e) => {
    reads[e.path] = (reads[e.path] ?? 0) + 1
    const f = files[e.path]
    if (f === undefined) throw new Error('ENOENT')
    return { value: f.text } as never
  })
  on('ui.status', ($, e) => {
    statuses.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return { clock, reads, statuses, chunks }
}

const composer = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } }

async function burn($: Parameters<Parameters<typeof test>[1]>[0], args = '') {
  return $.command.run({ command: 'burn', args, ...composer } as never)
}

function pane($: Parameters<Parameters<typeof test>[1]>[0], surface: 'terminal' | 'desktop', bodyColumns = 120, bodyRows = 40) {
  return $.ui.mount({
    plugin: 'burn-rate',
    surface,
    component: 'Pane',
    requestId: 'burn-rate',
    props: { title: 'burn-rate', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} },
  } as never)
}

const MAIN = '/h/.claude/projects/-work-acme-webapp/sess-1.jsonl'
const SUB = '/h/.claude/projects/-work-acme-webapp/sess-1/subagents/agent-a1.jsonl'

const fixture = () =>
  jsonl(
    user('fix the failing login test', '2026-10-08T09:00:00Z'),
    // One response streamed as three lines; the last carries the final output count.
    assistant('msg_1', 'claude-opus-5-5', '2026-10-08T09:00:01Z', { input: 1000, output: 10, w5: 2000 }, [{ type: 'thinking', thinking: '' }]),
    assistant('msg_1', 'claude-opus-5-5', '2026-10-08T09:00:02Z', { input: 1000, output: 10, w5: 2000 }, [bash('tu_1', 'cd /work/acme && npm test')]),
    assistant('msg_1', 'claude-opus-5-5', '2026-10-08T09:00:03Z', { input: 1000, output: 500, w5: 2000 }, [
      { type: 'tool_use', id: 'tu_2', name: 'mcp__github__create_issue', input: {} },
    ]),
    toolResult('2026-10-08T09:00:04Z'),
    assistant('msg_2', 'claude-sonnet-5-5', '2026-10-07T23:30:00Z', { input: 10, output: 100, read: 50_000 }, [
      { type: 'tool_use', id: 'tu_3', name: 'Edit', input: { file_path: '/work/acme/webapp/src/login.ts' } },
    ]),
  )

// ---- pure helpers ---------------------------------------------------------------------------

describe('parsing', () => {
  test('counts a streamed response once, keeping its final usage', async () => {
    const s = emptyFile()
    const used = parseText(s, fixture(), 0)
    expect(used).toBe(new TextEncoder().encode(fixture()).length)
    const opus = s.days['2026-10-08']?.m['claude-opus-5-5']
    expect(opus?.[0]).toBe(1) // one call
    expect(opus?.[1]).toBe(1000)
    expect(opus?.[2]).toBe(500)
    expect(opus?.[4]).toBe(2000)
    close(opus?.[6], costOf('claude-opus-5-5', { input: 1000, output: 500, cacheRead: 0, cacheWrite5m: 2000, cacheWrite1h: 0 }), 10)
  })

  test('a duplicate split across two reads is still counted once', async () => {
    const text = fixture()
    const lines = text.split('\n')
    const s = emptyFile()
    parseText(s, lines.slice(0, 3).join('\n') + '\n', 0)
    parseText(s, lines.slice(3).join('\n'), 0)
    expect(s.days['2026-10-08']?.m['claude-opus-5-5']?.[0]).toBe(1)
    expect(s.days['2026-10-08']?.m['claude-opus-5-5']?.[2]).toBe(500)
  })

  test('leaves a partial last line for the next read and skips zero-usage and synthetic lines', async () => {
    const s = emptyFile()
    const whole = jsonl(
      assistant('z', 'claude-opus-5-5', '2026-10-08T09:00:00Z', {}),
      assistant('y', '<synthetic>', '2026-10-08T09:00:00Z', { input: 5, output: 5 }),
    )
    const partial = assistant('w', 'claude-opus-5-5', '2026-10-08T09:00:00Z', { input: 5 })
    const used = parseText(s, whole + partial.slice(0, 40), 0)
    expect(used).toBe(new TextEncoder().encode(whole).length)
    expect(Object.keys(s.days)).toHaveLength(0)
  })

  test('reads the 5m/1h cache-write split, defaulting to 5m', async () => {
    expect(usageOf({ input_tokens: 1, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } })).toEqual({
      input: 1,
      output: 0,
      cacheRead: 0,
      cacheWrite5m: 10,
      cacheWrite1h: 20,
    })
    expect(usageOf({ cache_creation_input_tokens: 30 }).cacheWrite5m).toBe(30)
  })

  test('extracts the first word of shell commands', async () => {
    expect(shellCommand('git status')).toBe('git')
    expect(shellCommand('sudo apt-get install jq')).toBe('apt-get')
    expect(shellCommand('env FOO=1 BAR=2 node build.js')).toBe('node')
    expect(shellCommand('NODE_ENV=test npx jest')).toBe('npx')
    expect(shellCommand('cd /tmp/x && make -j4')).toBe('make')
    expect(shellCommand('cd "/a b"; cd sub && ls -la')).toBe('ls')
    expect(shellCommand('cd /tmp 2>/dev/null && pwd')).toBe('pwd')
    expect(shellCommand('D=/tmp/x; cd $D && tsc -p .')).toBe('tsc')
    expect(shellCommand('export CI=1 && pnpm build')).toBe('pnpm')
    expect(shellCommand('/usr/bin/python3 -m http.server')).toBe('python3')
    expect(shellCommand('sudo -E env X=y cargo test')).toBe('cargo')
    expect(shellCommand('   ')).toBe(null)
  })

  test('groups MCP tools by server', async () => {
    expect(mcpServer('mcp__github__create_issue')).toBe('github')
    expect(mcpServer('mcp__Claude_Docs__batch')).toBe('Claude_Docs')
    expect(mcpServer('mcp__claude-code-remote__list_sessions')).toBe('claude-code-remote')
    expect(mcpServer('Bash')).toBe(null)
  })

  test('buckets by local date', async () => {
    const t = Date.parse('2026-10-07T23:30:00Z')
    expect(dayKey(t, 0)).toBe('2026-10-07')
    expect(dayKey(t, 60)).toBe('2026-10-08')
    expect(dayKey(Date.parse('2026-10-08T03:00:00Z'), -300)).toBe('2026-10-07')
  })
})

describe('pricing', () => {
  test('per-model list prices with cache writes and reads', async () => {
    const u = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 }
    // input + output + read + 1.25x input + 2x input
    close(costOf('claude-opus-5-5', u), 4 + 20 + 0.2 + 5 + 8, 6)
    close(costOf('claude-opus-4-7', u), 5 + 25 + 0.5 + 6.25 + 10, 6)
    close(costOf('claude-fable-5-1', u), 10 + 50 + 0.25 + 12.5 + 20, 6)
    close(costOf('claude-mythos-preview', u), 10 + 50 + 0.25 + 12.5 + 20, 6)
    close(costOf('claude-sonnet-5-5', u), 2 + 10 + 0.1 + 2.5 + 4, 6)
    close(costOf('claude-sonnet-5', u), 2 + 10 + 0.2 + 2.5 + 4, 6)
    close(costOf('claude-sonnet-4-5-20250929', u), 3 + 15 + 0.3 + 3.75 + 6, 6)
    close(costOf('claude-haiku-4-5', u), 1 + 5 + 0.1 + 1.25 + 2, 6)
  })

  test('Haiku 5.5 switches to its long-context tier over 100k prompt tokens', async () => {
    const short = { input: 50_000, output: 1_000_000, cacheRead: 40_000, cacheWrite5m: 0, cacheWrite1h: 0 }
    close(costOf('claude-haiku-5-5', short), (50_000 * 0.1 + 1_000_000 * 0.5 + 40_000 * 0.01) / 1e6, 9)
    const long = { input: 50_000, output: 1_000_000, cacheRead: 40_000, cacheWrite5m: 20_000, cacheWrite1h: 0 }
    close(costOf('claude-haiku-5-5', long), (50_000 * 0.5 + 1_000_000 * 2.5 + 40_000 * 0.05 + 20_000 * 0.5 * 1.25) / 1e6, 9)
  })

  test('prefix matching, labels and unpriced models', async () => {
    expect(priceOf('claude-opus-5-5[1m]')?.input).toBe(4)
    expect(priceOf('claude-opus-5')?.input).toBe(5)
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelLabel('gpt-oss-x')).toBe('(unpriced) gpt-oss-x')
    expect(costOf('gpt-oss-x', { input: 5, output: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })).toBe(0)
  })
})

describe('activity classification', () => {
  test('keyword and tool rules', async () => {
    expect(classify({ ...freshSignals('why does login crash?'), t: 2 })).toBe('Debugging')
    expect(classify({ ...freshSignals('please go'), r: true, t: 1 })).toBe('Testing')
    expect(classify({ ...freshSignals('refactor the auth module'), e: 3, t: 5 })).toBe('Refactoring')
    expect(classify({ ...freshSignals('tidy this'), e: 2, d: 2, t: 2 })).toBe('Refactoring')
    expect(classify({ ...freshSignals('update it'), e: 2, d: 2, t: 2 })).toBe('Docs')
    expect(classify({ ...freshSignals('add a dark mode toggle'), e: 4, t: 6 })).toBe('Feature Dev')
    expect(classify({ ...freshSignals('add a dark mode toggle'), t: 0 })).toBe('Conversation')
    expect(classify({ ...freshSignals('make it faster'), e: 1, t: 3 })).toBe('Coding')
    expect(classify({ ...freshSignals('ok'), t: 4 })).toBe('Exploration')
    expect(classify({ ...freshSignals('how does the cache work?'), t: 0 })).toBe('Exploration')
    expect(classify(freshSignals('thanks!'))).toBe('Conversation')
    expect(keywordOf('write the README')).toBe('Docs')
    expect(isTestRun('cd app && npm test -- --watch=false')).toBe(true)
    expect(isTestRun('git status')).toBe(false)
  })
})

describe('aggregation and layout', () => {
  test('ranges start where they should', async () => {
    expect(rangeStart('today', '2026-10-08')).toBe('2026-10-08')
    expect(rangeStart('7d', '2026-10-08')).toBe('2026-10-02')
    expect(rangeStart('30d', '2026-10-08')).toBe('2026-09-09')
    expect(rangeStart('month', '2026-10-08')).toBe('2026-10-01')
    expect(rangeStart('6m', '2026-10-08')).toBe('2026-04-09')
    expect(rangeStart('6m', '2026-08-31')).toBe('2026-03-01')
    expect(rangeStart('lifetime', '2026-10-08')).toBe('')
  })

  test('folds files into a view and honours the range', async () => {
    const s = emptyFile()
    parseText(s, fixture(), 0)
    const all = aggregate([s], 'lifetime', '2026-10-08')
    expect(all.calls).toBe(2)
    expect(all.sessions).toBe(1)
    expect(all.daily.map(d => d.day)).toEqual(['2026-10-08', '2026-10-07'])
    expect(all.projects[0]?.name).toBe('webapp')
    expect(all.models.map(m => m.name).sort()).toEqual(['Opus 5.5', 'Sonnet 5.5'])
    expect(all.mcp).toEqual([{ name: 'github', count: 1 }])
    expect(all.tools).toEqual([
      { name: 'Bash', count: 1 },
      { name: 'Edit', count: 1 },
    ])
    expect(all.shell).toEqual([{ name: 'npm', count: 1 }])
    expect(all.activities.map(a => a.name)).toEqual(['Testing'])
    const today = aggregate([s], 'today', '2026-10-08')
    expect(today.calls).toBe(1)
    expect(today.daily).toHaveLength(1)
    expect(aggregate([s], 'today', '2026-10-20').calls).toBe(0)
  })

  test('bars, numbers and the two-column switch', async () => {
    expect(bar(1, 4)).toBe('████')
    expect(bar(0.5, 4)).toBe('██  ')
    expect(bar(0.53125, 4)).toBe('██▏ ')
    expect(bar(0.001, 4)).toBe('▏   ')
    expect(bar(0, 3)).toBe('   ')
    expect(fmtCost(12.4)).toBe('$12.40')
    expect(fmtCost(1234.5)).toBe('$1,234.50')
    expect(fmtTokens(1_250_000)).toBe('1.3M')
    expect(fmtTokens(950)).toBe('950')
    const s = emptyFile()
    parseText(s, fixture(), 0)
    const v = aggregate([s], 'lifetime', '2026-10-08')
    expect(layout(v, 120, 40).twoColumns).toBe(true)
    expect(layout(v, 120, 40).rows.map(r => r.length)).toEqual([2, 2, 2, 1])
    expect(layout(v, 80, 40).rows.every(r => r.length === 1)).toBe(true)
    for (const cols of [40, 80, 99, 100, 160]) {
      for (const r of layout(v, cols, 40).rows) {
        const width = r.reduce((n, p) => n + p.width, 0) + (r.length - 1)
        expect(width <= cols).toBe(true)
        for (const p of r) for (const l of p.lines) expect(l.map(sg => sg.text).join('').length <= p.width - 4).toBe(true)
      }
    }
    expect(dailyRowsFor(40, true)).toBe(28)
    expect(dailyRowsFor(5, false)).toBe(3)
  })
})

// ---- through the engine ---------------------------------------------------------------------

describe('dashboard', () => {
  test('scans, then re-reads only files that changed', async ($, on) => {
    const files: Record<string, FakeFile> = {
      [MAIN]: { text: fixture(), mtime: 100 },
      [SUB]: {
        text: jsonl(
          user('look around the repo', '2026-10-08T10:00:00Z', { isSidechain: true }),
          assistant('msg_s1', 'claude-haiku-5-5', '2026-10-08T10:00:01Z', { input: 100, output: 100 }),
        ),
        mtime: 100,
      },
    }
    const w = world(on, files)
    await burn($)
    await w.clock.advance(10)
    expect(w.reads[MAIN]).toBe(1)
    expect(w.reads[SUB]).toBe(1)

    const ui = await pane($, 'terminal')
    await ui.press({ key: 'range-lifetime' })
    expect(await ui.find({ type: 'Text', text: /3 calls · 1 sessions/ })).toBeDefined()
    await ui.unmount()

    // Nothing changed: a refresh reads nothing.
    await burn($)
    await w.clock.advance(10)
    expect(w.reads[MAIN]).toBe(1)
    expect(w.reads[SUB]).toBe(1)

    // The main transcript grew: only it is read again, and only its new lines are parsed.
    files[MAIN] = { text: files[MAIN]!.text + jsonl(assistant('msg_3', 'claude-opus-5-5', '2026-10-08T11:00:00Z', { input: 10, output: 10 })), mtime: 200 }
    await burn($)
    await w.clock.advance(10)
    expect(w.reads[MAIN]).toBe(2)
    expect(w.reads[SUB]).toBe(1)
    const again = await pane($, 'terminal')
    expect(await again.find({ type: 'Text', text: /4 calls · 1 sessions/ })).toBeDefined()
    await again.unmount()
  })

  test('files over 4 MiB are read in chunks through the shell, not $.fs.read', async ($, on) => {
    const w = world(on, { [MAIN]: { text: fixture(), mtime: 100, size: 5_000_000 } })
    await burn($)
    await w.clock.advance(10)
    expect(w.reads[MAIN]).toBe(undefined)
    expect(w.chunks.length > 0).toBe(true)
    const ui = await pane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /2 calls/ })).toBeDefined()
    await ui.unmount()
  })

  test('the range buttons switch the view on terminal and desktop', async ($, on) => {
    const w = world(on, { [MAIN]: { text: fixture(), mtime: 100 } })
    await burn($)
    await w.clock.advance(10)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await pane($, surface, 120, 40)
      await ui.press({ key: 'range-today' })
      expect(await ui.find({ type: 'Text', text: 'Today' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /1 calls/ })).toBeDefined()
      await ui.press({ key: 'range-7d' })
      expect(await ui.find({ type: 'Text', text: '7 Days' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /2 calls/ })).toBeDefined()
      for (const title of ['Daily Activity', 'By Project', 'By Model', 'By Activity', 'Core Tools', 'Shell Commands', 'MCP Servers']) {
        expect(await ui.find({ type: 'Text', text: title })).toBeDefined()
      }
      expect(await ui.find({ type: 'Text', text: /Showing 1–2 of 2 days/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /est\. at list price/ })).toBeDefined()
      await ui.unmount()

      const narrow = await pane($, surface, 60, 30)
      expect(await narrow.find({ type: 'Text', text: 'MCP Servers' })).toBeDefined()
      await narrow.unmount()
    }
  })

  test('/burn <range> picks the range and the status line shows today', async ($, on) => {
    const w = world(on, { [MAIN]: { text: fixture(), mtime: 100 } })
    await burn($, 'today')
    await w.clock.advance(10)
    const today = w.statuses.at(-1) ?? ''
    expect(today).toMatch(/^🔥 \$\d+\.\d\d today$/)
    const ui = await pane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: 'Today' })).toBeDefined()
    await ui.unmount()

    await $.turn.complete({
      turnId: 't1',
      answer: 'done',
      durationMs: 10,
      isAborted: false,
      reason: 'answer',
      usage: { model: 'claude-opus-5-5', input_tokens: 0, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as never)
    const base = Number(today.replace(/[^\d.]/g, ''))
    expect(w.statuses.at(-1)).toBe(`🔥 $${(base + 20).toFixed(2)} today`)
  })

  test('empty state when there are no transcripts', async ($, on) => {
    const w = world(on, {})
    await burn($)
    await w.clock.advance(10)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await pane($, surface)
      expect(await ui.find({ type: 'Text', text: /No transcripts found/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'refresh' })).toBeDefined()
      await ui.unmount()
    }
  })
})
