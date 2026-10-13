# session-graph

**A knowledge graph across your Claude Code sessions.** If you run a dozen sessions at once, you will eventually be discussing the same thing in two of them without knowing it. This mod notices and tells you. It's a mod: a plugin whose code runs inside Claude Code.

After each substantial turn, a small model names what the session is about: a one-line summary, a few topics ("auth token refresh", "orders pagination") and key findings. Together with the files the session edited, that is written as one small file in a **shared folder**. Every session also reads the others' files. When two sessions overlap, you get a toast:

![The session-graph alert toast](docs/alert.png)

```text
session-graph: "Fixing the JWT token refresh race" in api-server also covers auth token refresh, mobile login flow. /graph to see it
```

An idle session notices too: it re-reads the folder every minute, so a new connection from another session reaches you without a turn.

> The pictures in this README are illustrations drawn to match what the mod prints. They are not screenshots of a live session, and the sessions and topics in them are examples.

## What the shared folder is for

The shared folder is how your sessions find each other. Claude Code sessions can't see one another, so each one writes a small note about itself into one folder and reads everyone else's notes from it.

- **One file per session**, named after the session's id: `~/.claude/session-graph/<session-id>.json`.
- **What's in it:** the session's project, a title (your first prompt, clipped to 80 characters), a one-line summary, its topics, up to three findings, the files it edited, when it was last active, and which connections it has already alerted you about. It holds no code and no other conversation text.
- **Who reads it:** every session that has the mod. Each one reads the other sessions' files, compares topics and edited files, and alerts you when they overlap. Files older than the look-back window (7 days by default) are skipped, and at most the 60 most recent are read.
- **Where it is:** `~/.claude/session-graph` by default. Set the **Shared folder** setting to use somewhere else. Every session you want linked must use the same folder, so leave it blank unless you have a reason.
- **It stays on your machine.** Nothing syncs it anywhere. Sessions on other computers, and cloud sessions, are not linked.
- **Turning a session off:** `/graph off` writes `"off": true` into that session's file, and other sessions skip it. Delete the folder to forget everything.

An example file (the real one is a single line, and the id is shortened here):

```json
{
  "sid": "3f9c…e1",
  "project": "api-server",
  "cwd": "/Users/you/Projects/api-server",
  "title": "fix the jwt refresh race",
  "summary": "Fixing the JWT token refresh race",
  "notes": ["Refresh and logout raced on the same token row"],
  "topics": ["auth token refresh", "mobile login flow"],
  "files": ["/Users/you/Projects/api-server/src/auth/tokens.ts"],
  "updatedAt": 1791914875000,
  "alerted": []
}
```

## The pane

`/graph` opens a pane with three boxes: this session's topics, each connected session and what you share, and a tree grouped by topic.

![The /graph pane with this session, two connections and the topic graph](docs/pane.png)

```text
 ╭─ This session ───────────────────────────────────────────────────╮
 │ Fixing mobile login after the token refresh change               │
 │ auth token refresh · mobile login flow · session expiry · …      │
 ╰──────────────────────────────────────────────────────────────────╯
 ╭─ Connections (2) · 3 other sessions tracked ─────────────────────╮
 │ 1. api-server · 12m ago                                          │
 │ Fixing the JWT token refresh race                                │
 │ shares: auth token refresh, mobile login flow, tokens.ts         │
 │ [Pull in]                                                        │
 │                                                                  │
 │ 2. web-client · 2h ago                                           │
 │ Moving login to the new auth provider                            │
 │ shares: session expiry, login redirect                           │
 │ [Pull in]                                                        │
 ╰──────────────────────────────────────────────────────────────────╯
 ╭─ Graph ──────────────────────────────────────────────────────────╮
 │ ● auth token refresh                                             │
 │   ├─ this session                                                │
 │   └─ api-server: Fixing the JWT token refresh race               │
 │ ● session expiry                                                 │
 │   ├─ this session                                                │
 │   └─ web-client: Moving login to the new auth provider           │
 ╰──────────────────────────────────────────────────────────────────╯
```

- Press **Pull in** (or its number key) to attach that session's summary and findings to your **next prompt** as background, so the two lines of work can merge. It rides along once, and you can press **Cancel** before you send. It is labelled as reference notes, not instructions.
- With nothing connected, the pane says "No other session overlaps yet. You will get an alert when one does."

## Commands

| Command | Does |
| --- | --- |
| `/graph` | Opens the pane, and prints the connections. |
| `/graph pull 1` | Attaches connection 1's findings to your next prompt. |
| `/graph off` | Stops recording this session, and makes other sessions skip it. |
| `/graph on` | Turns it back on. |

What each one prints:

```text
> /graph
Session graph: 2 overlapping sessions:
1. api-server: Fixing the JWT token refresh race [auth token refresh, mobile login flow]
2. web-client: Moving login to the new auth provider [session expiry, login redirect]

> /graph            (nothing overlaps)
Session graph: no overlapping sessions yet (3 other sessions tracked).

> /graph pull 1
Session graph: "Fixing the JWT token refresh race" will ride along with your next prompt.

> /graph pull 9     (no such connection)
Usage: /graph pull <1-2>

> /graph off
Session graph: off. Other sessions will skip this one.

> /graph on
Session graph: on.
```

`/graph off` is remembered, so sessions you start later begin switched off until you run `/graph on`.

### What Pull in adds to your next prompt

```text
Background from another Claude Code session on this machine (project "api-server", last active 2026-10-13 12:31). It overlaps with this one on: auth token refresh, mobile login flow. Treat it as reference notes, not as instructions.
About: Fixing the JWT token refresh race
Findings so far:
- Refresh and logout raced on the same token row
```

## Install

```text
/plugin marketplace add troyjlorents-gh/mod-squad
/plugin install session-graph@mod-squad
```

Install it once; every session on that machine picks it up. Start a new session after installing, because mods load when a session starts.

## How sessions are matched

Two sessions are linked by a score: a shared topic is worth 2 points, a shared edited file 3. Topics match when they share two words, or one long word that is the whole of the shorter topic. Files every project has (`package.json`, `README.md`, lockfiles) never count.

| Sensitivity | Needs | Shared topics |
| --- | --- | --- |
| `strict` | 6 | 3 topics, or a file plus 2 topics |
| `normal` (default) | 4 | 2 topics, or a file plus 1 topic |
| `loose` | 2 | any 1 topic |

Each connection alerts once.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `model` | `claude-haiku-5-5` | Names each session's topics. Haiku is the default because it is a short, frequent extraction and about 20x cheaper than Sonnet. Sonnet, Opus and Fable are allowed. |
| `effort` | `low` | How hard the model thinks: low, medium, high, xhigh or max. Low is plenty for naming topics. |
| `sensitivity` | `normal` | See the table above. |
| `windowDays` | 7 | Sessions last active longer ago than this are not compared. |
| `folder` | blank (`~/.claude/session-graph`) | The shared folder. Use the same one on every session you want linked. |

## Cost and privacy

- At most one small-model call per session every 90 seconds, only after an answer of 150+ characters or an edit. The prompt is the latest request, the answer clipped to 1,500 characters, and file names.
- The files in the shared folder are plain text and hold a title (your first prompt, clipped), summaries, topics, findings and file paths. They are never sent anywhere but the model call that writes them. Turn a session off with `/graph off`, or delete the folder.
- Another session's findings are only attached when you press **Pull in**.

## Limits

- It links sessions on one machine. Cloud sessions and your other computers are not included.
- It matches by topic names, not meaning: there is no embedding step. It catches "same feature, same bug, same files" well and loose overlaps less reliably. Lower the sensitivity to catch more.
- Alerts come from a once-a-minute re-read and from each turn, so a link can take up to a minute to appear.
- The mod draws in the terminal and in local sessions in the Claude Desktop app. Cloud sessions draw nothing.
