# stock-watch

Set tickers in the plugin settings (Watch list), or run `/stock` and enter a ticker with the low and high you care about, and get a chime and a toast when the price reaches either one.

```
/stock add AAPL low 180 high 200
/stock NVDA 120 140            (low, high)
/stock add BTC-USD high 70000
```

`/stock` opens a pane with a box to add tickers, a row per ticker with the price, the day's change and a bar showing where the price sits between your low and high, and buttons to check now, test the sound, mute, and remove a ticker. The newest prices also sit in the status line under the prompt.

- **A rising chime** plays when a price reaches your high. **A falling chime** plays at your low.
- Each limit alerts **once**. It re-arms when the price comes back inside your band, or when you change the limit.
- A price already past a limit when you add it alerts on the first check.
- Watches are saved on the machine, so every session you open there sees them. If several sessions are open, only the first one to notice a crossing sounds the alert.

## Install

```
/plugin marketplace add troyjlorents-gh/mod-squad
/plugin install stock-watch@mod-squad
```

## Commands

| Command | Does |
| --- | --- |
| `/stock` | Opens the pane. |
| `/stock add AAPL low 180 high 200` | Watches a ticker. Either limit alone is fine. `above`, `below`, `over` and `under` work too. |
| `/stock AAPL 180 200` | Shorthand: the two prices become the low and the high, in either order. |
| `/stock rm AAPL` | Stops watching it. |
| `/stock list` / `check` | Prints the list, or fetches prices now. |
| `/stock test` | Plays both chimes. |
| `/stock mute` / `unmute` | Silences or restores the sound. Toasts always show. |

Tickers use Yahoo Finance symbols: `AAPL`, `BRK-B`, `BTC-USD`, `^GSPC`, `EURUSD=X`, `7203.T`. Up to 20 at a time.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `watchlist` | blank | Tickers to watch, separated by semicolons: `AAPL 180 200; NVDA high 140`. Applied when a session starts and whenever the text changes. `/stock` changes made later are not undone. |
| `pollSeconds` | 60 | How often prices are fetched, never under 30. |
| `sound` | `chime` | `chime`, `chime and voice` (also says the ticker aloud, macOS), or `off`. |

## Limits

- **It only watches while a session is open.** There is no background service. Close every session and the alerts stop.
- **Prices come from Yahoo Finance's public chart endpoint.** It is unofficial and has no key. Prices can lag by up to 15 minutes on some exchanges, outside trading hours the last price repeats, and Yahoo may rate-limit or change the endpoint. The pane shows the reason when a fetch fails.
- **Sound depends on the surface.** macOS plays it through the engine. A Windows terminal plays it through PowerShell. The Claude Desktop app on Windows may have no way to run a player, so it can be silent there, and the 30-second toast is the alert. Run `/stock test` to hear what your setup does.
- It is a notifier. It does not place trades and is not financial advice.
