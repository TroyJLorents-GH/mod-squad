// Heuristics: what kind of work a turn was, from the prompt's words and the tools the turn used.

export const CATEGORIES = [
  'Coding',
  'Debugging',
  'Feature Dev',
  'Exploration',
  'Refactoring',
  'Testing',
  'Docs',
  'Conversation',
] as const
export type Category = (typeof CATEGORIES)[number]

/** What a turn did, gathered while its lines are parsed (kept small: it is stored). */
export type TurnSignals = {
  /** Category the prompt's words point at, or null. */
  k: KeywordCategory | null
  /** Tool calls made. */
  t: number
  /** Edits made (Edit, Write, MultiEdit, NotebookEdit). */
  e: number
  /** Edits to documentation files (.md, .mdx, .rst, .txt, README). */
  d: number
  /** A test runner ran in the shell. */
  r: boolean
}

type KeywordCategory = 'Testing' | 'Debugging' | 'Refactoring' | 'Docs' | 'Feature Dev' | 'Exploration'

// First match wins, in this order.
const KEYWORDS: readonly [KeywordCategory, RegExp][] = [
  ['Testing', /\b(tests?|testing|unit[- ]tests?|specs?|jest|vitest|pytest|mocha|coverage|e2e)\b/],
  ['Debugging', /\b(bugs?|fix(es|ed|ing)?|errors?|fail(s|ed|ing|ure)?|broken|crash(es|ed|ing)?|exception|traceback|stack ?trace|debug(ging)?|regression|doesn'?t work|not working|wrong)\b/],
  ['Refactoring', /\b(refactor(ing)?|rename|clean ?up|simplify|restructure|reorgani[sz]e|extract|dedupe|deduplicate|tidy|modernize)\b/],
  ['Docs', /\b(readme|docs?|documentation|docstrings?|jsdoc|changelog|write ?up|comments?)\b/],
  ['Feature Dev', /\b(add|implement|build|create|feature|support for|introduce|scaffold|new endpoint|new command)\b/],
  ['Exploration', /\b(how does|how do|where is|where are|what is|what does|explain|find|look at|investigate|explore|understand|search|show me|list)\b/],
]

export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const TEST_RUNNER =
  /(^|[\s;&|(])(npm (run )?test|pnpm (run )?test|yarn test|bun test|npx (jest|vitest|mocha|playwright)|jest|vitest|mocha|pytest|python -m (pytest|unittest)|go test|cargo test|mvn test|gradle test|rspec|phpunit|dotnet test|claude plugin test|make test|tox)\b/

const DOC_FILE = /(\.(md|mdx|rst|txt|adoc)$|(^|[\\/])readme[^\\/]*$)/i

export function keywordOf(prompt: string): KeywordCategory | null {
  const text = prompt.toLowerCase()
  for (const [cat, re] of KEYWORDS) if (re.test(text)) return cat
  return null
}

export function isTestRun(command: string): boolean {
  return TEST_RUNNER.test(command)
}

export function isDocFile(path: string): boolean {
  return DOC_FILE.test(path)
}

export function freshSignals(prompt: string): TurnSignals {
  return { k: keywordOf(prompt), t: 0, e: 0, d: 0, r: false }
}

/**
 * Rules, first that holds wins:
 * 1. a test runner ran, or the prompt talks about tests           -> Testing
 * 2. the prompt talks about a bug/error/failure                   -> Debugging
 * 3. the prompt asks to refactor/rename/clean up                  -> Refactoring
 * 4. every edit was to a doc file, or the prompt is about docs    -> Docs
 * 5. the prompt asks to add/implement/build and files were edited -> Feature Dev
 * 6. files were edited                                            -> Coding
 * 7. tools ran but nothing was edited                             -> Exploration
 * 8. the prompt asks how/where/what/explain (no tools)            -> Exploration
 * 9. otherwise (no tools)                                         -> Conversation
 */
export function classify(s: TurnSignals): Category {
  if (s.r || s.k === 'Testing') return 'Testing'
  if (s.k === 'Debugging') return 'Debugging'
  if (s.k === 'Refactoring') return 'Refactoring'
  if ((s.e > 0 && s.d === s.e) || s.k === 'Docs') return 'Docs'
  if (s.k === 'Feature Dev' && s.e > 0) return 'Feature Dev'
  if (s.e > 0) return 'Coding'
  if (s.t > 0) return 'Exploration'
  if (s.k === 'Exploration') return 'Exploration'
  return 'Conversation'
}
