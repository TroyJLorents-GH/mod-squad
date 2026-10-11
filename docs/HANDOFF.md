# Handoff: mod-squad

Where things stand, what was decided, and what still needs a live check. Written so a new Claude Code session can pick up the work without the earlier conversation.

## What this repo is

`mod-squad` is a public Claude Code marketplace of small mods (function hooks plugins). It is installed with:

```
/plugin marketplace add troyjlorents-gh/mod-squad
/plugin install <mod>@mod-squad
```

Each mod lives in `mods/<name>/` with a `.claude-plugin/plugin.json`, `hooks/`, `tests/`, `types/` and a README. The marketplace index is `.claude-plugin/marketplace.json`. The top-level README is the public face and has the mod table, which must stay in sync with the marketplace list.

## Mods and status

| Mod | Version | Tests | Live-checked | Notes |
| --- | --- | --- | --- | --- |
| model-router | 0.4.0 | 16 | Yes, on 0.3.x | Routes each turn across Haiku, Sonnet, Opus and Fable. 0.4.0 adds a classifier model setting and a starting floor. The 0.4.0 settings are not yet checked live. |
| burn-rate | 0.1.1 | 19 | Yes | `/burn` cost dashboard from local transcripts. Light-mode colour fixed in 0.1.1. |
| standup | 0.1.1 | 24 | No | `/standup` pane with Generate, Today and Yesterday. Writes a dated markdown file. Model and effort are pickers. |
| session-graph | 0.1.2 | 28 | No | Cross-session topic graph in a shared folder. Alerts on overlap, and `/graph pull` brings another session's findings in. 0.1.2 starts polling on any surface. Alerts have not been seen working end to end. |
| stock-watch | 0.1.0 | 30 | No | `/stock` watches tickers and plays a chime and shows a toast at a low or high. Price fetch uses an unofficial Yahoo endpoint. The fetch has not been run against live data. |
| context-gauge | 0.1.0 | 11 | Earlier | Context-window band above the prompt. |
| ping | 0.1.0 | 13 | Earlier | Chime and toast when a long turn finishes. Kept for the video, but not a favourite. |
| safety-net | 0.1.0 | 28 | Earlier | Blocks destructive commands and writes to secret files. |
| secret-scrubber | 0.1.0 | 40 | Earlier | Redacts keys and tokens from tool output. |
| turn-recap | 0.1.0 | 11 | Earlier | One-line TL;DR under long answers. |

Test counts are from `claude plugin test .` in each mod folder. Run `claude plugin validate .` as well before pushing.

## Platform facts

- Mods draw in the terminal and in **local** Code sessions in the Claude Desktop app. Cloud sessions draw nothing.
- A desktop window mirroring a session that a terminal started draws only in that terminal.
- Mods run where Claude Code runs. Install and test on the machine you use.
- Sound: macOS plays clips through the engine. Windows has no engine player, so stock-watch calls PowerShell `SoundPlayer` instead. The Windows desktop app may be silent.
- Settings in `userConfig` show as a list (`options`) or a text box. Keep labels short. The settings screen aligns values to the longest label.
- `$.store` is shared across sessions on one machine. Running sessions keep their own in-memory state, so a change in one session reaches new sessions only.

## Decisions

- **Haiku is the default for background summarising** (standup, session-graph, turn-recap). Each mod exposes a model setting. Sonnet, Opus and Fable are allowed.
- **Effort defaults to low** for summaries. Higher effort raises the output-token cap.
- **No cross-machine sync.** session-graph and stock-watch only see the machine they run on.
- **Mods never sell or push data.** burn-rate and session-graph read local files. stock-watch sends a ticker symbol to a public price endpoint. Say so in the README.
- **Mod API is early access.** Don't rely on undocumented behaviour. Check the types at `plugin-authoring` before using an API.

## Known gaps and next steps

1. **Check model-router 0.4.0 live.** Set `classifierModel` to Sonnet and `floor` to Sonnet, then confirm a trivial prompt starts on Sonnet low.
2. **Check session-graph alerts end to end.** Run two sessions on the same machine on the same feature. Look for a toast and for `/graph` listing the other session. If the folder `~/.claude/session-graph` has no files, the mod is not recording. Check the Errors tab.
3. **Check stock-watch live.** Add a real ticker with a limit near the current price. Confirm the price fills in, `/stock test` plays both chimes, and a crossing alerts once. Check the fetch error text if it fails.
4. **Check standup on a real day.** Run Generate for today. Check that each project section lists real completed work and that the saved file appears.
5. **Jev.** TypeSafe AI's Jev returns typed decisions rather than chat. Early access is waitlisted. It could replace the model-router classifier, but the API has not been verified and nothing is built.
6. **Windows sound in the desktop app** is unverified. Test with `/stock test`.
7. **Video.** The user is making a YouTube video on the mods. Demo order is up to them. Ping is the weakest demo.

## Working agreements

- Commit messages end with the Co-Authored-By and Claude-Session trailers that the user asked for. Do not put the model identifier in commits, PRs, code comments or docs in this repo.
- Do not create a pull request unless the user asks.
- Before pushing a mod change: run `claude plugin validate .` and `claude plugin test .` in that mod folder. Bump its `plugin.json` version. Update its README if a setting or command changed. Update `marketplace.json` and the top-level table if a mod is added.
- Tell the user to run `claude plugin marketplace update mod-squad` and then `claude plugin update <mod>@mod-squad` after a push. Remind them to start a new session, because hooks load at session start.

## Local setup

- The user clones this repo on the Mac and the Beelink (Windows PC). Install mods on whichever machine the user is working on.
- Desktop Commander tooling reached the Mac during development. It is not needed to continue the work.
