import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Block } from '../types'
import { classifyCommand, denyText, parseExtra, protectedFile } from './rules'
import type { Verdict } from './rules'

const RECENT = 5
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const enabled = atom({ plugin: 'safety-net', key: 'enabled' } as const, true)
const blocked = atom({ plugin: 'safety-net', key: 'blocked' } as const, 0)
const recent = atom({ plugin: 'safety-net', key: 'recent' } as const, [] as Block[])

type Options = { extraProtected?: string; allowForceWithLease?: boolean }

/** Judges one tool call; null lets it run. */
async function judge($: EngineInterface, e: Record<string, unknown>, opts: Options): Promise<Verdict | null> {
  const tool = String(e.tool)
  if (tool === 'Bash' && typeof e.command === 'string') {
    const root = await $.session.root()
    const cwd = await $.session.cwd()
    const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || undefined
    return classifyCommand(e.command, { root, cwd, home, allowForceWithLease: opts.allowForceWithLease !== false })
  }
  if (FILE_TOOLS.has(tool)) {
    const path = 'file_path' in e ? e.file_path : 'notebook_path' in e ? e.notebook_path : undefined
    if (typeof path === 'string') return protectedFile(path, parseExtra(opts.extraProtected))
  }
  return null
}

async function recordBlock($: EngineInterface, tool: string, v: Verdict) {
  const at = await $.clock.now()
  const n = await update($, blocked, x => x + 1)
  await update($, recent, list => [...list, { at, tool, what: v.what, why: v.why }].slice(-RECENT))
  $.ui.toast(`🛡 safety-net blocked ${v.what}`, { timeoutMs: 6000 })
  $.ui.status(`🛡 safety-net: ${n} blocked`)
}

async function setEnabled($: EngineInterface, on: boolean) {
  await update($, enabled, () => on)
  const n = await read($, blocked)
  $.ui.status(on ? (n > 0 ? `🛡 safety-net: ${n} blocked` : undefined) : '🛡 safety-net: off')
}

export const register: Register = (on, options) => {
  const opts = (options ?? {}) as Options

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'safety-net',
      description: 'Safety net: show recent blocks, or turn the guard off/on for this session',
      argumentHint: '[on | off]',
      immediate: true,
    })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    const verdict = await judge($, e as unknown as Record<string, unknown>, opts)
    if (!verdict) return next(e)
    await recordBlock($, String(e.tool), verdict)
    return { deny: denyText(verdict) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'safety-net: its guard failed.' }))

  on('command.run', { command: 'safety-net' }, async ($, e) => {
    const verb = e.args.trim().toLowerCase()
    if (verb === 'off') {
      await setEnabled($, false)
      return { text: 'Safety net: off for this session. Destructive commands and protected-file writes will run unchecked. /safety-net on to re-enable.' }
    }
    if (verb === 'on') {
      await setEnabled($, true)
      return { text: 'Safety net: on.' }
    }
    if (verb !== '') return { text: 'Usage: /safety-net [on | off]' }

    const isOn = await read($, enabled)
    const n = await read($, blocked)
    const list = await read($, recent)
    const lines = [`Safety net: ${isOn ? 'on' : 'off'} · ${n} blocked this session.`]
    for (const b of [...list].reverse()) lines.push(`  ${new Date(b.at).toLocaleTimeString()}  ${b.tool}: ${b.what} — ${b.why}`)
    return { text: lines.join('\n') }
  })
}
