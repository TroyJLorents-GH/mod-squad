import type { EngineInterface, Register } from 'claude-code'

const MODEL = 'claude-haiku-5-5'
const MAX_WORDS = 25
const CLIP = 8000

const SYSTEM =
  'You write a one-sentence TL;DR of an assistant answer. Reply with exactly one plain sentence of at most 25 words: ' +
  'the key outcome or takeaway. No preamble, no "TL;DR", no quotes, no markdown, no lists.'

type Options = { minChars?: number; minSeconds?: number }

/** Keeps the head and tail of a long answer, where the setup and the conclusion usually are. */
export function clip(text: string, max = CLIP): string {
  if (text.length <= max) return text
  const marker = '\n\n[… middle omitted …]\n\n'
  const half = Math.floor((max - marker.length) / 2)
  return text.slice(0, half) + marker + text.slice(-half)
}

/** Cleans the model's reply down to one sentence of at most MAX_WORDS words, or null. */
export function tidy(reply: string): string | null {
  let s = reply
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*(?:[-*+>#]+|\d+[.)])\s*/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  s = s.replace(/^tl;?\s?dr\s*[:\-–—]?\s*/i, '').trim()
  s = s.replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '').trim()
  // First sentence only (unless the cut lands on an abbreviation like "e.g.").
  const m = s.match(/^.*?[.!?](?=\s|$)/)
  if (m && m[0].trim().split(/\s+/).length >= 4) s = m[0].trim()
  s = s.replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '').trim()
  if (!s) return null
  if (s.split(/\s+/).length > MAX_WORDS) return null
  return s
}

async function isOn($: EngineInterface): Promise<boolean> {
  return (await $.store.get('enabled')) !== false
}

async function recap($: EngineInterface, answer: string): Promise<string | null> {
  const r = await $.model
    .complete({
      model: MODEL,
      effort: 'low',
      maxTokens: 120,
      timeoutMs: 8000,
      system: SYSTEM,
      prompt: `Summarize this answer in one sentence:\n\n${clip(answer)}`,
    })
    .catch(() => null)
  if (!r?.isAnswered) return null
  return tidy(r.text)
}

export const register: Register = (on, options) => {
  const opts = (options ?? {}) as Options
  const minChars = Number(opts.minChars ?? 1200)
  const minMs = Number(opts.minSeconds ?? 90) * 1000

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'recap',
      description: 'Turn recap: show state and the last TL;DR, or turn it on | off',
      argumentHint: '[on | off]',
      immediate: true,
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined || e.reason !== 'answer') return next(e)
    const answer = e.answer.trim()
    if (!answer) return next(e)
    if (e.answer.length < minChars && e.durationMs < minMs) return next(e)
    if (!(await isOn($))) return next(e)

    const done = await next(e)
    const line = await recap($, answer)
    if (!line) return done

    const text = `TL;DR: ${line}`
    await $.store.set('last', text)
    return { ...done, text }
  })

  on('command.run', { command: 'recap' }, async ($, e) => {
    const verb = e.args.trim().toLowerCase()
    if (verb === 'on' || verb === 'off') {
      await $.store.set('enabled', verb === 'on')
      return { text: `Turn recap: ${verb}.` }
    }
    if (verb) return { text: 'Usage: /recap [on | off]' }

    const last = (await $.store.get('last')) as string | undefined
    const when = `answers ≥ ${minChars} chars or turns ≥ ${minMs / 1000}s`
    return { text: `Turn recap: ${(await isOn($)) ? 'on' : 'off'} (${when}).${last ? `\nLast: ${last}` : ''}` }
  }).catch(($, e, next) => next(e))
}
