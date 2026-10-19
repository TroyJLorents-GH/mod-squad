import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { alertText, evaluate, fmtChange, fmtPrice, parseCommand, parseQuote, quoteUrl, rangeBar, statusText } from '../hooks/watch'
import type { Watch } from '../types'

const yahoo = (price: number, prev = price, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ chart: { result: [{ meta: { symbol: 'X', regularMarketPrice: price, chartPreviousClose: prev, currency: 'USD', longName: 'Test Corp', ...extra } }], error: null } })

describe('command parsing', () => {
  test('add with keywords, either order', () => {
    expect(parseCommand('add aapl low 180 high 200')).toEqual({ kind: 'add', sym: 'AAPL', low: 180, high: 200 })
    expect(parseCommand('add NVDA above $1,200.50 below 900')).toEqual({ kind: 'add', sym: 'NVDA', low: 900, high: 1200.5 })
    expect(parseCommand('add TSLA high 300')).toEqual({ kind: 'add', sym: 'TSLA', low: undefined, high: 300 })
  })

  test('shorthand: a ticker and two prices is low then high, in any order', () => {
    expect(parseCommand('AAPL 180 200')).toEqual({ kind: 'add', sym: 'AAPL', low: 180, high: 200 })
    expect(parseCommand('AAPL 200 180')).toEqual({ kind: 'add', sym: 'AAPL', low: 180, high: 200 })
  })

  test('symbols with dots, dashes, carets and equals signs', () => {
    for (const s of ['BRK-B', 'BTC-USD', '^GSPC', 'EURUSD=X', '7203.T']) expect(parseCommand(`${s} 1 2`)).toMatchObject({ kind: 'add', sym: s })
  })

  test('mistakes say what to do', () => {
    expect(parseCommand('AAPL 180')).toMatchObject({ kind: 'error', text: expect.stringContaining('ambiguous') })
    expect(parseCommand('AAPL')).toMatchObject({ kind: 'error', text: expect.stringContaining('/stock add AAPL') })
    expect(parseCommand('add nvda')).toEqual({ kind: 'add', sym: 'NVDA', low: undefined, high: undefined })
    expect(parseCommand('AAPL low')).toMatchObject({ kind: 'error', text: expect.stringContaining('needs a price') })
    expect(parseCommand('AAPL low 200 high 100')).toMatchObject({ kind: 'error', text: expect.stringContaining('must be below') })
    expect(parseCommand('AAPL banana 5')).toMatchObject({ kind: 'error' })
    expect(parseCommand('1 2 3')).toMatchObject({ kind: 'error' })
  })

  test('the other verbs', () => {
    expect(parseCommand('')).toEqual({ kind: 'open' })
    expect(parseCommand('rm aapl')).toEqual({ kind: 'rm', sym: 'AAPL' })
    expect(parseCommand('remove AAPL')).toEqual({ kind: 'rm', sym: 'AAPL' })
    expect(parseCommand('refresh')).toEqual({ kind: 'check' })
    for (const v of ['list', 'check', 'test', 'mute', 'unmute'] as const) expect(parseCommand(v)).toEqual({ kind: v })
  })
})

describe('quotes', () => {
  test('reads a price, previous close, name and currency', () => {
    expect(parseQuote(yahoo(195.5, 190))).toEqual({ price: 195.5, prev: 190, name: 'Test Corp', currency: 'USD' })
  })

  test('errors are messages, not throws', () => {
    expect(parseQuote('<html>blocked</html>')).toMatchObject({ error: expect.stringContaining('rate-limiting') })
    expect(parseQuote('{"chart":{"result":null,"error":{"code":"Not Found","description":"No data found, symbol may be delisted"}}}')).toEqual({ error: 'No data found, symbol may be delisted' })
    expect(parseQuote('{"chart":{"result":[{"meta":{}}]}}')).toEqual({ error: 'no price in the response' })
    expect(parseQuote('{}')).toEqual({ error: 'no price in the response' })
  })

  test('the symbol is URL-encoded', () => {
    expect(quoteUrl('^GSPC')).toContain('/chart/%5EGSPC?')
    expect(quoteUrl('EURUSD=X')).toContain('EURUSD%3DX')
  })
})

describe('alert logic', () => {
  const w: Watch = { sym: 'A', low: 100, high: 200 }

  test('a limit alerts when crossed, at the limit itself', () => {
    expect(evaluate(w, 150)).toEqual({ side: null, alert: null })
    expect(evaluate(w, 200)).toEqual({ side: 'high', alert: 'high' })
    expect(evaluate(w, 201)).toEqual({ side: 'high', alert: 'high' })
    expect(evaluate(w, 100)).toEqual({ side: 'low', alert: 'low' })
  })

  test('it alerts once, then re-arms when the price is back inside the band', () => {
    expect(evaluate({ ...w, fired: 'high' }, 205)).toEqual({ side: 'high', alert: null })
    expect(evaluate({ ...w, fired: 'high' }, 150)).toEqual({ side: null, alert: null })
    expect(evaluate({ ...w, fired: 'high' }, 99)).toEqual({ side: 'low', alert: 'low' })
  })

  test('a watch with only one limit ignores the other side', () => {
    expect(evaluate({ sym: 'A', high: 200 }, 1)).toEqual({ side: null, alert: null })
    expect(evaluate({ sym: 'A', low: 100 }, 1000)).toEqual({ side: null, alert: null })
  })
})

describe('formatting', () => {
  test('prices, changes, the range bar and the status line', () => {
    expect(fmtPrice(1234.5)).toBe('1,234.5')
    expect(fmtPrice(195.456)).toBe('195.46')
    expect(fmtPrice(0.12345)).toBe('0.1235')
    expect(fmtPrice(undefined)).toBe('-')
    expect(fmtChange(105, 100)).toEqual({ text: '▲5.00%', dir: 1 })
    expect(fmtChange(95, 100)).toEqual({ text: '▼5.00%', dir: -1 })
    expect(fmtChange(1, undefined)).toEqual({ text: '', dir: 0 })
    expect(rangeBar({ sym: 'A', low: 0, high: 10, price: 5 }, 11)).toBe('[·····●·····]')
    expect(rangeBar({ sym: 'A', low: 0, high: 10, price: 10 }, 11)).toBe('[··········!]')
    expect(rangeBar({ sym: 'A', low: 0, price: 5 })).toBe('')
    expect(statusText([])).toBe(undefined)
    expect(statusText([{ sym: 'A', price: 10, open: 9 }, { sym: 'B', price: 20, open: 22, fired: 'low' }, { sym: 'C', price: 83094.31, prev: 80000 }, { sym: 'D', price: 5 }])).toBe('A 10.00 ▲ · B 20.00 ▼ LOW · C 83,094 ▲ +1')
    expect(statusText([{ sym: 'A', price: 10 }, { sym: 'B', price: 20 }], 1)).toBe('A 10.00 +1')
    expect(alertText({ sym: 'A', low: 100, high: 200, currency: 'USD' }, 'high', 201.5)).toBe('📈 A reached your high: 201.50 USD (limit 200.00)')
  })
})

// ---- the engine beneath the plugin ----------------------------------------------------------

type Prices = Record<string, string | number | Error>

function world(on: On, prices: Prices, env: Record<string, string> = {}) {
  const toasts: string[] = []
  const played: string[] = []
  const spoken: string[] = []
  const ps: string[] = []
  const statuses: (string | undefined)[] = []
  const fetched: string[] = []
  const clock = mock.clock(on, { now: Date.parse('2026-10-08T15:00:00Z') })
  mock.store(on)
  mock.env(on, env)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('http.fetch', ($, e) => {
    fetched.push(e.url)
    const sym = decodeURIComponent(/chart\/([^?]+)/.exec(e.url)?.[1] ?? '')
    const p = prices[sym]
    if (p instanceof Error) return { value: { status: 503, ok: false, headers: {}, text: '' } } as never
    if (p === undefined) return { value: { status: 404, ok: false, headers: {}, text: '{"chart":{"result":null,"error":{"code":"Not Found","description":"No data found, symbol may be delisted"}}}' } } as never
    return { value: { status: 200, ok: true, headers: {}, text: typeof p === 'string' ? p : yahoo(p, 100) } } as never
  })
  on('audio.play', ($, e) => {
    played.push((e as { clip?: { asset?: string } }).clip?.asset ?? '?')
    return { value: undefined } as never
  })
  on('audio.speak', ($, e) => {
    spoken.push(e.text)
    return { value: { via: 'system' } } as never
  })
  on('process.run', ($, e) => {
    const argv = (e as { argv: string[] }).argv
    ps.push(argv.join(' '))
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('ui.status', ($, e) => {
    statuses.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  return { clock, toasts, played, spoken, ps, statuses, fetched }
}

const cmd = (args: string) => ({ command: 'stock', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } }) as never

describe('stock-watch', () => {
  test('adding a ticker confirms, checks at once and shows the price in the status line', async ($, on) => {
    const w = world(on, { AAPL: 150 })
    const r = await $.command.run(cmd('add AAPL low 140 high 160'))
    expect(r.text).toBe('Watching AAPL, alert at or below 140.00, alert at or above 160.00.')
    await w.clock.advance(10)
    expect(w.fetched.length).toBe(1)
    expect(w.statuses.at(-1)).toBe('AAPL 150.00 ▲')
    expect(w.toasts.length).toBe(0)
  })

  test('crossing the high alerts once with a toast and the high chime; staying past it does not repeat', async ($, on) => {
    const prices: Prices = { AAPL: 150 }
    const w = world(on, prices)
    await $.command.run(cmd('add AAPL low 140 high 160'))
    await w.clock.advance(10)
    prices.AAPL = 161
    await w.clock.advance(60_000)
    expect(w.toasts).toEqual(['📈 AAPL reached your high: 161.00 USD (limit 160.00)'])
    expect(w.played).toEqual(['sounds/high.wav'])
    prices.AAPL = 165
    await w.clock.advance(60_000)
    expect(w.toasts.length).toBe(1)
    expect(w.statuses.at(-1)).toBe('AAPL 165.00 ▲ HIGH')
  })

  test('the low plays the falling chime; coming back inside re-arms; crossing again alerts again', async ($, on) => {
    const prices: Prices = { AAPL: 150 }
    const w = world(on, prices)
    await $.command.run(cmd('add AAPL low 140 high 160'))
    await w.clock.advance(10)
    prices.AAPL = 139
    await w.clock.advance(60_000)
    expect(w.played).toEqual(['sounds/low.wav'])
    prices.AAPL = 150
    await w.clock.advance(60_000)
    prices.AAPL = 138
    await w.clock.advance(60_000)
    expect(w.toasts.length).toBe(2)
    expect(w.played).toEqual(['sounds/low.wav', 'sounds/low.wav'])
  })

  test('a price already past a new limit alerts on the first check', async ($, on) => {
    const w = world(on, { NVDA: 150 })
    await $.command.run(cmd('add NVDA high 100'))
    await w.clock.advance(10)
    expect(w.toasts.length).toBe(1)
  })

  test('changing a limit re-arms it', async ($, on) => {
    const prices: Prices = { AAPL: 170 }
    const w = world(on, prices)
    await $.command.run(cmd('add AAPL high 160'))
    await w.clock.advance(10)
    expect(w.toasts.length).toBe(1)
    await $.command.run(cmd('add AAPL high 165'))
    await w.clock.advance(10)
    expect(w.toasts.length).toBe(2)
  })

  test('muting silences the chime but not the toast', async ($, on) => {
    const prices: Prices = { AAPL: 150 }
    const w = world(on, prices)
    await $.command.run(cmd('add AAPL high 160'))
    await w.clock.advance(10)
    await $.command.run(cmd('mute'))
    prices.AAPL = 161
    await w.clock.advance(60_000)
    expect(w.toasts.length).toBe(1)
    expect(w.played).toEqual([])
  })

  test('the sound setting: off plays nothing, voice also speaks', { options: { sound: 'off' } }, async ($, on) => {
    const w = world(on, { AAPL: 170 })
    await $.command.run(cmd('add AAPL high 160'))
    await w.clock.advance(10)
    expect(w.toasts.length).toBe(1)
    expect(w.played).toEqual([])
  })

  test('chime and voice says the ticker', { options: { sound: 'chime and voice' } }, async ($, on) => {
    const w = world(on, { 'BTC-USD': 70000 })
    await $.command.run(cmd('add BTC-USD high 60000'))
    await w.clock.advance(10)
    expect(w.spoken).toEqual(['BTC USD reached your high'])
  })

  test('on Windows the chime plays through PowerShell instead of the engine', async ($, on) => {
    const w = world(on, { AAPL: 170 }, { OS: 'Windows_NT' })
    await $.command.run(cmd('add AAPL high 160'))
    await w.clock.advance(10)
    expect(w.ps.length).toBe(1)
    expect(w.ps[0]).toContain('powershell -NoProfile -NonInteractive -Command')
    expect(w.ps[0]).toContain('Media.SoundPlayer')
    expect(w.ps[0]).toContain('\\sounds\\high.wav')
    expect(w.played).toEqual([])
  })

  test('another session already alerted: this one stays quiet', async ($, on) => {
    const w = world(on, { AAPL: 170 })
    await $.command.run(cmd('add AAPL high 160'))
    await w.clock.advance(10)
    expect(w.toasts.length).toBe(1)
    // A second session polling the same store sees fired:'high' and does not alert again.
    await w.clock.advance(60_000)
    await w.clock.advance(60_000)
    expect(w.toasts.length).toBe(1)
  })

  test('a failing fetch is shown on the row and does not stop later checks', async ($, on) => {
    const prices: Prices = { AAPL: new Error('down') }
    const w = world(on, prices)
    await $.command.run(cmd('add AAPL high 160'))
    await w.clock.advance(10)
    const r = await $.command.run(cmd('list'))
    expect(r.text).toContain('price service returned 503')
    prices.AAPL = 170
    await w.clock.advance(60_000)
    expect(w.toasts.length).toBe(1)
  })

  test('an unknown symbol reports the service message', async ($, on) => {
    const w = world(on, {})
    await $.command.run(cmd('add ZZZZZ high 5'))
    await w.clock.advance(10)
    expect((await $.command.run(cmd('list'))).text).toContain('No data found')
  })

  test('remove, list and the ticker limit', async ($, on) => {
    const w = world(on, { A: 1, B: 2 })
    await $.command.run(cmd('add A high 5'))
    await $.command.run(cmd('add B low 1'))
    await w.clock.advance(10)
    expect((await $.command.run(cmd('list'))).text.split('\n').length).toBe(2)
    expect((await $.command.run(cmd('rm A'))).text).toBe('Stopped watching A.')
    expect((await $.command.run(cmd('rm A'))).text).toContain('not on the list')
    expect((await $.command.run(cmd('rm B'))).text).toBe('Stopped watching B.')
    expect(w.statuses.at(-1)).toBe(undefined)
    expect((await $.command.run(cmd('list'))).text).toBe('Stock watch: nothing watched yet.')
  })

  test('at most 20 tickers; a bad command explains itself', async ($, on) => {
    const w = world(on, {})
    for (let i = 0; i < 20; i++) await $.command.run(cmd(`add T${i} high 5`))
    expect((await $.command.run(cmd('add EXTRA high 5'))).text).toContain('up to 20')
    expect((await $.command.run(cmd('add T0 high 9'))).text).toContain('Watching T0')
    expect((await $.command.run(cmd('nonsense'))).text).toContain('Usage')
    await w.clock.advance(10)
  })

  test('the poll interval comes from the setting and never goes under 30 seconds', { options: { pollSeconds: 5 } }, async ($, on) => {
    const w = world(on, { AAPL: 150 })
    await $.command.run(cmd('add AAPL high 160'))
    await w.clock.advance(5_000) // the first checks: right after adding, and 2 s after starting
    const n = w.fetched.length
    await w.clock.advance(20_000)
    expect(w.fetched.length).toBe(n)
    await w.clock.advance(10_000)
    expect(w.fetched.length).toBe(n + 1)
  })

  test('/stock test plays both chimes', async ($, on) => {
    const w = world(on, {})
    const r = await $.command.run(cmd('test'))
    expect(w.played).toEqual(['sounds/high.wav', 'sounds/low.wav'])
    expect(r.text).toContain('high chime')
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the ${surface} pane lists tickers, adds one from the box and removes one`, async ($, on) => {
      const w = world(on, { AAPL: 150, NVDA: 120 })
      await $.command.run(cmd('add AAPL low 140 high 160'))
      await w.clock.advance(10)
      const ui = await $.ui.mount({
        plugin: 'stock-watch',
        surface,
        component: 'Pane',
        requestId: 'stock-watch',
        props: { title: 'Stock watch', isFocused: true, bodyColumns: 84, placement: 'dock', scroll: { offset: 0, bodyRows: 22 }, view: {} },
      } as never)
      expect(await ui.find({ type: 'Text', text: /AAPL/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /low 140\.00  \[.*●.*\]  high 160\.00/ })).toBeDefined()
      await ui.input({ key: 'add', text: 'NVDA 100 130', submit: true } as never)
      await w.clock.advance(10)
      expect(await ui.find({ type: 'Text', text: /NVDA/ })).toBeDefined()
      await ui.press({ key: 'rm-AAPL' })
      await w.clock.advance(10)
      expect(await ui.find({ type: 'Text', text: /AAPL/ })).toBeUndefined()
      await ui.press({ key: 'mute' })
      await w.clock.advance(10)
      expect(await ui.find({ type: 'Button', text: 'Unmute' } as never)).toBeDefined()
      await ui.unmount()
    })
  }
})

describe('watch list setting', () => {
  const start = ($: any) => $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  test('tickers in the setting are watched when a session starts', { options: { watchlist: 'AAPL 180 200; nvda high 140;BTC-USD low 60000' } }, async ($, on) => {
    const w = world(on, { AAPL: 190, NVDA: 120, 'BTC-USD': 65000 })
    await start($)
    const list = (await $.command.run(cmd('list'))).text
    expect(list).toContain('AAPL')
    expect(list).toContain('NVDA')
    expect(list).toContain('BTC-USD')
    expect(list).toContain('low 180.00  high 200.00')
    await w.clock.advance(3_000)
    expect(w.fetched.length).toBe(3)
  })

  test('the same setting does not undo a later /stock change', { options: { watchlist: 'AAPL 180 200' } }, async ($, on) => {
    world(on, { AAPL: 190 })
    await start($)
    await $.command.run(cmd('add AAPL high 250'))
    await start($)
    expect((await $.command.run(cmd('list'))).text).toContain('high 250.00')
  })

  test('a bad entry is named in a toast and the rest still apply', { options: { watchlist: 'AAPL 180 200; nonsense words here' } }, async ($, on) => {
    const w = world(on, { AAPL: 190 })
    await start($)
    expect(w.toasts.some(t => t.includes('"nonsense words here"'))).toBe(true)
    expect((await $.command.run(cmd('list'))).text).toContain('AAPL')
  })
})

describe('chime and open', () => {
  test('chime on and off for everything, and per ticker', () => {
    expect(parseCommand('chime off')).toEqual({ kind: 'chime', on: false })
    expect(parseCommand('chime on')).toEqual({ kind: 'chime', on: true })
    expect(parseCommand('AAPL chime off')).toEqual({ kind: 'quiet', sym: 'AAPL', quiet: true })
    expect(parseCommand('brk-b chime on')).toEqual({ kind: 'quiet', sym: 'BRK-B', quiet: false })
    expect(parseCommand('chime maybe')).toEqual({ kind: 'error', text: expect.stringContaining('chime on') })
  })

  test("the baseline is today's open from the latest candle", () => {
    const text = JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 344.7, chartPreviousClose: 340.97, currency: 'USD' }, indicators: { quote: [{ open: [338, 344.67] }] } }], error: null } })
    expect(parseQuote(text)).toMatchObject({ price: 344.7, prev: 340.97, open: 344.67 })
  })
})

describe('chime and open in the pane', () => {
  test('/stock chime off mutes every ticker; a quiet ticker keeps its toast and loses its chime', async ($, on) => {
    const prices: Prices = { AAPL: 150, NVDA: 120 }
    const w = world(on, prices)
    await $.command.run(cmd('add AAPL high 160'))
    await $.command.run(cmd('add NVDA high 130'))
    await $.command.run(cmd('AAPL chime off'))
    await w.clock.advance(10)
    prices.AAPL = 161
    prices.NVDA = 131
    await w.clock.advance(60_000)
    expect(w.toasts.length).toBe(2)
    expect(w.played).toEqual(['sounds/high.wav'])
    await $.command.run(cmd('chime off'))
    expect((await $.command.run(cmd('list'))).text).toContain('AAPL')
  })
})

describe('price only', () => {
  test('a ticker with no limits shows its price and never alerts', async ($, on) => {
    const prices: Prices = { AAPL: 150 }
    const w = world(on, prices)
    const r = await $.command.run(cmd('add AAPL'))
    expect(r.text).toContain('price only')
    await w.clock.advance(10)
    expect(w.statuses.at(-1)).toBe('AAPL 150.00 ▲')
    prices.AAPL = 500
    await w.clock.advance(60_000)
    expect(w.toasts.length).toBe(0)
    expect(w.played).toEqual([])
  })

  test('adding a limit to a price-only ticker keeps it on the list', async ($, on) => {
    const w = world(on, { AAPL: 150 })
    await $.command.run(cmd('add AAPL'))
    const r = await $.command.run(cmd('add AAPL high 160'))
    expect(r.text).toBe('Watching AAPL, alert at or above 160.00.')
    expect((await $.command.run(cmd('list'))).text).toContain('high 160.00')
    expect(w.toasts.length).toBe(0)
  })
})

describe('status line settings', () => {
  test('hide leaves the line empty but keeps the watch and alerts', { options: { statusLine: 'hide' } }, async ($, on) => {
    const prices: Prices = { AAPL: 150 }
    const w = world(on, prices)
    await $.command.run(cmd('add AAPL high 160'))
    await w.clock.advance(10)
    expect(w.statuses.filter(x => x !== undefined)).toEqual([])
    prices.AAPL = 161
    await w.clock.advance(60_000)
    expect(w.toasts.length).toBe(1)
  })

  test('the count setting limits how many tickers show, between 1 and 5', { options: { statusCount: 1 } }, async ($, on) => {
    const w = world(on, { AAPL: 150, NVDA: 120 })
    await $.command.run(cmd('add AAPL'))
    await $.command.run(cmd('add NVDA'))
    await w.clock.advance(10)
    expect(w.statuses.at(-1)).toBe('AAPL 150.00 ▲ +1')
  })
})

describe('stock on and off', () => {
  test('parsing: on and off take no arguments', () => {
    expect(parseCommand('off')).toEqual({ kind: 'power', on: false })
    expect(parseCommand('ON')).toEqual({ kind: 'power', on: true })
    expect(parseCommand('off now')).toMatchObject({ kind: 'error', text: expect.stringContaining('/stock on | off') })
  })

  test('off stops price checks and clears the price line; nothing alerts while off', async ($, on) => {
    const prices: Prices = { AAPL: 150 }
    const w = world(on, prices)
    await $.command.run(cmd('add AAPL high 160'))
    await w.clock.advance(10)
    const fetchedBefore = w.fetched.length
    expect(await $.command.run(cmd('off'))).toMatchObject({ text: expect.stringContaining('Prices are not checked') })
    expect(w.statuses.at(-1)).toBe(undefined)
    prices.AAPL = 200
    await w.clock.advance(5 * 60_000)
    expect(w.fetched.length).toBe(fetchedBefore)
    expect(w.toasts.length).toBe(0)
  })

  test('while off, check says so and a new ticker is saved but not checked', async ($, on) => {
    const w = world(on, { AAPL: 150 })
    await $.command.run(cmd('off'))
    expect((await $.command.run(cmd('check'))).text).toContain('Run /stock on first')
    expect((await $.command.run(cmd('add AAPL high 160'))).text).toContain('not checked until /stock on')
    await w.clock.advance(60_000)
    expect(w.fetched.length).toBe(0)
    expect((await $.command.run(cmd('list'))).text).toContain('AAPL')
  })

  test('on resumes checking at once and the watch list is still there', async ($, on) => {
    const w = world(on, { AAPL: 150 })
    await $.command.run(cmd('add AAPL high 160'))
    await $.command.run(cmd('off'))
    expect(await $.command.run(cmd('on'))).toMatchObject({ text: 'Stock watch: on. Checking prices now.' })
    await w.clock.advance(10)
    expect(w.statuses.at(-1)).toBe('AAPL 150.00 ▲')
  })
})
