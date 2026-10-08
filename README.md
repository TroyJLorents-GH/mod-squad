# mod-squad

A marketplace of [Claude Code](https://claude.com/claude-code) mods: small plugins that add live panes, guards and smarter defaults.

> The mod API is early access and may change between Claude Code releases.

## Install

```
/plugin marketplace add troyjlorents-gh/mod-squad
/plugin install <mod> --marketplace troyjlorents-gh/mod-squad
```

## Mods

| Mod | What it does |
| --- | --- |
| [`model-router`](mods/model-router) | Picks the cheapest model + effort per turn (Haiku 5.5 → Sonnet 5.5 → Opus 5.5 → Fable 5.1) and shows a green → red cost ladder in a side pane. |

## Adding a mod

Put it in `mods/<name>/` (`.claude-plugin/plugin.json`, `hooks/`, `tests/`), list it in `.claude-plugin/marketplace.json`, then run `claude plugin validate mods/<name>` and `claude plugin test mods/<name>`.
