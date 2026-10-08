# burn-rate

A cost dashboard inside Claude Code. `/burn` opens a pane that shows where your tokens went, read from the session transcripts Claude Code already keeps on your machine:

```
[ Today ] [ 7 Days ] [ 30 Days ] [ This Month ] [ 6 Months ] [ Lifetime ] [ r refresh ]
╭──────────────────────────────────────────────────────────────────────────────────────╮
│ burn-rate  7 Days  2026-10-02 → 2026-10-08 · est. at list price                      │
│ $36.75  302 calls · 1 sessions · 91% cache hit                                       │
│ tokens  in 591 · out 141k · cached 64M · written 6.2M                                │
╰──────────────────────────────────────────────────────────────────────────────────────╯
╭ Daily Activity ─────────────────────────╮ ╭ By Project ─────────────────────────────╮
│ 2026-10-08 ██████████████▊  $30.35  260 │ │ webapp  ███████████  $36.75 $36.75    1 │
│ 2026-10-07 ███▏              $6.40   42 │ │                                         │
│ Showing 1–2 of 2 days                   │ │                                         │
╰─────────────────────────────────────────╯ ╰─────────────────────────────────────────╯
  By Model · By Activity · Core Tools · Shell Commands · MCP Servers …
```

It also pins a one-line status under the prompt after each turn, such as `🔥 $12.40 today`.

Inspired by [codeburn](https://github.com/getagentseal/codeburn). This mod is written from scratch and shares no code with it.

## Install

```
/plugin marketplace add troyjlorents-gh/mod-squad
/plugin install burn-rate@mod-squad
```

## Use

- `/burn` opens the dashboard (focused; Esc closes it) and refreshes the numbers in the background. You can also pass a range: `/burn today`, `7d`, `30d`, `month`, `6m` or `lifetime`.
- Hotkeys in the pane: `t` Today, `7` 7 Days, `3` 30 Days, `m` This Month, `6` 6 Months, `l` Lifetime, `r` refresh. Tab and Enter work too. The range you pick is remembered.
- **Setting:** `defaultRange` (one of `today`, `7d`, `30d`, `month`, `6m`, `lifetime`; default `7d`) is the range the pane opens on until you pick another.

The panels:

| Panel | What it shows |
| --- | --- |
| Header | Total cost, API calls, sessions, cache-hit % (cache reads ÷ all prompt tokens), and tokens in, out, cached (read) and written (cache writes). |
| Daily Activity | One row per day, newest first. Each row has a bar coloured by its cost relative to the costliest day, the cost and the number of calls. The panel fits the pane's height and says "Showing 1–N of M". |
| By Project | The project is the last folder of the transcript's `cwd`. Shows cost, average cost per session and the number of sessions. |
| By Model | Cost, cache-hit % and calls for each model. A model with no price is listed as `(unpriced) <id>` and costs $0. |
| By Activity | Cost and turns for each kind of work (rules below). |
| Core Tools | Calls to each built-in tool. |
| Shell Commands | The first word of each Bash command. Leading `sudo`, `env X=y`, `X=y`, `cd dir &&` and `cd dir;` are stripped, so `cd app && npm test` counts as `npm`. |
| MCP Servers | `mcp__<server>__*` calls, grouped by server. |

From 100 columns up the panels sit two to a row; narrower panes stack them in one column. Names are cut to fit.

## The numbers are estimates

Costs are API **list prices** applied to the token counts in your transcripts. Batch, priority and negotiated pricing are not applied. On a Claude Max or Pro subscription you don't pay per token, so the figure is what the same usage would have cost on the API, not a bill.

Prices are in USD per million tokens. Model ids match by prefix, and the longest prefix wins:

| Model | Input | Output | Cache read |
| --- | --- | --- | --- |
| claude-fable-5-1, claude-fable-5, claude-mythos-* | 10 | 50 | 0.25 |
| claude-opus-5-5 | 4 | 20 | 0.20 |
| claude-opus-5, -4-8, -4-7, -4-6 | 5 | 25 | 0.50 |
| claude-sonnet-5-5 | 2 | 10 | 0.10 |
| claude-sonnet-5 | 2 | 10 | 0.20 |
| claude-sonnet-4-6, -4-5 | 3 | 15 | 0.30 |
| claude-haiku-5-5 (prompt ≤ 100k) | 0.10 | 0.50 | 0.01 |
| claude-haiku-5-5 (prompt > 100k) | 0.50 | 2.50 | 0.05 |
| claude-haiku-4-5 | 1 | 5 | 0.10 |

Cache writes cost 1.25× input for the 5-minute TTL and 2× input for the 1-hour TTL. The split comes from each response's `usage.cache_creation`; when a response has no split, its writes are priced at the 5-minute rate. The table lives in `hooks/pricing.ts`.

## Where the data comes from

The data is every `*.jsonl` under `~/.claude/projects/` (and under `$CLAUDE_CONFIG_DIR/projects/` if that is set), including the subagent transcripts in `<session>/subagents/`. Subagent work counts toward cost.

- **Calls:** each `assistant` line carries `message.model`, `message.usage` and `message.id`. A streamed response is written as several lines that share one `message.id` (and `requestId`), and each line repeats the usage. burn-rate counts each id once. If a later line for the same id reports more tokens (the last line has the final `output_tokens`), only the difference is added. Lines with zero usage, `<synthetic>` model lines and API-error lines are skipped.
- **Days:** a line's day is the local date of its `timestamp`. The UTC offset comes from the host's `date +%z`.
- **Sessions:** distinct `sessionId`s with calls in the range.
- **Turns:** a turn starts at each prompt you typed. Tool results, meta rows and command records don't start a turn. A turn's cost is the sum of the calls up to the next prompt.

### Activity rules

Each turn is classified from its prompt's words and the tools it used. The first rule that matches wins:

1. A test runner ran in Bash (`npm test`, `pytest`, `go test`, `cargo test`, `vitest`, …), or the prompt mentions tests: **Testing**.
2. The prompt mentions a bug, fix, error, failure, crash or debugging: **Debugging**.
3. The prompt asks to refactor, rename, clean up, simplify or extract: **Refactoring**.
4. Every edit was to a doc file (`.md`, `.mdx`, `.rst`, `.txt`, README), or the prompt is about docs or a README: **Docs**.
5. The prompt asks to add, implement, build or create something, and files were edited: **Feature Dev**.
6. Files were edited (Edit, Write, MultiEdit, NotebookEdit): **Coding**.
7. Tools ran but nothing was edited: **Exploration**.
8. No tools ran and the prompt asks how, where or what, or asks for an explanation: **Exploration**.
9. Anything else: **Conversation**.

## Performance

Scans never run inside a hook. `/burn`, the `r` button, and a refresh 5 seconds after session start (only once you've used `/burn` before) each start a scan on a `$.clock` timer. The pane says "scanning…" while one runs.

- Each file's aggregate (per day: per-model tokens and cost, activity, tool, shell and MCP counts) is kept in the mod's `$.store` with the file's size, mtime and the byte offset parsed so far. A file whose size and mtime haven't changed is not read again. A file that grew is parsed only from the stored offset.
- Files up to 4 MB are read with `$.fs.read`, which refuses anything over 4 MiB. Larger files are read 3 MB at a time from the stored offset with `sh -c 'tail -c +N file | head -c M'` through `$.process.run`. A single line longer than a chunk is skipped.
- Aggregates of transcripts that Claude Code has since cleaned up (`cleanupPeriodDays`) stay in the store, so Lifetime keeps them.
- The status line adds the cost of each finished turn (from `turn.complete`'s usage) to the last scan's total for today, so it costs nothing to compute.

Limits:

- Reading files over 4 MB needs `sh`, `tail` and `head` on the host. They are present on macOS and Linux; on Windows such files are skipped, and the pane says how many.
- `$.store` holds 4 MiB of JSON in all, which is about 2 KB per transcript. If a very large history fills it, the aggregates that don't fit are kept in memory for the session but not saved, so the next session parses those files again.
- The local-date offset is read once per scan, so days across a DST change may be off by an hour at midnight.
- Each response is counted once within its own file. If a resumed or forked session copies earlier responses into a new file, those responses are counted in both files.

## Develop

```
claude plugin validate mods/burn-rate
cd mods/burn-rate && claude plugin test .
```

The tests build synthetic transcripts in memory and mock `$.fs`, `$.store`, `$.clock`, `$.env` and `$.process`. No real transcript data is used.
