import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Watch } from '../types'
import { USAGE, alertText, evaluate, fmtChange, fmtPrice, parseCommand, parseQuote, quoteUrl, rangeBar, statusText } from './watch'
import type { Side } from './watch'

const PANE = 'stock-watch'
const MAX_WATCHES = 20
const MIN_POLL_S = 30

const watchesRef = atom({ plugin: 'stock-watch', key: 'watches' } as const, [] as Watch[])
const mutedRef = atom({ plugin: 'stock-watch', key: 'muted' } as const, false)
const pollRef = atom({ plugin: 'stock-watch', key: 'poll' } as const, { isRunning: false, at: 0 })

type Options = { pollSeconds?: number; sound?: string }
type Cfg = { pollMs: number; sound: 'chime' | 'voice' | 'off'; isPolling: boolean; isBusy: boolean }

function config(options: unknown): Cfg {
  const o = (options ?? {}) as Options
  const s = Number(o.pollSeconds)
  return {
    pollMs: Math.max(MIN_POLL_S, Number.isFinite(s) && s > 0 ? s : 60) * 1000,
    sound: o.sound === 'off' ? 'off' : o.sound === 'chime and voice' ? 'voice' : 'chime',
    isPolling: false,
    isBusy: false,
  }
}

/* ----------------------------------------------------------------------- state */

// The store is shared by every session on this machine, so each change reads it fresh and writes it back.
async function stored($: EngineInterface): Promise<Watch[]> {
  const v = await $.store.get('watches').catch(() => undefined)
  return Array.isArray(v) ? (v as Watch[]) : []
}

async function save($: EngineInterface, ws: Watch[]) {
  await $.store.set('watches', ws).catch(() => undefined)
  await update($, watchesRef, () => ws)
  const line = statusText(ws)
  $.ui.status(line)
}

/** Loads the store into the pane's state (a session that just started, or another session's change). */
async function load($: EngineInterface) {
  const ws = await stored($)
  await update($, watchesRef, () => ws)
  await update($, mutedRef, () => false)
  if ((await $.store.get('muted').catch(() => undefined)) === true) await update($, mutedRef, () => true)
  const line = statusText(ws)
  if (line !== undefined) $.ui.status(line)
}

/* ----------------------------------------------------------------------- sound */

/** Plays a clip. macOS plays through the engine; Windows has no engine player, so PowerShell plays it. */
async function chime($: EngineInterface, side: Side) {
  const asset = side === 'high' ? 'sounds/high.wav' : 'sounds/low.wav'
  const isWindows = (await $.env.get('OS').catch(() => undefined)) === 'Windows_NT'
  if (isWindows) {
    try {
      const path = `${$.plugin.root}/${asset}`.replace(/\//g, '\\').replace(/'/g, "''")
      const r = await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', `(New-Object Media.SoundPlayer '${path}').PlaySync()`], { timeoutMs: 15_000 })
      if (r.exitCode === 0) return
    } catch {
      // No process (the desktop app): fall through to the engine's player.
    }
  }
  try {
    await $.audio.play({ asset })
  } catch {
    // No player here: the toast still shows.
  }
}

async function announce($: EngineInterface, cfg: Cfg, w: Watch, side: Side, price: number) {
  $.ui.toast(alertText(w, side, price), { timeoutMs: 30_000 })
  if (cfg.sound === 'off' || (await read($, mutedRef))) return
  await chime($, side)
  if (cfg.sound === 'voice') await $.audio.speak(`${w.sym.replace(/[^A-Z0-9]/g, ' ')} ${side === 'high' ? 'reached your high' : 'fell to your low'}`).catch(() => undefined)
}

/* ------------------------------------------------------------------------ poll */

async function fetchQuote($: EngineInterface, sym: string) {
  try {
    const r = await $.http.fetch(quoteUrl(sym), { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; stock-watch)', Accept: 'application/json' } })
    if (r.status === 429) return { error: 'rate-limited by the price service; will retry' }
    if (!r.ok && r.text.trim() === '') return { error: `price service returned ${r.status}` }
    return parseQuote(r.text)
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'could not reach the price service' }
  }
}

/** Fetches every watched ticker once, records the price, and alerts on a fresh crossing. */
async function check($: EngineInterface, cfg: Cfg) {
  if (cfg.isBusy) return
  cfg.isBusy = true
  try {
    await update($, pollRef, p => ({ ...p, isRunning: true }))
    for (const { sym } of await stored($)) {
      const q = await fetchQuote($, sym)
      // Another session may have changed or alerted since the loop began: re-read before deciding.
      const ws = await stored($)
      const i = ws.findIndex(w => w.sym === sym)
      const w = ws[i]
      if (w === undefined) continue
      if ('error' in q) {
        ws[i] = { ...w, error: q.error }
        await save($, ws)
        continue
      }
      const { side, alert } = evaluate(w, q.price)
      ws[i] = { ...w, price: q.price, prev: q.prev, name: q.name ?? w.name, currency: q.currency ?? w.currency, at: await $.clock.now(), error: undefined, fired: side ?? undefined }
      // Written before the sound plays, so a second session polling right now sees it already fired.
      await save($, ws)
      if (alert !== null) await announce($, cfg, ws[i] as Watch, alert, q.price)
    }
  } finally {
    await update($, pollRef, () => ({ isRunning: false, at: 0 })).catch(() => undefined)
    cfg.isBusy = false
  }
}

function tick($: EngineInterface, cfg: Cfg) {
  $.clock.after(cfg.pollMs, () => {
    void check($, cfg)
      .catch(() => undefined)
      .then(() => tick($, cfg))
  })
}

/** Starts the checking loop once per session. */
function start($: EngineInterface, cfg: Cfg) {
  if (cfg.isPolling) return
  cfg.isPolling = true
  $.clock.after(2_000, () => void check($, cfg).catch(() => undefined))
  tick($, cfg)
}

/* -------------------------------------------------------------------- commands */

async function run($: EngineInterface, cfg: Cfg, args: string): Promise<string> {
  const cmd = parseCommand(args)
  switch (cmd.kind) {
    case 'error':
      return cmd.text
    case 'open':
    case 'list': {
      const ws = await stored($)
      await update($, watchesRef, () => ws)
      if (cmd.kind === 'open') return ws.length === 0 ? `Stock watch: nothing watched yet. ${USAGE}` : `Stock watch: ${ws.length} ticker${ws.length === 1 ? '' : 's'}.`
      return ws.length === 0 ? 'Stock watch: nothing watched yet.' : ws.map(w => `${w.sym} ${fmtPrice(w.price)}  low ${fmtPrice(w.low)}  high ${fmtPrice(w.high)}${w.error ? `  (${w.error})` : ''}`).join('\n')
    }
    case 'add': {
      const ws = await stored($)
      const i = ws.findIndex(w => w.sym === cmd.sym)
      if (i < 0 && ws.length >= MAX_WATCHES) return `Stock watch: up to ${MAX_WATCHES} tickers.`
      const prior = i >= 0 ? ws[i] : undefined
      // A changed limit starts fresh: the price may already be past it, and that should alert.
      const next: Watch = { ...(prior ?? { sym: cmd.sym }), low: cmd.low ?? prior?.low, high: cmd.high ?? prior?.high, fired: undefined }
      if (next.low !== undefined && next.high !== undefined && next.low >= next.high) return `The low (${next.low}) must be below the high (${next.high}).`
      if (i >= 0) ws[i] = next
      else ws.push(next)
      await save($, ws)
      $.clock.after(1, () => void check($, cfg).catch(() => undefined))
      return `Watching ${next.sym}${next.low !== undefined ? `, alert at or below ${fmtPrice(next.low)}` : ''}${next.high !== undefined ? `, alert at or above ${fmtPrice(next.high)}` : ''}.`
    }
    case 'rm': {
      const ws = await stored($)
      if (!ws.some(w => w.sym === cmd.sym)) return `Stock watch: ${cmd.sym} is not on the list.`
      await save($, ws.filter(w => w.sym !== cmd.sym))
      return `Stopped watching ${cmd.sym}.`
    }
    case 'check':
      $.clock.after(1, () => void check($, cfg).catch(() => undefined))
      return 'Stock watch: checking prices now.'
    case 'test':
      await chime($, 'high')
      await chime($, 'low')
      return 'Stock watch: played the high chime, then the low chime. Silent? That surface has no player; the toast still shows.'
    case 'mute':
    case 'unmute': {
      const m = cmd.kind === 'mute'
      await update($, mutedRef, () => m)
      await $.store.set('muted', m).catch(() => undefined)
      return m ? 'Stock watch: sound muted. Toasts still show.' : 'Stock watch: sound on.'
    }
  }
}

const OPEN = { id: PANE, title: 'Stock watch', focus: true, closeOnEscape: true, rows: 22, columns: 84 } as const

export const register: Register = (on, options) => {
  const cfg = config(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'stock',
      description: 'Stock watch: alert me when a ticker hits a low or high',
      argumentHint: 'add AAPL low 180 high 200 | rm AAPL | list | check | test | mute',
      immediate: true,
    })
    await load($)
    start($, cfg)
    return next(e)
  }).catch(($, e, next) => next(e))

  // A session that missed session.start still begins polling on its first prompt.
  on('prompt.submit', async ($, e, next) => {
    start($, cfg)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'stock' }, async ($, e) => {
    start($, cfg)
    const text = await run($, cfg, e.args)
    if (parseCommand(e.args).kind === 'open') await $.ui.open(OPEN).catch(() => undefined)
    return { text }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const ws = await read($, watchesRef)
    const muted = await read($, mutedRef)
    const cols = Math.max(20, e.props.bodyColumns)

    return (
      <Box flexDirection="column" width={cols}>
        <Input key="add" label="Add" placeholder="AAPL 180 200   or   NVDA high 140" onSubmit={value => void run($, cfg, `add ${value}`).then(t => $.ui.toast(t))} />
        <Box columnGap={1} marginTop={1}>
          <Button key="check" label="Check now" hotkey="c" variant="secondary" onPress={() => void run($, cfg, 'check')} />
          <Button key="test" label="Test sound" hotkey="t" variant="secondary" onPress={() => void run($, cfg, 'test')} />
          <Button key="mute" label={muted ? 'Unmute' : 'Mute'} hotkey="m" variant={muted ? 'primary' : 'secondary'} onPress={() => void run($, cfg, muted ? 'unmute' : 'mute')} />
        </Box>
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="#22c55e" paddingX={1} width={cols}>
          {ws.length === 0 && (
            <Text dimColor wrap="wrap">
              Nothing watched yet. Type a ticker with a low and a high above, for example AAPL 180 200.
            </Text>
          )}
          {ws.map(w => {
            const ch = fmtChange(w.price, w.prev)
            return (
              <Box flexDirection="column" marginBottom={1}>
                <Box columnGap={1}>
                  <Text bold>{w.sym.padEnd(8)}</Text>
                  <Text bold>{fmtPrice(w.price)}</Text>
                  <Text color={ch.dir > 0 ? '#22c55e' : ch.dir < 0 ? '#ef4444' : undefined} dimColor={ch.dir === 0}>
                    {ch.text}
                  </Text>
                  {w.fired !== undefined && <Text color={w.fired === 'high' ? '#22c55e' : '#ef4444'} bold>{w.fired === 'high' ? 'HIGH HIT' : 'LOW HIT'}</Text>}
                  <Button key={`rm-${w.sym}`} label="Remove" variant="secondary" onPress={() => void run($, cfg, `rm ${w.sym}`)} />
                </Box>
                <Text dimColor wrap="truncate">
                  {`low ${fmtPrice(w.low)}  ${rangeBar(w)}  high ${fmtPrice(w.high)}`}
                </Text>
                {w.error !== undefined && (
                  <Text color="#f59e0b" wrap="truncate">
                    {w.error}
                  </Text>
                )}
              </Box>
            )
          })}
        </Box>
        <Text dimColor wrap="wrap">
          {`Checked every ${Math.round(cfg.pollMs / 1000)}s while a session is open. Prices come from Yahoo Finance and can lag.`}
        </Text>
      </Box>
    )
  })
}
