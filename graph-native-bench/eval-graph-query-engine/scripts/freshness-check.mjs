#!/usr/bin/env node
/**
 * freshness-check.mjs — turn the stale-hand-graph risk into a CI-able check.
 *
 * The semantic graph (.claude/graph/CODE_GRAPH.md) is hand-written and drifts as the code
 * changes. This script cross-checks the FILE references in CODE_GRAPH.md against the live
 * syntactic graph (and the filesystem) and flags:
 *   - DEAD path  — a file:line reference in CODE_GRAPH.md whose file no longer exists
 *   - the issue-gold anchors (scripts/graph/issue-gold.json) that no longer resolve as symbols
 *
 * Exit code 1 if any drift is found (so it can gate CI). This does NOT rewrite the semantic
 * graph — drift is surfaced for a human to reconcile, preserving the intent the hand graph encodes.
 *
 * Run: node scripts/graph/freshness-check.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { query } from './cg.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CODE_GRAPH = path.join(REPO_ROOT, '.claude', 'graph', 'CODE_GRAPH.md')
const GOLD = path.join(REPO_ROOT, 'scripts', 'graph', 'issue-gold.json')
const SYNTACTIC = path.join(REPO_ROOT, '.claude', 'graph', 'syntactic', 'graph-query-engine-graph.json')

let drift = 0

// 1. File references in CODE_GRAPH.md (src/... or backend/...) that no longer exist on disk.
const md = readFileSync(CODE_GRAPH, 'utf8')
const fileRefRe = /\b((?:src|backend)\/[A-Za-z0-9_./-]+\.(?:tsx?|jsx?|py))/g
const referenced = new Set()
for (const m of md.matchAll(fileRefRe)) referenced.add(m[1])

console.log(`# Freshness check — CODE_GRAPH.md vs live code\n`)
console.log(`## File references (${referenced.size} distinct)`)
const dead = []
for (const f of [...referenced].sort()) {
  if (!existsSync(path.join(REPO_ROOT, f))) {
    dead.push(f)
  }
}
if (dead.length) {
  drift += dead.length
  console.log(`  ❌ ${dead.length} dead path(s) (referenced in CODE_GRAPH.md, missing on disk):`)
  for (const f of dead) console.log(`     - ${f}`)
} else {
  console.log(`  ✅ all ${referenced.size} referenced files exist`)
}

// 2. Cross-check against the syntactic graph (warn if a referenced file isn't indexed —
//    e.g. excluded by codegraph or newly added without a re-index).
if (existsSync(SYNTACTIC)) {
  const g = JSON.parse(readFileSync(SYNTACTIC, 'utf8'))
  const indexedFiles = new Set(g.nodes.filter((n) => n.kind === 'file').map((n) => n.file))
  const notIndexed = [...referenced].filter((f) => existsSync(path.join(REPO_ROOT, f)) && !indexedFiles.has(f))
  console.log(`\n## Syntactic-graph coverage`)
  if (notIndexed.length) {
    console.log(`  ⚠️  ${notIndexed.length} existing file(s) referenced in CODE_GRAPH.md but NOT in the syntactic graph (re-run \`codegraph init .\`):`)
    for (const f of notIndexed) console.log(`     - ${f}`)
  } else {
    console.log(`  ✅ every existing referenced file is indexed`)
  }
} else {
  console.log(`\n## Syntactic-graph coverage\n  ⚠️  syntactic graph not built — run scripts/graph/build-syntactic.mjs`)
}

// 3. issue-gold anchors that no longer resolve as top-level symbols (the SOP's seed points).
const gold = JSON.parse(readFileSync(GOLD, 'utf8')).issues
console.log(`\n## Issue-gold anchors (${gold.length})`)
const unresolved = []
for (const issue of gold) {
  const hits = await query(issue.anchor)
  const ok = hits.some((h) => (h.node ?? h).name === issue.anchor)
  if (!ok) unresolved.push(issue)
}
if (unresolved.length) {
  console.log(`  ⚠️  ${unresolved.length} anchor(s) not indexed as a top-level symbol (closures/handlers — semantic-graph-only):`)
  for (const i of unresolved) console.log(`     - issue ${i.id} "${i.anchor}"${i.anchorNote ? ' (proxy noted)' : ''}`)
} else {
  console.log(`  ✅ all anchors resolve`)
}

console.log(`\n${drift === 0 ? '✅ No hard drift (no dead paths).' : `❌ ${drift} dead path(s) — reconcile CODE_GRAPH.md.`}`)
process.exit(drift === 0 ? 0 : 1)
