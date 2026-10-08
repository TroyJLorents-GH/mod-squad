# model-router

Routes each Claude Code turn to the cheapest model + effort that fits the task
(Haiku 5.5 → Sonnet 5.5 → Opus 5.5 → Fable 5.1) and shows the cost ladder in a side pane.

```
/plugin marketplace add troyjlorents-gh/mod-squad
/plugin install model-router@mod-squad
```

![model-router pane](../../docs/model-router-pane.png)

- **Pick:** Haiku 5.5 grades each prompt (keyword rules as fallback). Mid-turn it only moves up: risky shell commands (`terraform apply`, `kubectl apply`, `rm -rf`, ...), every 2nd failed tool call, 6+ files edited.
- **Cache-aware:** while the prompt cache is warm it only steps down when the new pick is `stickiness` dots lower.
- **Pane:** 4 models x 5 efforts (20 dots), lit dots green → orange → red, `◉` = current.
- **Commands:** `/route`, `/route auto`, `/route off`, `/route pin <haiku|sonnet|opus|fable> [effort]`.
- **Settings:** `classifier` (haiku|heuristic), `ceiling` (haiku|sonnet|opus|fable), `stickiness`.

Prices ($/MTok in/out): Haiku 5.5 0.10/0.50 (0.50/2.50 over 100k-token prompts), Sonnet 5.5 2/10, Opus 5.5 4/20, Fable 5.1 10/50.

Test: `claude plugin test mods/model-router`. Validate: `claude plugin validate mods/model-router`.
