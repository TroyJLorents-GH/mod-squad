# safety-net

A guard on Claude Code's tool calls: destructive shell commands and writes to secret files are
refused before they run, and Claude is told why.

```
/plugin marketplace add troyjlorents-gh/mod-squad
/plugin install safety-net@mod-squad
```

**Blocked shell commands** (also inside `&&` / `;` / `|` chains, after `sudo`/`env`/`VAR=x`, and inside `bash -c '...'`):

- `git push --force` / `-f` / `+branch` (`--force-with-lease` is allowed), `git reset --hard`, `git clean -fd` / `-fdx`, `git branch -D main|master`
- `rm -rf` (or `-fr`, `-r -f`, `--recursive --force`) on `/`, `~`, `$HOME`, `*`, `..`, the project root itself, or any absolute path outside the project. `rm -rf node_modules`, `rm -rf ./dist` and other in-project paths pass.
- `DROP DATABASE` / `DROP TABLE` / `DROP SCHEMA` / `TRUNCATE` sent to `psql`, `mysql`, `sqlcmd`, `sqlite3` and friends
- `terraform destroy` (and `apply -destroy`), `kubectl delete namespace|ns`, `chmod -R 777`
- `curl … | sh` / `wget … | bash`, `bash <(curl …)`, `sh -c "$(curl …)"`
- `mkfs*`, `dd of=/dev/…` (except `/dev/null` and friends)

**Protected files** (Edit / Write / MultiEdit / NotebookEdit): `.env`, `.env.*` (but not `.env.example`/`.sample`/`.template`),
`*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, anything under `.git/`, `secrets.*`, `credentials*`, `.npmrc`, `.pypirc`.

Each block shows a toast, and the status line keeps a count (`🛡 safety-net: 2 blocked`).

- **Commands:** `/safety-net` (status and the last few blocks), `/safety-net off` (disable for this session), `/safety-net on`.
- **Settings:** `extraProtected` — comma-separated globs for more protected files (`*.tfstate, config/prod.*`; no slash = match the file name). `allowForceWithLease` (default `true`).

**What it is not:** this is a pattern-based guard, not a sandbox. It reads the command text, so a determined
script (a variable holding the path, a command written to a file and run later, an alias, a language runtime
deleting files) gets past it. It catches the common accidents; keep your backups and permission settings.

Test: `claude plugin test mods/safety-net`. Validate: `claude plugin validate mods/safety-net`.
