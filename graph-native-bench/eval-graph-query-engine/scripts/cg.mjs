#!/usr/bin/env node
/**
 * cg.mjs — thin JSON wrapper around the `codegraph` CLI.
 *
 * The repo already ships a hand-written semantic graph (.claude/graph/CODE_GRAPH.md);
 * this wrapper exposes the *syntactic* graph (codegraph's tree-sitter -> SQLite index)
 * as parsed JSON so the ranker and the SOP agents can consume it programmatically.
 *
 * Usage (programmatic):
 *   import { impact, callers, callees, query } from './cg.mjs'
 *   const { affected } = await impact('PaperGraph', { depth: 3 })
 *
 * Usage (CLI):
 *   node scripts/graph/cg.mjs impact PaperGraph --depth 3
 *   node scripts/graph/cg.mjs callers loadPaperGraph
 *
 * Requires: `codegraph init .` has been run once in the repo root (creates .codegraph/).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const execFileAsync = promisify(execFile)

// Repo root = two levels up from scripts/graph/
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Run a codegraph subcommand with --json and return parsed JSON.
 * codegraph emits an "ExperimentalWarning: SQLite ..." line to stderr; we ignore stderr
 * and parse stdout, which is pure JSON when --json is passed.
 */
async function run(args) {
  let stdout
  try {
    ;({ stdout } = await execFileAsync('codegraph', [...args, '--json', '--path', REPO_ROOT], {
      cwd: REPO_ROOT,
      maxBuffer: 64 * 1024 * 1024,
    }))
  } catch (err) {
    // codegraph exits non-zero on "symbol not found" but still may print JSON; try to recover.
    if (err.stdout) {
      stdout = err.stdout
    } else {
      throw new Error(`codegraph ${args.join(' ')} failed: ${err.message}`)
    }
  }
  const trimmed = stdout.trim()
  if (!trimmed) return null
  // codegraph prints a human "ℹ Symbol \"X\" not found" line (no JSON) when a symbol isn't
  // indexed — treat that as an empty result rather than a parse error.
  if (/Symbol .* not found/i.test(trimmed) && trimmed.search(/[[{]/) === -1) {
    return { notFound: true }
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    // Fall back: find the first JSON token (defensive against any stray prefix).
    const start = trimmed.search(/[[{]/)
    if (start === -1) return { notFound: true }
    try {
      return JSON.parse(trimmed.slice(start))
    } catch {
      return { notFound: true }
    }
  }
}

/** Impact / blast radius: who is affected by changing `symbol`. Returns { symbol, affected[] }. */
export async function impact(symbol, { depth = 2 } = {}) {
  const out = await run(['impact', symbol, '--depth', String(depth)])
  return out ?? { symbol, depth, nodeCount: 0, edgeCount: 0, affected: [] }
}

/** Direct callers (reverse edges). Returns { symbol, callers[] }. */
export async function callers(symbol) {
  const out = await run(['callers', symbol])
  return out ?? { symbol, callers: [] }
}

/** Direct callees (forward edges). Returns { symbol, callees[] }. */
export async function callees(symbol) {
  const out = await run(['callees', symbol])
  return out ?? { symbol, callees: [] }
}

/** Symbol search. Returns an array of { node, score? }. */
export async function query(search) {
  const out = await run(['query', search])
  return Array.isArray(out) ? out : []
}

/** Normalize an `affected`/`callers` entry to { name, kind, file, line }. */
export function normalizeEntry(e) {
  return {
    name: e.name,
    kind: e.kind ?? null,
    file: e.filePath ?? e.file ?? null,
    line: e.startLine ?? e.line ?? null,
  }
}

// ---- CLI ----
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [, , cmd, sym, ...rest] = process.argv
  const depthIdx = rest.indexOf('--depth')
  const depth = depthIdx !== -1 ? Number(rest[depthIdx + 1]) : 2
  const fns = { impact: () => impact(sym, { depth }), callers: () => callers(sym), callees: () => callees(sym), query: () => query(sym) }
  if (!cmd || !fns[cmd]) {
    console.error('usage: cg.mjs <impact|callers|callees|query> <symbol> [--depth N]')
    process.exit(2)
  }
  fns[cmd]().then((r) => console.log(JSON.stringify(r, null, 2))).catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
