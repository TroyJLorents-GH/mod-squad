import type { EngineInterface, Register } from 'claude-code'

type Options = { minSeconds?: number; sound?: boolean }

export const SOUNDS = {
  done: 'sounds/done.wav',
  error: 'sounds/error.wav',
  attention: 'sounds/attention.wav',
} as const

/** 45s, 2m 14s, 1h 3m. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

async function isOn($: EngineInterface): Promise<boolean> {
  try {
    return (await $.store.get('enabled')) !== false
  } catch {
    return true
  }
}

/** Toast, then the chime when sound is on; a surface with no audio (or any failure) leaves the toast alone. */
async function ping($: EngineInterface, text: string, asset: string | undefined, sound: boolean) {
  try {
    $.ui.toast(text)
  } catch {}
  if (!sound || asset === undefined) return
  try {
    await $.audio.play({ asset })
  } catch {}
}

async function now($: EngineInterface): Promise<number | undefined> {
  try {
    return await $.clock.now()
  } catch {
    return undefined
  }
}

export const register: Register = (on, options) => {
  const opts = (options ?? {}) as Options
  const minMs = Math.max(0, Number(opts.minSeconds ?? 30)) * 1000
  const sound = opts.sound !== false

  // When the current main-loop turn started (module state; a reload resetting it is harmless).
  let turnStartedAt: number | undefined
  const asked = new Set<string>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ping',
      description: 'Ping when a long turn finishes: on | off | test, or bare to show settings',
      argumentHint: '[on | off | test]',
      immediate: true,
    })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    turnStartedAt = await now($)
    asked.clear()
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.durationMs < minMs || e.reason === 'aborted') return result
    if (!(await isOn($))) return result
    const took = formatDuration(e.durationMs)
    if (e.reason === 'answer') await ping($, `✔ Done in ${took}`, SOUNDS.done, sound)
    else await ping($, `✖ Turn ended: ${e.reason} after ${took}`, SOUNDS.error, sound)
    return result
  })

  // A real call whose verdict is `ask` goes to the person (or, in auto mode, the classifier).
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    try {
      if (verdict.decision !== 'ask' || e.tool_use_id === undefined || asked.has(e.tool_use_id)) return verdict
      asked.add(e.tool_use_id)
      const t = await now($)
      if (turnStartedAt === undefined || t === undefined || t - turnStartedAt < minMs) return verdict
      if (!(await isOn($))) return verdict
      await ping($, `⏳ Waiting for your approval (${e.tool}) after ${formatDuration(t - turnStartedAt)}`, SOUNDS.attention, sound)
    } catch {}
    return verdict
  }).catch(($, e, next) => next(e)) // we never gate: on any failure, the verdict beneath stands

  on('command.run', { command: 'ping' }, async ($, e) => {
    const verb = e.args.trim().toLowerCase()
    if (verb === 'on' || verb === 'off') {
      await $.store.set('enabled', verb === 'on')
      return { text: `Ping: ${verb}.` }
    }
    if (verb === 'test') {
      await ping($, '✔ Ping test', SOUNDS.done, sound)
      return { text: sound ? 'Ping: played done.wav (if this surface can play audio).' : 'Ping: sound is off in settings; toast only.' }
    }
    if (verb !== '') return { text: 'Usage: /ping [on | off | test]' }
    const enabled = await isOn($)
    return {
      text: `Ping: ${enabled ? 'on' : 'off'} · turns ≥ ${minMs / 1000}s · sound ${sound ? 'on' : 'off (toast only)'}`,
    }
  })
}
