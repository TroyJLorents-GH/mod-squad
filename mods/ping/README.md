# ping

Plays a chime and shows a toast when a long Claude Code turn finishes, so you can walk away.

```
/plugin marketplace add troyjlorents-gh/mod-squad
/plugin install ping@mod-squad
```

- **Done:** a turn that ran at least `minSeconds` plays a two-note chime and toasts `✔ Done in 2m 14s`.
- **Error / refusal:** a low two-note chime and `✖ Turn ended: error after 1m 3s`.
- **Aborted (Esc):** nothing; you're already there. Subagent turns never ping.
- **Waiting on you:** when a tool call needs your approval after the turn has run `minSeconds`, a soft single tone and `⏳ Waiting for your approval (Bash) after 45s`. (In auto mode the classifier may answer the ask before you do.)
- **Commands:** `/ping` shows settings, `/ping on`, `/ping off` (remembered across sessions), `/ping test` plays the done chime.
- **Settings:** `minSeconds` (default 30), `sound` (default on; off = toast only).

Sound depends on the surface: it plays with `afplay` on macOS; Linux/Windows terminals and remote/mobile sessions
have no player, so you get the toast only.

Chimes live in `sounds/` (44.1 kHz mono 16-bit WAV); regenerate them with `python3 scripts/make-sounds.py`.

Test: `claude plugin test mods/ping`. Validate: `claude plugin validate mods/ping`.
