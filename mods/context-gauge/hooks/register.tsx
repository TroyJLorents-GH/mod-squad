import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage } from 'claude-code'

import type { Reading } from '../types'
import { HINT, barWidth, colorFor, crossed, formatTokens, label, segments, toastText, warnLevel } from './gauge'

const reading = atom({ plugin: 'context-gauge', key: 'reading' } as const, null as Reading | null)
const isHidden = atom({ plugin: 'context-gauge', key: 'isHidden' } as const, false)

const PREFIX = 'context '

/** Turns the engine's context figures into a reading; null until a response of the live window reported one. */
function toReading(c: SessionContextUsage): Reading | null {
  if (c.tokens === undefined || c.percent === undefined || !(c.window > 0)) return null
  return { tokens: c.tokens, window: c.window, percent: Math.round(c.percent) }
}

/** Stores a new reading and toasts once per threshold crossed on the way up. */
async function record($: EngineInterface, c: SessionContextUsage, warnAt: number) {
  const next = toReading(c)
  const prev = await read($, reading)
  await update($, reading, () => next)
  if (next === null) return
  const hit = crossed(prev?.percent ?? null, next.percent, warnAt)
  if (hit !== null) $.ui.toast(toastText(next.percent, hit), { timeoutMs: 8000 })
}

/** Reads the live window and records it; a failed read leaves the last reading in place. */
async function refresh($: EngineInterface, warnAt: number) {
  try {
    const usage = await $.session.usage()
    await record($, usage.context, warnAt)
  } catch {
    // No session bound yet, or the read was refused: keep what we had.
  }
}

async function setHidden($: EngineInterface, hidden: boolean) {
  await update($, isHidden, () => hidden)
  await $.store.set('isHidden', hidden)
}

function describe(r: Reading | null, hidden: boolean, warnAt: number): string {
  const state = hidden ? ' (band hidden; /gauge show)' : ''
  if (r === null) return `Context gauge: no reading yet (one arrives after the next response)${state}.`
  const hint = r.percent >= warnAt ? ' Consider /compact.' : ''
  return `Context gauge: ${r.percent}% used · ${formatTokens(r.tokens)} of ${formatTokens(r.window)} tokens (${r.tokens.toLocaleString('en-US')} / ${r.window.toLocaleString('en-US')}).${hint}${state}`
}

export const register: Register = (on, options) => {
  const warnAt = warnLevel((options as { warnAt?: unknown } | undefined)?.warnAt)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gauge',
      description: 'Context gauge: show context-window usage, or hide | show | toggle the band above the prompt',
      argumentHint: '[hide | show | toggle]',
      immediate: true,
    })
    const saved = await $.store.get('isHidden')
    if (typeof saved === 'boolean') await update($, isHidden, () => saved)
    await refresh($, warnAt)

    return next(e)
  }).catch(($, e, next) => next(e))

  // Pushed by the engine after each main-thread turn: the cheapest source.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) await record($, e.context, warnAt)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Each main-loop step answered: refresh mid-turn so the bar moves during long turns.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined) await refresh($, warnAt)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) await refresh($, warnAt)
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'gauge' }, async ($, e) => {
    const verb = e.args.trim().toLowerCase()
    const hidden = await read($, isHidden)

    if (verb === 'hide' || verb === 'show' || verb === 'toggle') {
      const nextHidden = verb === 'toggle' ? !hidden : verb === 'hide'
      await setHidden($, nextHidden)
      return { text: `Context gauge: band ${nextHidden ? 'hidden' : 'shown'}.` }
    }

    await refresh($, warnAt)
    return { text: describe(await read($, reading), hidden, warnAt) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const r = await read($, reading)
    if (r === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const isWarn = r.percent >= warnAt
    const tail = label(r.percent, r.tokens, r.window)
    const hint = isWarn ? HINT : ''
    const width = barWidth(e.props.bodyColumns, PREFIX.length + tail.length + hint.length)

    return (
      <Box>
        <Text dimColor>{PREFIX}</Text>
        {width > 0 && <Text dimColor>▕</Text>}
        {segments(r.percent, width, warnAt).map(s =>
          s.color === null ? <Text dimColor>{s.text}</Text> : <Text color={s.color}>{s.text}</Text>,
        )}
        {width > 0 && <Text dimColor>▏</Text>}
        <Text bold color={colorFor(r.percent, warnAt)}>{` ${r.percent}%`}</Text>
        <Text dimColor>{tail.slice(` ${r.percent}%`.length)}</Text>
        {isWarn && <Text color={colorFor(r.percent, warnAt)}>{hint}</Text>}
      </Box>
    )
  })
}
