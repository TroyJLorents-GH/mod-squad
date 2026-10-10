# standup

Click **Generate** and get a written standup of what you got done, grouped by project, from your local Claude Code sessions.

`/standup` opens a pane with **Generate**, **Today** and **Yesterday** buttons. Generate reads the day's session transcripts, boils each session down to a digest (what you asked, the commits it made, the files it changed, and the assistant's closing message), has a small model write the "done" and "open" bullets, then merges every project's sessions into one markdown standup. The result is shown in the pane and saved as `~/standups/YYYY-MM-DD.md`.

```
# Standup · 2026-10-10

## peptideiq-mobile-app
- Fixed the token refresh race in the auth client
- Added retry with backoff to the API wrapper

**Open**
- Wire up the push notification test

_2 sessions · 5 files changed · 3 commits_
```

**What counts as "done":** commits, files changed and the assistant's closing message. A request alone never counts as completed work. If nothing finished, the goal is listed under **Open**.

**Cost:** one small-model call per session, clipped to about 6 KB, so a busy day with 20 sessions costs a few cents on Haiku 5.5. Each session's summary is cached, so pressing Generate again only pays for sessions that changed.

## Install

```
/plugin marketplace add troyjlorents-gh/mod-squad
/plugin install standup@mod-squad
```

## Commands

- `/standup`: opens the pane.
- `/standup today`, `/standup yesterday`, `/standup 2026-10-08`: picks that day and generates it.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `model` | `claude-haiku-5-5` | Writes each session's summary. Haiku is the default because this is high-volume summarizing, about 20x cheaper than Sonnet. Use `claude-sonnet-5-5` for sharper wording. |
| `folder` | blank (`~/standups`) | Where each standup is saved. Type `off` to save nothing. |
| `maxSessions` | 40 | Most sessions summarized per standup, newest activity first. |

## Limits

- It reads the transcripts on the machine it runs on. Cloud sessions, and sessions on your other computers, are not included.
- Subagent transcripts are not listed separately; they belong to their parent session.
- Transcripts over 4 MB are read from their last 3.5 MB, which covers recent days.
- A session that crosses midnight is split: only the chosen day's activity counts.
