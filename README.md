<p align="center">
  <img src="docs/mod-squad-logo.png" alt="MOD-SQUAD" width="720">
</p>

<p align="center">
  <b>Small mods for <a href="https://claude.com/claude-code">Claude Code</a>: live panes, guards and smarter defaults.</b>
</p>

> The mod API is early access and may change between Claude Code releases. Mods run in the Claude Code terminal; they are installed from a terminal session.

## Install

```
/plugin marketplace add troyjlorents-gh/mod-squad
/plugin install <mod>@mod-squad
```

## The squad

| Mod | What it does |
| --- | --- |
| [`model-router`](mods/model-router) | Picks the cheapest model + effort for every turn (Haiku 5.5 → Sonnet 5.5 → Opus 5.5 → Fable 5.1) and draws a live green → red cost ladder in a side pane. |
| [`burn-rate`](mods/burn-rate) | `/burn` opens a cost dashboard inside Claude Code: spend by day, project, model, activity, tool and shell command, read from your local session logs. No account, nothing sent anywhere. Inspired by [codeburn](https://github.com/getagentseal/codeburn). |
| [`context-gauge`](mods/context-gauge) | A band above the prompt: how full the context window is, shading green → red, with a toast before it fills up. |
| [`safety-net`](mods/safety-net) | Blocks force-pushes, `git reset --hard`, `rm -rf ~`, `terraform destroy`, `curl \| sh` and writes to `.env` / keys, and tells the model why. |
| [`secret-scrubber`](mods/secret-scrubber) | Redacts AWS, GitHub, Anthropic, OpenAI, Azure, Slack, Stripe and Google keys, JWTs and private keys from tool output before anything stores or reads it. |
| [`turn-recap`](mods/turn-recap) | A one-line TL;DR under long answers, written by Haiku 5.5 for a fraction of a cent. |
| [`ping`](mods/ping) | A chime + toast when a long turn finishes or is waiting for your approval, so you can walk away. |

Install one, or all seven: `/plugin install model-router@mod-squad`, `/plugin install safety-net@mod-squad`, ...

### model-router

![model-router pane: 4 models x 5 effort levels, lit dots shaded green to red, the active rung marked](docs/model-router-pane.png)

Every lit dot is a rung at or below what is running now; the shaded `◉` is the current model + effort. Below the ladder: why it was picked, what the last turn cost, and the running session total.

## Build your own mod

A mod is a folder in `mods/<name>/`:

```
mods/<name>/
  .claude-plugin/plugin.json
  hooks/hooks.json
  hooks/register.tsx
  tests/*.test.ts
```

List it in `.claude-plugin/marketplace.json`, then:

```
claude plugin validate mods/<name>
claude plugin test mods/<name>
```
