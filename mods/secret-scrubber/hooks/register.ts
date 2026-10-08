import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { compileExtra, redactBlocks, sum, withheld } from './redact'
import type { Block, Counts } from './redact'

const enabled = atom({ plugin: 'secret-scrubber', key: 'enabled' } as const, true)
const counts = atom({ plugin: 'secret-scrubber', key: 'counts' } as const, {} as Counts)

/** Rows this mod rewrites: a tool's result, and the rows a tool hands over beside it. */
const DOORS = new Set(['tool-result', 'tool-message'])

type Options = { extraPatterns?: string }

const statusLine = (total: number) => `🔒 ${total} secret${total === 1 ? '' : 's'} redacted`

/** Adds a row's redactions to the session's tally, toasts new kinds and repins the status line. */
async function tally($: EngineInterface, found: Counts) {
  const before = await read($, counts)
  const after = await update($, counts, c => {
    const out = { ...c }
    for (const [k, n] of Object.entries(found)) out[k] = (out[k] ?? 0) + n
    return out
  })
  const total = sum(after)
  for (const kind of Object.keys(found)) {
    if (!(kind in before)) $.ui.toast(`secret-scrubber: redacted a ${kind} from tool output`)
  }
  $.ui.status(statusLine(total))
}

async function summary($: EngineInterface): Promise<string> {
  const on = await read($, enabled)
  const c = await read($, counts)
  const rows = Object.entries(c).sort((a, b) => b[1] - a[1])
  const head = `secret-scrubber is ${on ? 'on' : 'OFF for this session'}.`
  if (rows.length === 0) return `${head} Nothing redacted yet.`
  return [`${head} Redacted ${sum(c)} this session:`, ...rows.map(([k, n]) => `  ${k}: ${n}`)].join('\n')
}

export const register: Register = (on, options) => {
  const opts = (options ?? {}) as Options
  const extra = compileExtra(opts.extraPatterns)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'scrub',
      description: 'Secret scrubber: show what was redacted, or turn it off/on for this session',
      argumentHint: '[off | on]',
      immediate: true,
    })
    if (extra.invalid.length > 0) {
      $.ui.toast(`secret-scrubber: ignored invalid extraPatterns: ${extra.invalid.join(', ')}`, { timeoutMs: 8000 })
    }
    return next(e)
  })

  on('session.append', async ($, e, next) => {
    // Only tool output: never the person's prompt, the model's response or anything else.
    if (!DOORS.has(e.door) || !(await read($, enabled))) return next(e)
    const r = redactBlocks(e.message.content as Block[], extra.rules)
    if (r.total === 0) return next(e)
    const stored = await next({ ...e, message: { ...e.message, content: r.content } })
    await tally($, r.counts)
    return stored
  }).catch(($, e, next) => {
    // Already stored (the tally failed after `next`): replay the stored row.
    if (next.called) return next(e)
    // Fail closed: if redaction itself threw, the output is withheld rather
    // than stored with whatever secrets it holds. Rows outside the doors we
    // scrub are passed on as they came.
    if (!DOORS.has(e.door)) return next(e)
    return next({ ...e, message: { ...e.message, content: withheld(e.message.content) } })
  })

  on('command.run', { command: 'scrub' }, async ($, e) => {
    const verb = e.args.trim().toLowerCase()
    if (verb === 'off' || verb === 'on') {
      await update($, enabled, () => verb === 'on')
      return {
        text:
          verb === 'on'
            ? 'secret-scrubber: on. Tool output is redacted again.'
            : 'secret-scrubber: OFF for this session. Tool output reaches the transcript and the model unredacted.',
      }
    }
    if (verb !== '') return { text: 'Usage: /scrub [off | on]' }
    return { text: await summary($) }
  })
}
