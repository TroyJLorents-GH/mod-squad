# turn-recap

Adds a one-line **TL;DR** beneath long answers. When a main-loop turn ends with an answer that is long (1,200+ characters) or took a while (90+ seconds), a quick Haiku 5.5 call boils it down to one sentence of 25 words or fewer, shown under the answer. The transcript itself is never rewritten. Subagent turns, interrupted turns and errored turns are skipped. If the Haiku call fails, times out (8s) or rambles, nothing is added.

**Cost:** a single Haiku 5.5 call at low effort, and only on long turns. The answer is clipped to about 8,000 characters (head and tail) and the reply is capped at 120 tokens, so each recap costs a fraction of a cent.

## Install

```
/plugin marketplace add troyjlorents-gh/mod-squad
/plugin install turn-recap@mod-squad
```

## Commands

- `/recap`: shows whether recaps are on, plus the last one.
- `/recap on` / `/recap off`: turns recaps on or off. The setting is remembered.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `minChars` | 1200 | Recap answers at least this many characters long. |
| `minSeconds` | 90 | Also recap any answer whose turn ran at least this many seconds. |
