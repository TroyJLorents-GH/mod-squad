// Pure classification for safety-net: no engine calls, so it is unit-tested directly.

export type Verdict = { what: string; why: string }

export type CommandContext = {
  /** Project root, absolute. Paths inside it are fair game for `rm -rf`. */
  root: string
  /** Directory relative paths resolve against (the shell's cwd); defaults to root. */
  cwd?: string
  /** Home directory, when known; `~` and `$HOME` expand to it. */
  home?: string
  /** Let `git push --force-with-lease` through (default true). */
  allowForceWithLease?: boolean
}

// ---------------------------------------------------------------- shell parsing

type Segment = { words: string[]; raw: string; op: string }

/**
 * Splits a command line into simple commands at `&&`, `||`, `;`, `|`, `&` and
 * newlines, honouring quotes and backslashes. Words come back unquoted; each
 * segment records the operator that ends it.
 */
export function splitCommand(input: string): Segment[] {
  const segments: Segment[] = []
  let words: string[] = []
  let word = ''
  let hasWord = false
  let raw = ''
  let quote: '"' | "'" | null = null
  let subst = 0

  const endWord = () => {
    if (hasWord) words.push(word)
    word = ''
    hasWord = false
  }
  const endSegment = (op: string) => {
    endWord()
    if (words.length > 0) segments.push({ words, raw: raw.trim(), op })
    words = []
    raw = ''
  }

  for (let i = 0; i < input.length; i++) {
    const c = input[i] as string
    if (quote) {
      raw += c
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < input.length) {
        word += input[++i]
        raw += input[i]
      } else word += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      hasWord = true
      raw += c
      continue
    }
    if (c === '\\' && i + 1 < input.length) {
      const n = input[++i] as string
      raw += c + n
      if (n !== '\n') (word += n), (hasWord = true)
      continue
    }
    const two = input.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      endSegment(two)
      i++
      continue
    }
    if (c === ';' || c === '\n' || c === '|' || (c === '&' && input[i + 1] !== '>' && input[i - 1] !== '>')) {
      endSegment(c === '\n' ? ';' : c)
      continue
    }
    // `$(…)`, `<(…)` stay inside the word; other parens are subshells and
    // separate commands: `(cd x && rm -rf /)`.
    if (c === '(' && /[$<>]$/.test(word)) subst++
    else if (c === ')' && subst > 0) subst--
    else if (c === '(' || c === ')') {
      endSegment(';')
      continue
    }
    raw += c
    if (c === ' ' || c === '\t') endWord()
    else (word += c), (hasWord = true)
  }
  endSegment('')
  return segments
}

const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'exec', 'nohup', 'time', 'nice', 'ionice', 'builtin', 'then', 'do', 'else', '!', 'xargs'])
// Wrapper options that take a value as the next word.
const WRAPPER_ARG_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '-C', '-S']),
  nice: new Set(['-n']),
  ionice: new Set(['-c', '-n']),
  xargs: new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a']),
}

/** Drops `sudo`, `env`, `FOO=bar` and similar prefixes, leaving the real command first. */
export function stripPrefixes(words: string[]): string[] {
  let w = words
  for (let guard = 0; guard < 20 && w.length > 0; guard++) {
    const head = w[0] as string
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
      w = w.slice(1)
      continue
    }
    const name = basename(head)
    if (!WRAPPERS.has(name)) break
    let i = 1
    const argFlags = WRAPPER_ARG_FLAGS[name] ?? new Set<string>()
    while (i < w.length) {
      const x = w[i] as string
      if (x === '--') {
        i++
        break
      }
      if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(x)) {
        i++
        continue
      }
      if (!x.startsWith('-')) break
      i += argFlags.has(x) ? 2 : 1
    }
    w = w.slice(i)
  }
  return w
}

function basename(p: string): string {
  const parts = p.split('/')
  return parts[parts.length - 1] ?? p
}

/** Short flag letters (`-rf` → r,f) and long flags of a word list, up to `--`. */
function flagsOf(args: string[]): { short: Set<string>; long: Set<string>; operands: string[] } {
  const short = new Set<string>()
  const long = new Set<string>()
  const operands: string[] = []
  let done = false
  for (const a of args) {
    if (done) operands.push(a)
    else if (a === '--') done = true
    else if (a.startsWith('--')) long.add(a.split('=')[0] as string)
    else if (a.startsWith('-') && a.length > 1) for (const ch of a.slice(1)) short.add(ch)
    else operands.push(a)
  }
  return { short, long, operands }
}

// ---------------------------------------------------------------- paths

function normalize(path: string): string {
  const abs = path.startsWith('/')
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return (abs ? '/' : '') + out.join('/')
}

function isWithin(path: string, root: string): boolean {
  const r = normalize(root)
  return path === r || path.startsWith(r === '/' ? '/' : r + '/')
}

const TEMP_ROOTS = ['/tmp', '/var/tmp', '/private/tmp', '/var/folders', '/private/var/folders']

const HOME_RE = /^(~|\$HOME|\$\{HOME\})(?=\/|$)/

/** Why `rm -rf <target>` is dangerous, or null when it stays inside the project. */
export function rmTargetDanger(target: string, ctx: CommandContext): string | null {
  const t = target.trim()
  if (t === '') return null
  const root = normalize(ctx.root)
  const cwd = normalize(ctx.cwd ?? ctx.root)

  if (/^\/+\*?$/.test(t) || t === '/.' || t === '/..') return 'that wipes the whole filesystem'
  if (/^(~|\$HOME|\$\{HOME\})\/?\*?$/.test(t)) return 'that wipes your home directory'
  if (t === '*' || t === './*' || t === '.*' || t === '*/') return 'a bare glob deletes everything in the current directory'

  let abs: string
  if (HOME_RE.test(t)) {
    if (!ctx.home) return 'it is outside the project (in your home directory)'
    abs = normalize(t.replace(HOME_RE, ctx.home))
  } else if (t.startsWith('/')) abs = normalize(t)
  else if (/^\$/.test(t)) return null // unknown variable: can't judge, let it pass
  else abs = normalize(cwd + '/' + t)

  // Strip trailing glob segments so `/etc/*` is judged as `/etc`.
  const judged = normalize(abs.replace(/\/[^/]*[*?][^/]*$/, '')) || '/'
  if (judged === '/') return 'that wipes the whole filesystem'
  if (ctx.home && judged === normalize(ctx.home)) return 'that wipes your home directory'
  if (judged === root) return 'that deletes the whole project'
  // Scratch space under a temp directory is fair game (the temp root itself is not).
  if (TEMP_ROOTS.some(r => judged !== r && isWithin(judged, r))) return null
  if (!isWithin(judged, root)) return `${judged} is outside the project`
  return null
}

// ---------------------------------------------------------------- commands

const SQL_CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'sqlcmd', 'sqlite3', 'sqlite', 'pgcli', 'mycli', 'cockroach', 'clickhouse-client', 'duckdb', 'sql', 'snowsql', 'bq', 'osql', 'isql'])
const SQL_DESTRUCTIVE = /\b(drop\s+(database|table|schema)|truncate(\s+table)?)\b/i
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash'])
const SAFE_DD_TARGETS = /^\/dev\/(null|zero|stdout|stderr|tty|fd\/\d+)$/

function git(args: string[], ctx: CommandContext): Verdict | null {
  // Skip global options: -C <dir>, -c <k=v>, --git-dir=..., --no-pager, ...
  let i = 0
  while (i < args.length) {
    const a = args[i] as string
    if (a === '-C' || a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') i += 2
    else if (a.startsWith('-')) i++
    else break
  }
  const sub = args[i]
  const rest = args.slice(i + 1)
  const { short, long, operands } = flagsOf(rest)

  if (sub === 'push') {
    const lease = [...long].some(l => l === '--force-with-lease')
    const force = long.has('--force') || short.has('f') || operands.some(o => o.startsWith('+') && o.length > 1)
    if (force) return { what: '`git push --force`', why: 'it overwrites remote history others may have pulled; use --force-with-lease' }
    if (lease && ctx.allowForceWithLease === false)
      return { what: '`git push --force-with-lease`', why: 'force pushes are switched off by the allowForceWithLease setting' }
    return null
  }
  if (sub === 'reset' && long.has('--hard'))
    return { what: '`git reset --hard`', why: 'it throws away every uncommitted change with no undo' }
  if (sub === 'clean') {
    const dry = short.has('n') || long.has('--dry-run')
    const forced = short.has('f') || long.has('--force')
    const dirs = short.has('d')
    if (forced && dirs && !dry)
      return { what: '`git clean -fd`', why: 'it permanently deletes untracked files and directories (not recoverable from git)' }
    return null
  }
  if (sub === 'branch') {
    const forceDelete = short.has('D') || ((short.has('d') || long.has('--delete')) && (short.has('f') || long.has('--force')))
    const hit = operands.find(o => /^(origin\/)?(main|master)$/.test(o))
    if (forceDelete && hit) return { what: `\`git branch -D ${hit}\``, why: 'it force-deletes the main branch, unmerged commits included' }
    return null
  }
  return null
}

function classifySegment(seg: Segment, all: Segment[], index: number, ctx: CommandContext, depth: number): Verdict | null {
  const words = stripPrefixes(seg.words)
  if (words.length === 0) return null
  const cmd = basename(words[0] as string)
  const args = words.slice(1)

  // `bash -c '...'`, `sh -c`, `eval ...`: judge the inner script too.
  if (depth < 3 && (SHELLS.has(cmd) || cmd === 'eval')) {
    const ci = args.indexOf('-c')
    const inner = cmd === 'eval' ? args.join(' ') : ci >= 0 ? args[ci + 1] : undefined
    if (inner) {
      const v = classifyCommandAt(inner, ctx, depth + 1)
      if (v) return v
    }
  }

  // A shell fed by a download: `curl ... | sh`.
  if (SHELLS.has(cmd) && index > 0 && all[index - 1]?.op === '|') {
    for (let j = index - 1; j >= 0 && (j === index - 1 || all[j]?.op === '|'); j--) {
      const prev = stripPrefixes(all[j]?.words ?? [])
      const name = basename(prev[0] ?? '')
      if (name === 'curl' || name === 'wget')
        return { what: `\`${name} … | ${cmd}\``, why: 'it runs a script straight from the internet without you reading it' }
      if (j === 0 || all[j - 1]?.op !== '|') break
    }
  }

  switch (cmd) {
    case 'git':
      return git(args, ctx)
    case 'rm': {
      const { short, long, operands } = flagsOf(args)
      const recursive = short.has('r') || short.has('R') || long.has('--recursive')
      const force = short.has('f') || long.has('--force')
      if (!recursive || !force) return null
      for (const t of operands) {
        const why = rmTargetDanger(t, ctx)
        if (why) return { what: `\`rm -rf ${t}\``, why }
      }
      return null
    }
    case 'terraform':
    case 'tofu':
    case 'terragrunt': {
      if (args.includes('destroy') || (args.includes('apply') && args.includes('-destroy')))
        return { what: `\`${cmd} destroy\``, why: 'it tears down real infrastructure' }
      return null
    }
    case 'kubectl':
    case 'oc': {
      const di = args.indexOf('delete')
      if (di < 0) return null
      const kind = args.slice(di + 1).find(a => !a.startsWith('-'))
      if (kind && /^(ns|namespace|namespaces)(\/|$)/.test(kind))
        return { what: '`kubectl delete namespace`', why: 'it deletes every resource in the namespace' }
      return null
    }
    case 'chmod': {
      const { short, long, operands } = flagsOf(args)
      if ((short.has('R') || long.has('--recursive')) && /^0?777$|^(a|ugo)[+=]rwx$/.test(operands[0] ?? ''))
        return { what: '`chmod -R 777`', why: 'it makes a whole tree world-writable' }
      return null
    }
    case 'dd': {
      const of = args.find(a => a.startsWith('of='))?.slice(3)
      if (of && of.startsWith('/dev/') && !SAFE_DD_TARGETS.test(of))
        return { what: `\`dd of=${of}\``, why: 'it overwrites a raw device' }
      return null
    }
  }
  if (cmd === 'mkfs' || cmd.startsWith('mkfs.') || cmd === 'mke2fs' || cmd === 'wipefs')
    return { what: `\`${cmd}\``, why: 'it formats a disk' }

  return null
}

function classifyCommandAt(command: string, ctx: CommandContext, depth: number): Verdict | null {
  const segments = splitCommand(command)
  for (let i = 0; i < segments.length; i++) {
    const v = classifySegment(segments[i] as Segment, segments, i, ctx, depth)
    if (v) return v
  }

  // Process substitution / command substitution feeding a shell.
  const m = /\b(?:ba|z|da|k)?sh\s+(?:-\w+\s+)*(?:<\(|-c\s+["']?\$\()\s*(curl|wget)\b/.exec(command)
  if (m) return { what: `\`${m[1]} … | sh\``, why: 'it runs a script straight from the internet without you reading it' }

  // Destructive SQL handed to a database client (inline, via -c/-e, a heredoc or a pipe).
  const usesClient = segments.some(s => SQL_CLIENTS.has(basename(stripPrefixes(s.words)[0] ?? '')))
  const sql = SQL_DESTRUCTIVE.exec(command)
  if (usesClient && sql) {
    const what = (sql[1] as string).replace(/\s+/g, ' ').toUpperCase()
    return { what: `\`${what}\``, why: 'it permanently deletes database data' }
  }
  return null
}

/** Returns why a shell command is destructive, or null when it may run. */
export function classifyCommand(command: string, ctx: CommandContext): Verdict | null {
  return classifyCommandAt(command, ctx, 0)
}

// ---------------------------------------------------------------- files

const ENV_OK = /^\.env\.(example|sample|template|dist|defaults)$/i

/** Converts a simple glob (`*`, `**`, `?`) to an anchored regex. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
        if (glob[i + 1] === '/') i++
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

export function parseExtra(extra: string | undefined): string[] {
  return (extra ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

/** Why writing to `path` is refused, or null when it is an ordinary file. */
export function protectedFile(path: string, extra: string[] = []): Verdict | null {
  const p = path.replace(/\\/g, '/')
  const parts = p.split('/').filter(Boolean)
  const base = parts[parts.length - 1] ?? ''
  const lower = base.toLowerCase()
  const hit = (why: string): Verdict => ({ what: `a write to ${base}`, why })

  const gi = parts.indexOf('.git')
  if (gi >= 0 && gi < parts.length - 1) return { what: `a write inside .git/`, why: 'editing git internals can corrupt the repository' }

  if (lower === '.env' || (lower.startsWith('.env.') && !ENV_OK.test(lower)))
    return hit('.env files hold secrets; edit .env.example instead')
  if (/\.(pem|key|p12|pfx)$/.test(lower)) return hit('it is a private key or certificate bundle')
  if (/^id_(rsa|ed25519|ecdsa|dsa)/.test(lower)) return hit('it is an SSH key')
  if (lower.startsWith('secrets.')) return hit('it is a secrets file')
  if (/^\.?credentials(\.(json|ya?ml|toml|ini|xml|txt|env|csv|cfg|conf))?$/.test(lower)) return hit('it is a credentials file')
  if (lower === '.npmrc' || lower === '.pypirc') return hit('it holds registry auth tokens')

  for (const glob of extra) {
    const re = globToRegExp(glob)
    const matches = glob.includes('/') ? re.test(p) || parts.some((_, i) => re.test(parts.slice(i).join('/'))) : re.test(base)
    if (matches) return hit(`it matches your extraProtected pattern "${glob}"`)
  }
  return null
}

export function denyText(v: Verdict): string {
  return `safety-net: blocked ${v.what} — ${v.why}. Run it yourself if you really mean it, or /safety-net off for this session.`
}
