# session-graph

A knowledge graph across your Claude Code sessions. If you run a dozen sessions at once, you will eventually be discussing the same thing in two of them without knowing it. This mod notices and tells you.

After each substantial turn, a small model names what the session is about: a one-line summary, a few topics ("auth token refresh", "orders pagination") and key findings. Together with the files the session edited, that is written as one small JSON file in a shared folder. Every session also reads the others' files. When two sessions overlap, you get a toast:

> session-graph: "Fixing the JWT token refresh race" in peptideiq also covers auth token refresh, mobile login flow. /graph to see it

An idle session notices too: it re-reads the folder every minute, so a new connection from another session reaches you without a turn.

`/graph` opens a pane with this session's topics, each connected session and what you share, and a tree grouped by topic. **Pull in** (or `/graph pull 1`) attaches that session's summary and findings to your next prompt as background, so the two lines of work can merge. It is labeled as reference notes, not instructions, and rides along once.

## Install

```
/plugin marketplace add troyjlorents-gh/mod-squad
/plugin install session-graph@mod-squad
```

Install it once; every session on that machine picks it up.

## Commands

- `/graph`: opens the pane.
- `/graph pull <n>`: attaches connection `n`'s findings to the next prompt.
- `/graph off` / `/graph on`: stops recording this session and makes other sessions skip it, or turns it back on.

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
| `model` | `claude-haiku-5-5` | Names each session's topics. Haiku is the default because it is a short, frequent extraction and about 20x cheaper than Sonnet. |
| `sensitivity` | `normal` | See the table above. |
| `windowDays` | 7 | Sessions last active longer ago than this are not compared. |
| `folder` | blank (`~/.claude/session-graph`) | The shared folder. Use the same one on every session you want linked. |

## Cost and privacy

- At most one small-model call per session every 90 seconds, only after an answer of 150+ characters or an edit. The prompt is the latest request, the answer clipped to 1,500 characters, and file names.
- The files in the shared folder are plain text and hold summaries, topics, findings and file paths. They are never sent anywhere but the model call that writes them. Turn a session off with `/graph off`, or delete the folder.
- Another session's findings are only attached when you press **Pull in**.

## Limits

- It links sessions on one machine. Cloud sessions and your other computers are not included.
- It matches by topic names, not meaning: there is no embedding step. It catches "same feature, same bug, same files" well and loose overlaps less reliably. Lower the sensitivity to catch more.
- Alerts come from a once-a-minute re-read and from each turn, so a link can take up to a minute to appear.
