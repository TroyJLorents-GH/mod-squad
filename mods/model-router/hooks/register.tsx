import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Decision, Effort, Mode, ModelKey } from '../types'
import {
  CLASSIFIER_SYSTEM,
  EFFORTS,
  MODELS,
  bump,
  clamp,
  classifierPrompt,
  classifyHeuristic,
  colorAt,
  commandFloor,
  costUsd,
  effortAt,
  labelAt,
  modelAt,
  parseClassifier,
  rungFromSession,
  rungOf,
} from './ladder'

const PANE = 'model-router'
const CACHE_WARM_MS = 5 * 60_000
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const mode = atom({ plugin: 'model-router', key: 'mode' } as const, 'auto' as Mode)
const decision = atom({ plugin: 'model-router', key: 'decision' } as const, null as Decision | null)
const active = atom({ plugin: 'model-router', key: 'active' } as const, null as number | null)
const lastTurn = atom({ plugin: 'model-router', key: 'lastTurn' } as const, null as { rung: number; costUsd: number; endedAt: number } | null)
const sessionUsd = atom({ plugin: 'model-router', key: 'sessionUsd' } as const, 0)
const pin = atom({ plugin: 'model-router', key: 'pin' } as const, rungOf('opus', 'medium'))

type Options = { classifier?: string; ceiling?: string; stickiness?: number }

async function setMode($: EngineInterface, next: Mode, pinned?: number) {
  await update($, mode, () => next)
  await $.store.set('mode', next)
  if (pinned === undefined) return
  await update($, pin, () => pinned)
  await $.store.set('pin', pinned)
  if (next === 'pinned') await update($, decision, (): Decision => ({ rung: pinned, reason: 'pinned by you', source: 'pinned' }))
}

/** Raises this turn's rung to at least `floor` (auto mode only; never lowers it). */
async function raise($: EngineInterface, floor: number, reason: string, ceiling: ModelKey) {
  if ((await read($, mode)) !== 'auto') return
  const target = clamp(floor, ceiling)
  await update($, decision, (d): Decision => (d && d.rung >= target ? d : { rung: target, reason, source: 'escalated' }))
}

export const register: Register = (on, options) => {
  const opts = (options ?? {}) as Options
  const ceiling = (opts.ceiling ?? 'fable') as ModelKey
  const stickiness = Math.max(0, Number(opts.stickiness ?? 3))

  // Per-turn escalation signals; a reload resetting them is harmless.
  let failures = 0
  let edited = new Set<string>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'route',
      description: 'Model router: show the ladder, or set auto | off | pin <haiku|sonnet|opus|fable> [effort]',
      argumentHint: '[auto | off | pin <haiku|sonnet|opus|fable> [effort]]',
      immediate: true,
    })
    const savedMode = (await $.store.get('mode')) as Mode | undefined
    const savedPin = (await $.store.get('pin')) as number | undefined
    if (savedMode) await setMode($, savedMode, savedPin)
    void $.ui.open({ id: PANE, title: 'Model router' })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const m = await read($, mode)
    if (m !== 'auto' || e.text.trimStart().startsWith('/')) return next(e)

    const current = await read($, active)
    let pick = classifyHeuristic(e.text)
    let source: Decision['source'] = 'heuristic'

    if (opts.classifier !== 'heuristic') {
      // A refused request (model not allowed, bad args) falls back to the heuristic.
      const r = await $.model
        .complete({
          model: 'claude-haiku-5-5',
          system: CLASSIFIER_SYSTEM,
          prompt: classifierPrompt(e.text, current),
          effort: 'low',
          maxTokens: 120,
          timeoutMs: 6000,
        })
        .catch(() => null)
      const graded = r?.isAnswered ? parseClassifier(r.text) : null
      if (graded) (pick = graded), (source = 'haiku')
    }

    let rung = clamp(pick.rung, ceiling)
    let reason = pick.reason

    // A prompt folded into a running turn may only raise the rung.
    if (e.turnId !== undefined && current !== null) rung = Math.max(rung, current)

    // Switching model or effort re-bills the cached prefix, so small downgrades
    // aren't worth it while the cache is still warm.
    const last = await read($, lastTurn)
    const warm = last !== null && (await $.clock.now()) - last.endedAt < CACHE_WARM_MS
    if (warm && current !== null && rung < current && current - rung < stickiness) {
      reason = `cache warm; wanted ${labelAt(rung)} (${reason})`
      rung = current
      source = 'held'
    }

    failures = 0
    edited = new Set()
    await update($, decision, () => ({ rung, reason, source }))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    // Subagents keep whatever model their definition asked for.
    if (e.agentId !== undefined) return yield* next(e)

    const m = await read($, mode)
    const d = await read($, decision)
    if (m === 'off' || d === null) {
      const seen = rungFromSession(e.model, e.effort)
      await update($, active, () => seen)
      return yield* next(e)
    }

    const rung = m === 'pinned' ? d.rung : clamp(d.rung, ceiling)
    if ((await read($, active)) !== rung) {
      await update($, active, () => rung)
      $.ui.status(`⇅ ${labelAt(rung)}`)
    }

    return yield* next({ ...e, model: modelAt(rung).id, effort: effortAt(rung) })
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    const tool = String(e.tool)
    if (e.tool === 'Bash') {
      const floor = commandFloor(e.command)
      if (floor) await raise($, floor.rung, floor.reason, ceiling)
    }

    const ran = await next(e)

    if (ran.deny === undefined && ran.isError === true) {
      failures += 1
      // Every second failure in a turn, step up to the next sensible rung.
      if (failures % 2 === 0) {
        const d = await read($, decision)
        await raise($, bump(d?.rung ?? 0), `${failures} failed tool calls this turn`, ceiling)
      }
    }

    if (EDIT_TOOLS.has(tool) && 'file_path' in e && typeof e.file_path === 'string') {
      edited.add(e.file_path)
      if (edited.size === 6) await raise($, rungOf('opus', 'high'), 'editing 6+ files', ceiling)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.usage) {
      const cost = costUsd(e.usage)
      const rung = (await read($, active)) ?? 0
      const endedAt = await $.clock.now()
      await update($, lastTurn, () => ({ rung, costUsd: cost, endedAt }))
      await update($, sessionUsd, total => total + cost)
    }

    return next(e)
  })

  on('command.run', { command: 'route' }, async ($, e) => {
    const [verb = '', model, effort] = e.args.trim().toLowerCase().split(/\s+/)

    if (verb === 'auto' || verb === 'off') {
      await setMode($, verb)
      return { text: `Model router: ${verb === 'auto' ? 'routing automatically' : 'off, the session model runs as set'}.` }
    }

    if (verb === 'pin') {
      if (!MODELS.some(x => x.key === model)) return { text: 'Usage: /route pin <haiku|sonnet|opus|fable> [low|medium|high|xhigh|max]' }
      const ef = (EFFORTS.includes(effort as Effort) ? effort : 'medium') as Effort
      const rung = rungOf(model as ModelKey, ef)
      await setMode($, 'pinned', rung)
      return { text: `Model router: pinned to ${labelAt(rung)}.` }
    }

    const d = await read($, decision)
    const a = await read($, active)
    await $.ui.open({ id: PANE, title: 'Model router' })
    const now = a === null ? 'nothing yet' : labelAt(a)
    return { text: `Model router (${await read($, mode)}): ${now}${d ? ` — ${d.source}: ${d.reason}` : ''}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const m = await read($, mode)
    const a = await read($, active)
    const d = await read($, decision)
    const last = await read($, lastTurn)
    const total = await read($, sessionUsd)

    return (
      <Box flexDirection="column">
        <Text dimColor>effort  low → max</Text>
        {MODELS.map((model, mi) => (
          <Box flexDirection="column" marginTop={1}>
            <Box>
              <Text bold={a !== null && modelAt(a).key === model.key}>{model.label}</Text>
              <Text dimColor>{`  $${model.input}/$${model.output}`}</Text>
            </Box>
            <Box>
              {EFFORTS.map((_, ei) => {
                const rung = mi * EFFORTS.length + ei
                const isLit = a !== null && rung <= a
                const isCurrent = rung === a
                return (
                  <Text color={isLit ? colorAt(rung) : undefined} dimColor={!isLit} bold={isCurrent}>
                    {isCurrent ? '◉ ' : isLit ? '● ' : '○ '}
                  </Text>
                )
              })}
            </Box>
          </Box>
        ))}
        <Box marginTop={1} flexDirection="column">
          {a === null ? (
            <Text dimColor>Waiting for the first turn…</Text>
          ) : (
            <Text bold color={colorAt(a)}>
              ▶ {labelAt(a)}
            </Text>
          )}
          <Text dimColor wrap="wrap">
            {m}
            {d ? ` · ${d.source}: ${d.reason}` : ''}
          </Text>
          {last && (
            <Text dimColor>
              last ${last.costUsd.toFixed(3)} · session ${total.toFixed(2)}
            </Text>
          )}
        </Box>
        <Box marginTop={1} gap={1}>
          <Button key="auto" label="auto" variant={m === 'auto' ? 'primary' : 'secondary'} onPress={() => setMode($, 'auto')} />
          <Button key="off" label="off" variant={m === 'off' ? 'primary' : 'secondary'} onPress={() => setMode($, 'off')} />
          <Button
            key="pin"
            label={m === 'pinned' ? 'pinned' : 'pin here'}
            variant={m === 'pinned' ? 'primary' : 'secondary'}
            onPress={() => setMode($, 'pinned', a ?? rungOf('opus', 'medium'))}
          />
        </Box>
      </Box>
    )
  })
}
