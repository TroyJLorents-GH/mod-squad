import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, SessionAppendDoor, SessionAppendMessage } from 'claude-code'

const GHP = `ghp_${'x'.repeat(36)}`
const AWS = 'AKIAEXAMPLEEXAMPLE12'

// Sits beneath the plugin: records each row as it reaches the store. Also records the plugin's status and toasts.
function world(on: On) {
  const stored: SessionAppendMessage[] = []
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  mock.store(on)
  on('session.append', ($, e, next) => {
    stored.push(e.message)
    return next(e)
  })
  on('ui.status', ($, e) => (statuses.push(e.text), { value: undefined }))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  return { stored, statuses, toasts }
}

const toolRow = (output: unknown, door: SessionAppendDoor = 'tool-result', uuid = 'u1') => ({
  message: {
    type: 'user' as const,
    role: 'user' as const,
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: output }],
  },
  door,
  origin: { kind: 'tool' as const, tool: 'Bash' },
  uuid,
})

const run = (command: string, args = '') =>
  ({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } }) as never

describe('secret-scrubber', () => {
  test('redacts a tool result before it is stored', async ($, on) => {
    const w = world(on)
    const res = await $.session.append(toolRow(`GITHUB_TOKEN=${GHP}\nok`))
    expect(w.stored[0]?.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'GITHUB_TOKEN=[REDACTED:github-token]\nok' }])
    expect(res.message?.content).toEqual(w.stored[0]?.content)
    expect(w.statuses.at(-1)).toBe('🔒 1 secret redacted')
    expect(w.toasts).toEqual(['secret-scrubber: redacted a github-token from tool output'])
  })

  test('tool_result content given as blocks, and tool-message rows', async ($, on) => {
    const w = world(on)
    await $.session.append(toolRow([{ type: 'text', text: `key ${AWS}` }]))
    await $.session.append({
      message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text: `handed over ${GHP}` }] },
      door: 'tool-message',
      origin: { kind: 'tool', tool: 'Skill' },
      uuid: 'u2',
    })
    expect(w.stored[0]?.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'key [REDACTED:aws-access-key-id]' }] }])
    expect(w.stored[1]?.content).toEqual([{ type: 'text', text: 'handed over [REDACTED:github-token]' }])
    expect(w.statuses.at(-1)).toBe('🔒 2 secrets redacted')
  })

  test("never touches the person's prompt or the model's response", async ($, on) => {
    const w = world(on)
    const prompt = [{ type: 'text', text: `my token is ${GHP}` }]
    await $.session.append({ message: { type: 'user', role: 'user', content: prompt }, door: 'prompt', origin: { kind: 'composer' } as never, uuid: 'p1' })
    await $.session.append({
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: `use ${GHP}` }] },
      door: 'response',
      origin: { kind: 'model', model: 'claude-opus-5-5' },
      uuid: 'r1',
    })
    expect(w.stored[0]?.content).toEqual(prompt)
    expect(w.stored[1]?.content).toEqual([{ type: 'text', text: `use ${GHP}` }])
    expect(w.statuses).toEqual([])
  })

  test('clean output passes through unchanged with no status', async ($, on) => {
    const w = world(on)
    await $.session.append(toolRow('total 0\ndrwxr-xr-x  2 me  staff  64 Oct  8 .'))
    expect(w.stored[0]?.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'total 0\ndrwxr-xr-x  2 me  staff  64 Oct  8 .' }])
    expect(w.statuses).toEqual([])
  })

  test('toasts each kind only the first time', async ($, on) => {
    const w = world(on)
    await $.session.append(toolRow(GHP, 'tool-result', 'a'))
    await $.session.append(toolRow(`${GHP} ${AWS}`, 'tool-result', 'b'))
    expect(w.toasts).toEqual([
      'secret-scrubber: redacted a github-token from tool output',
      'secret-scrubber: redacted a aws-access-key-id from tool output',
    ])
    expect(w.statuses.at(-1)).toBe('🔒 3 secrets redacted')
  })

  test('/scrub shows counts by kind', async ($, on) => {
    world(on)
    await $.session.append(toolRow(`${GHP} ${GHP} ${AWS}`))
    const res = await $.command.run(run('scrub'))
    expect((res as { text: string }).text).toBe('secret-scrubber is on. Redacted 3 this session:\n  github-token: 2\n  aws-access-key-id: 1')
  })

  test('/scrub with nothing redacted yet', async ($, on) => {
    world(on)
    const res = await $.command.run(run('scrub'))
    expect((res as { text: string }).text).toBe('secret-scrubber is on. Nothing redacted yet.')
  })

  test('/scrub off lets output through; /scrub on resumes', async ($, on) => {
    const w = world(on)
    await $.command.run(run('scrub', 'off'))
    await $.session.append(toolRow(GHP, 'tool-result', 'a'))
    expect(w.stored[0]?.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', content: GHP }])
    const off = await $.command.run(run('scrub'))
    expect((off as { text: string }).text).toStartWith('secret-scrubber is OFF for this session.')
    await $.command.run(run('scrub', 'on'))
    await $.session.append(toolRow(GHP, 'tool-result', 'b'))
    expect(w.stored[1]?.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', content: '[REDACTED:github-token]' }])
  })

  test('/scrub with an unknown argument shows usage', async ($, on) => {
    world(on)
    const res = await $.command.run(run('scrub', 'maybe'))
    expect((res as { text: string }).text).toBe('Usage: /scrub [off | on]')
  })

  test('extraPatterns adds custom rules', { options: { extraPatterns: 'ACME-[0-9]{8}' } }, async ($, on) => {
    const w = world(on)
    await $.session.append(toolRow('license ACME-12345678 ok'))
    expect(w.stored[0]?.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'license [REDACTED:custom] ok' }])
  })

  test('invalid extraPatterns are ignored with a toast', { options: { extraPatterns: 'ACME-[0-9]{8},(oops' } }, async ($, on) => {
    const w = world(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })
    expect(w.toasts).toEqual(['secret-scrubber: ignored invalid extraPatterns: (oops'])
    await $.session.append(toolRow('ACME-12345678'))
    expect(w.stored[0]?.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', content: '[REDACTED:custom]' }])
  })

  test('the stored row keeps tool_use_id and is_error', async ($, on) => {
    const w = world(on)
    await $.session.append({
      ...toolRow(''),
      message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', is_error: true, content: `fatal: ${GHP}` }] },
    })
    expect(w.stored[0]?.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_9', is_error: true, content: 'fatal: [REDACTED:github-token]' }])
  })

  test('if redaction throws, the output is withheld rather than leaked', async ($, on) => {
    const w = world(on)
    // A null inside a tool_result's block list makes the redactor throw.
    await $.session.append(toolRow([null, { type: 'text', text: GHP }]))
    expect(w.stored).toHaveLength(1)
    expect(w.stored[0]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: '[secret-scrubber: this output was withheld because redaction failed]' },
    ])
  })
})
