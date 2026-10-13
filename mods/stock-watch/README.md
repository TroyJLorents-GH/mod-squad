# stock-watch

**Watch stock and crypto prices from inside Claude Code, and get a chime and a toast when one reaches a low or a high you set.** Or set no limits at all and just keep an eye on the price. It's a mod: a plugin whose code runs inside Claude Code.

It shows your tickers on one small line under the prompt:

```text
stock-watch  AAPL 342.46 ▲ · NVDA 227.35 ▼ · BTC-USD 83,094 ▲ +2
```

- **▲ / ▼**: the price is above or below today's open. (Until the open is known, it compares with the previous close.)
- **`+2`**: two more tickers are watched but not shown. The `/stock` pane shows all of them.
- **`HIGH` / `LOW`**: appears after a ticker once it has hit one of your limits, for example `AAPL 351.20 ▲ HIGH`.

## Quick start

```text
/stock add AAPL                        just watch the price, no alerts
/stock add AAPL low 335 high 350       alert at 335 or below, and at 350 or above
/stock NVDA 120 140                    shorthand: low then high
/stock add BTC-USD high 90000          one limit is fine
```

Each command answers with what it did:

```text
> /stock add AAPL
Watching AAPL: price only, no alerts. Add a limit any time with /stock add AAPL low 180 high 200.

> /stock add AAPL low 335 high 350
Watching AAPL, alert at or below 335.00, alert at or above 350.00.

> /stock add BTC-USD high 90000
Watching BTC-USD, alert at or above 90,000.
```

## What an alert looks like

When a price reaches a limit you get a toast that stays for 30 seconds, and a chime. A **rising** chime means your **high** was reached, a **falling** chime means your **low** was reached.

```text
📈 AAPL reached your high: 350.40 USD (limit 350.00)
📉 NVDA fell to your low: 118.90 USD (limit 120.00)
```

- Each limit alerts **once**. It re-arms when the price comes back inside your low and high, or when you change the limit.
- A price already past a limit when you add it alerts on the first check.
- A ticker with no limits never alerts. It only shows its price.

## High and low

Say the limits with words or with two prices:

| You type | Meaning |
| --- | --- |
| `/stock add AAPL low 335 high 350` | Alert at or below 335, and at or above 350. |
| `/stock add AAPL high 350` | Only the high. |
| `/stock add AAPL below 335` | `below` and `under` mean low. |
| `/stock add AAPL above 350` | `above` and `over` mean high. |
| `/stock AAPL 350 335` | Two prices: the smaller is the low, the larger is the high. |
| `/stock AAPL 350` | One bare price is ambiguous, so it asks you to say `low` or `high`. |

The low must be below the high. Run the same command again to change a limit. It keeps the ticker and replaces only what you give it.

## Chime on and off

The chime is the sound. The toast always shows, so you never miss an alert.

```text
> /stock chime off
Stock watch: chime off for every ticker. Toasts still show.

> /stock chime on
Stock watch: chime on.

> /stock AAPL chime off
Stock watch: AAPL chime off. Its toast still shows.

> /stock AAPL chime on
Stock watch: AAPL chime on.
```

- `/stock chime off` and `/stock chime on` set it for **every** ticker. `mute` and `unmute` do the same thing.
- `/stock AAPL chime off` and `/stock AAPL chime on` set it for **one** ticker. A ticker with its chime off shows `chime off` on its row in the pane.
- The Alert sound setting can also turn the chime off for good, or add a spoken ticker on macOS.

## Removing a ticker

```text
> /stock rm AAPL
Stopped watching AAPL.
```

- **Quick:** `/stock rm AAPL`, or the **Remove** button on its row in the pane.
- **Permanently:** a ticker in the **Watch list** setting comes back whenever that setting's text changes, because every entry in it is re-added. To remove it for good, run `/stock rm AAPL` and also delete its entry from the Watch list.

## The pane

`/stock` opens a pane with a box to add tickers, and one pill per ticker. Each pill has a border that is **green** when the price is above today's open and **red** when it is below. The colours don't show in text, but this is the layout:

```text
 Add  [ AAPL   or   AAPL 180 200   or   NVDA high 140          ]

 [Check now]  [Test sound]  [Mute]

 ╭──────────────────────────────────────────────────────────╮
 │ ╭──────────────────────────────────────────────────────╮ │
 │ │ AAPL     342.46 ▲0.63%                     [Remove]  │ │   green border
 │ │ low 335.00  [·······●········]  high 350.00          │ │
 │ ╰──────────────────────────────────────────────────────╯ │
 │ ╭──────────────────────────────────────────────────────╮ │
 │ │ NVDA     118.90 ▼2.10%  chime off  LOW HIT [Remove]  │ │   red border
 │ │ low 120.00  [●···············]  high 140.00          │ │
 │ ╰──────────────────────────────────────────────────────╯ │
 │ ╭──────────────────────────────────────────────────────╮ │
 │ │ BTC-USD  83,094.31 ▲1.40%                  [Remove]  │ │   green border, no limits
 │ ╰──────────────────────────────────────────────────────╯ │
 ╰──────────────────────────────────────────────────────────╯
 Checked every 60s while a session is open. Prices come from Yahoo Finance and can lag.
```

- The percentage is the change since today's open.
- The bar shows where the price sits between your low and high. `!` marks a price at a limit. A ticker with no limits has no bar.
- `LOW HIT` and `HIGH HIT` show after a limit alerts.
- If a price can't be fetched, the reason shows in amber on that row, and the other tickers keep updating.

## Commands

| Command | Does |
| --- | --- |
| `/stock` | Opens the pane. |
| `/stock add AAPL` | Watches the price only. No limits, so no alerts and no chime. |
| `/stock add AAPL low 180 high 200` | Watches a ticker with limits. Either limit alone is fine. |
| `/stock AAPL 180 200` | Shorthand: the two prices become the low and the high, in either order. |
| `/stock rm AAPL` | Stops watching it and removes its pill. |
| `/stock chime off` / `on` | Silences or restores the chime for every ticker. Toasts always show. |
| `/stock AAPL chime off` / `on` | Silences or restores the chime for one ticker. Its toast still shows. |
| `/stock list` / `check` | Prints the list, or fetches prices now. |
| `/stock test` | Plays both chimes, high then low. |

A bare `/stock AAPL` does nothing but explain itself. Use `/stock add AAPL`, so a mistyped command is never mistaken for a ticker.

Tickers use Yahoo Finance symbols: `AAPL`, `BRK-B`, `BTC-USD`, `^GSPC`, `EURUSD=X`, `7203.T`. Up to 20 at a time.

## Install

```text
/plugin marketplace add troyjlorents-gh/mod-squad
/plugin install stock-watch@mod-squad
```

Start a new session after installing, because mods load when a session starts.

## Settings

Open the plugin's settings to change these. Tickers themselves go in the Watch list, or are added with `/stock`.

| Setting | Default | Meaning |
| --- | --- | --- |
| `watchlist` | blank | Tickers to watch, separated by semicolons: `AAPL 180 200; NVDA high 140; MSFT` (a ticker alone is price only). Applied when a session starts and whenever the text changes. `/stock` changes made later are not undone. |
| `pollSeconds` | 60 | How often prices are fetched, never under 30. |
| `sound` | `chime` | `chime`, `chime and voice` (also says the ticker aloud, macOS), or `off`. |
| `statusLine` | `show` | `show` puts the tickers under the prompt. `hide` leaves that line empty. The pane and the alerts still work. |
| `statusCount` | 3 | How many tickers the status line shows, 1 to 5. The rest show as `+N`. |

## Limits

- **It only watches while a session is open.** There is no background service. Close every session and the alerts stop.
- **Prices come from Yahoo Finance's public chart endpoint.** It is unofficial and has no key. Prices can lag by up to 15 minutes on some exchanges, outside trading hours the last price repeats, and Yahoo may rate-limit or change the endpoint. Only the ticker symbol is sent.
- **Watches are saved on the machine.** Every session you open there sees them. If several sessions are open, only the first one to notice a crossing sounds the alert.
- **Sound depends on the surface.** macOS plays it through the engine. A Windows terminal plays it through PowerShell. The Claude Desktop app on Windows may have no way to run a player, so it can be silent there, and the 30-second toast is the alert. Run `/stock test` to hear what your setup does.
- It is a notifier. It does not place trades and is not financial advice.
