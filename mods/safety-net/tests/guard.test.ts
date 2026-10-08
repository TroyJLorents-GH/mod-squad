import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const presentation = { isFullscreen: true, columns: 200 }
const run = (args: string) => ({ command: 'safety-net', args, origin: { kind: 'composer' }, presentation }) as never

// Stands in for the tools beneath the guard: records what actually ran.
function world(on: On) {
  const ran: string[] = []
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { HOME: '/home/u' })
  on('session.root', () => ({ value: '/home/u/proj' }))
  on('session.cwd', () => ({ value: '/home/u/proj' }))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.status', ($, e) => (statuses.push(e.text), { value: undefined }))
  on('tool.call', ($, e) => {
    ran.push(String(e.tool))
    return { result: { stdout: '', stderr: '', interrupted: false }, isError: false } as never
  })
  return Object.assign(ran, { toasts, statuses })
}

type Answer = { deny?: string; isError?: boolean; text?: string }
const call = async ($: { tool: { call: (i: never) => Promise<unknown> } }, input: Record<string, unknown>) =>
  (await $.tool.call(input as never)) as Answer

describe('safety-net guard', () => {
  test('denies a force push and explains why', async ($, on) => {
    const ran = world(on)
    const r = await call($, { tool: 'Bash', command: 'npm test && git push --force origin main' })
    expect(r.deny).toMatch(/^safety-net: blocked `git push --force` — .*\/safety-net off for this session\.$/)
    expect(ran).toEqual([])
  })

  test('lets ordinary commands and in-project rm -rf run', async ($, on) => {
    const ran = world(on)
    for (const command of ['rm -rf node_modules', 'rm -rf ./dist', 'git push --force-with-lease', 'ls -la'])
      expect((await call($, { tool: 'Bash', command })).deny).toBeUndefined()
    expect(ran.length).toBe(4)
  })

  test('allowForceWithLease: false blocks lease pushes', { options: { allowForceWithLease: false } }, async ($, on) => {
    world(on)
    expect((await call($, { tool: 'Bash', command: 'git push --force-with-lease' })).deny).toMatch(/force-with-lease/)
  })

  test('denies writes to protected files, allows the rest', async ($, on) => {
    const ran = world(on)
    expect((await call($, { tool: 'Write', file_path: '/p/.env', content: 'X=1' })).deny).toMatch(/\.env/)
    expect((await call($, { tool: 'Edit', file_path: '/p/server.pem', old_string: 'a', new_string: 'b' })).deny).toBeDefined()
    expect((await call($, { tool: 'Write', file_path: '/p/.env.example', content: 'X=' })).deny).toBeUndefined()
    expect((await call($, { tool: 'Edit', file_path: '/p/src/app.ts', old_string: 'a', new_string: 'b' })).deny).toBeUndefined()
    expect(ran).toEqual(['Write', 'Edit'])
  })

  test('extraProtected adds patterns', { options: { extraProtected: '*.tfstate, config/prod.*' } }, async ($, on) => {
    world(on)
    expect((await call($, { tool: 'Write', file_path: '/p/terraform.tfstate', content: '' })).deny).toMatch(/extraProtected/)
    expect((await call($, { tool: 'Write', file_path: '/p/config/prod.json', content: '' })).deny).toBeDefined()
    expect((await call($, { tool: 'Write', file_path: '/p/config/dev.json', content: '' })).deny).toBeUndefined()
  })

  test('/safety-net off lets everything through, on restores it', async ($, on) => {
    const ran = world(on)
    const off = (await $.command.run(run('off'))) as { text?: string }
    expect(off.text).toMatch(/off for this session/)
    expect((await call($, { tool: 'Bash', command: 'git reset --hard' })).deny).toBeUndefined()
    expect(ran).toEqual(['Bash'])
    await $.command.run(run('on'))
    expect((await call($, { tool: 'Bash', command: 'git reset --hard' })).deny).toBeDefined()
    expect(ran).toEqual(['Bash'])
  })

  test('/safety-net lists the count and recent blocks', async ($, on) => {
    world(on)
    await call($, { tool: 'Bash', command: 'terraform destroy' })
    await call($, { tool: 'Bash', command: 'sudo rm -rf /' })
    const status = (await $.command.run(run(''))) as { text?: string }
    expect(status.text).toMatch(/on · 2 blocked this session/)
    expect(status.text).toMatch(/terraform destroy/)
    expect(status.text).toMatch(/rm -rf \//)
  })

  test('toasts each block and keeps a count in the status line', async ($, on) => {
    const w = world(on)
    await call($, { tool: 'Bash', command: 'ls' })
    expect(w.statuses).toEqual([])
    await call($, { tool: 'Bash', command: 'git clean -fdx' })
    await call($, { tool: 'Write', file_path: '/p/.npmrc', content: '' })
    expect(w.toasts.length).toBe(2)
    expect(w.toasts[0]).toMatch(/git clean -fd/)
    expect(w.statuses).toEqual(['🛡 safety-net: 1 blocked', '🛡 safety-net: 2 blocked'])
  })

  test('rm -rf in the home directory but outside the project is blocked', async ($, on) => {
    world(on)
    expect((await call($, { tool: 'Bash', command: 'rm -rf ~/proj/build' })).deny).toBeUndefined()
    expect((await call($, { tool: 'Bash', command: 'rm -rf ~/other' })).deny).toMatch(/outside the project/)
  })
})
