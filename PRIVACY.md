# Privacy

This policy covers every mod in the mod-squad repository. The mods are plugins that run on your own computer, inside Claude Code. The author runs no server and no service for them, receives no data from them, and collects no analytics or telemetry.

## What leaves your machine

Only two kinds of data ever leave your computer, and only for the mods named below:

- **Model calls through Claude Code.** model-router, turn-recap, standup and session-graph call a Claude model through Claude Code's own model access, the same way Claude Code already sends your conversation to Claude. What each one sends is listed below.
- **Ticker symbols.** stock-watch sends the ticker symbols you choose to Yahoo Finance's public price endpoint to fetch prices. Nothing else is sent with them.

No mod sends data anywhere else.

## Each mod

| Mod | Reads | Sends | Stores on your machine |
| --- | --- | --- | --- |
| model-router | The prompt you type | In `auto` mode, your prompt text to a Claude model (Haiku 5.5 by default) to choose a model and effort. The `heuristic` setting turns this off. | Your chosen mode and pin |
| burn-rate | Your Claude Code session transcripts in `~/.claude/projects/` | Nothing | Aggregated token counts and costs |
| context-gauge | The context size Claude Code reports | Nothing | Whether the band is hidden |
| safety-net | The tool calls Claude makes | Nothing | Nothing. A count of blocks is kept in memory for the session only. |
| secret-scrubber | Tool output | Nothing | Nothing. Counts of what was redacted are kept in memory for the session only. |
| turn-recap | The answer at the end of a long turn | The answer, clipped to about 8,000 characters, to a Claude model to write a one-line recap | Whether recaps are on, and the last recap |
| standup | Your session transcripts for the chosen day | When you press Generate, a digest of each session (your requests, commits, changed file names and the closing message, clipped to about 6 KB) to a Claude model | The standup as a markdown file in `~/standups` (unless the folder setting is `off`), and cached summaries |
| session-graph | Each session's latest request and answer, and the files it edited | The latest request, the answer clipped to 1,500 characters, and file names, to a Claude model to name the session's topics | One small file per session in `~/.claude/session-graph`: a title (your first prompt, clipped), summary, topics, findings and file paths |
| stock-watch | Nothing of yours | The ticker symbols you choose, to Yahoo Finance | Your watch list and settings |
| ping | How long each turn took | Nothing | Whether pings are on |

## Your control

- Every mod can be turned off with the toggle next to it in `/plugin`, or uninstalled there. Most also have an off command, listed in the [README](README.md#turning-a-mod-off).
- The files the mods keep are on your computer. Delete the folders named above, or uninstall the mod, to remove them.

## Children

The mods are developer tools and are not aimed at anyone under 18.

## Contact

Questions about this policy: open an issue at https://github.com/TroyJLorents-GH/mod-squad/issues.
