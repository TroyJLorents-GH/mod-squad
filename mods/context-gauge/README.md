# context-gauge

A band above the prompt showing how full the context window is:

```
context ▕██████████░░░░░░▏ 62% · 620k / 1M
```

The bar shades green → orange (50%) → red (`warnAt`, default 80%) as it fills and is sized to the band's width. From `warnAt` it adds `· /compact soon`, and it toasts once when the fill crosses `warnAt` and once at 90% (re-armed if the fill drops back, e.g. after `/compact`). It refreshes after every main-loop step and turn. Before the first response of a session (or right after a compaction) it draws nothing.

```
/plugin marketplace add troyjlorents-gh/mod-squad
/plugin install context-gauge@mod-squad
```

- **Commands:** `/gauge` shows the current numbers as text; `/gauge hide`, `/gauge show`, `/gauge toggle` hide or show the band (remembered across sessions).
- **Settings:** `warnAt` (number, default 80): the percentage that turns the bar red, adds the hint and fires the first toast.

The figures are the status line's: input tokens of the last main-loop response over the session model's window.

Test: `claude plugin test mods/context-gauge`. Validate: `claude plugin validate mods/context-gauge`.
