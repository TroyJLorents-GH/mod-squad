# secret-scrubber

Redacts secrets from tool output before Claude Code stores it in the transcript
and before the model reads it. Each secret becomes `[REDACTED:<kind>]`; the text
around it is left as it was.

```
/plugin marketplace add troyjlorents-gh/mod-squad
/plugin install secret-scrubber@mod-squad
```

## What it redacts

| Kind | Matches |
| --- | --- |
| `aws-access-key-id` | `AKIA…` / `ASIA…` + 16 characters |
| `aws-secret` | the value of `aws_secret_access_key = …` |
| `github-token` | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_` |
| `anthropic-key` | `sk-ant-…` |
| `openai-key` | `sk-…` / `sk-proj-…` keys (32+ mixed-case characters with digits, so `sk-` in prose is left alone) |
| `azure-storage-key` | `AccountKey=…` / `SharedAccessKey=…` in connection strings |
| `azure-sas` | `SharedAccessSignature=…` and `sig=…` in connection strings and SAS URLs |
| `azure-api-key` | `api-key:` / `Ocp-Apim-Subscription-Key:` header values |
| `slack-token` | `xoxa-`, `xoxb-`, `xoxp-`, `xoxo-`, `xoxs-`, `xoxr-` |
| `stripe-key` | `sk_live_…`, `rk_live_…` |
| `google-api-key` | `AIza…` + 35 characters |
| `jwt` | three base64url segments starting `eyJ` |
| `private-key` | whole PEM `-----BEGIN … PRIVATE KEY-----` blocks (a block cut off by truncated output is redacted to its end) |
| `env-secret` | the value (only) of `KEY=value` where KEY has a `SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `API_KEY` or `PRIVATE_KEY` segment |
| `custom` | your own `extraPatterns` |

Only rows that come in as a tool's result (and rows a tool hands over beside
it) are rewritten. Your own prompts and Claude's responses are never touched.
Images and documents in tool output pass through unchanged. Token matches must
stand on their own, so key-shaped runs inside base64 data, hashes and
identifiers are not redacted, and env lines that hold references or code
(`$VAR`, `process.env.X`, `max_tokens=4096`) are left alone.

If redaction itself ever fails on a row, the scrubber fails closed: that
row's output is replaced by a short "withheld because redaction failed" notice
instead of being stored as it was.

## Commands

- `/scrub`: counts redacted this session, by kind.
- `/scrub off` / `/scrub on`: pause or resume redaction for this session.

The status line shows `🔒 N secrets redacted` once anything has been redacted,
and a toast appears the first time each kind is seen.

## Settings

- `extraPatterns` (default empty): comma-separated extra regular expressions,
  redacted as `[REDACTED:custom]`. A pattern cannot itself contain a comma.
  Invalid ones (or ones that match an empty string) are ignored, and a toast
  names them.

## Limits

This is pattern matching, not a guarantee: a secret in a format it does not
know (or split across lines) gets through, and an odd string that looks like a
key may be redacted. It only sees what tools hand to the conversation: output
your own commands already printed to your terminal, files on disk, and what a
tool sends elsewhere are out of its reach. The screen may briefly show a tool
result before its redacted form is stored; the model and the transcript file
only get the redacted form.

Test: `claude plugin test mods/secret-scrubber`. Validate: `claude plugin validate mods/secret-scrubber`.
