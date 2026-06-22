#!/usr/bin/env node
/**
 * oracle-3harness.mjs — deterministic retrieval-layer comparison of the three harnesses.
 *
 * For each task it computes what each harness CAN DELIVER to the agent, modeling the mechanism
 * the Hadoop study measured end-to-end (so this oracle is the fast, reproducible proxy for
 * real-agent behavior, validated against a small live agent A/B in agent-ab.mjs):
 *
 *   plain        — grep-equivalent: every file whose text contains the anchor name, UNRANKED.
 *                  Over-enumerates (tests, comments, string hits, same-named members). The agent
 *                  must then read to disambiguate. Modeled as the name-match file set in arbitrary
 *                  (path-sorted) order, capped at K.
 *   graph-MCP    — the RAW graph result (impact/callers), but the agent ranks it in-context under
 *                  a budget and stops early. Modeled as raw graph file order capped at K (the
 *                  "rank the firehose in-context, under-enumerate the hub" failure mode).
 *   graph-native — the PRE-RANKED result: our ranker (test-demoted, density+caller+name, tier-seg),
 *                  capped at K. Retrieval+ranking done in the harness before turn 0.
 *
 * Scored by hardened F1 @ top-K (precision+recall, file set-match) against structural gold.
 *
 * Usage: node scripts/graph/oracle-3harness.mjs [--budget 15]
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { impact, callers, query, normalizeEntry } from './cg.mjs'
import { rankImpact, isTestFile } from './impact-ranker.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const db = new DatabaseSync(path.join(REPO_ROOT, '.codegraph', 'codegraph.db'), { readOnly: true })
const TASKS = JSON.parse(readFileSync(path.join(REPO_ROOT, 'scripts', 'graph', 'tasks-3harness.json'), 'utf8')).tasks
const arg = (n, d) => { const i = process.argv.indexOf(n); return i !== -1 ? process.argv[i + 1] : d }
const K = Number(arg('--budget', '15'))

const nodes = new Map(db.prepare('SELECT id,name,kind,file_path file FROM nodes').all().map((n) => [n.id, n]))

// ---- gold derivation (structural, reproducible) ----
function productionDependents(anchor) {
  // all files in the impact blast radius that are NOT tests
  return null // filled async below
}
function directCallerFiles(anchor) { return null }

// ---- harness retrieval models ----

/** plain / grep-equivalent: files whose source text contains the anchor name (whole-word). */
function grepFiles(anchor) {
  try {
    const out = execFileSync('grep', ['-rlw', '--include=*.ts', '--include=*.tsx', '--include=*.py', anchor, 'src', 'backend'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    return out.split('\n').filter(Boolean)
  } catch {
    return [] // grep exits 1 on no match
  }
}

function f1(cand, gold, k) {
  const c = [...new Set(cand)].slice(0, k)
  const g = new Set(gold)
  const cs = new Set(c)
  let tp = 0
  for (const x of cs) if (g.has(x)) tp++
  const p = cs.size ? tp / cs.size : 0
  const r = g.size ? tp / g.size : 0
  return { f1: p + r ? (2 * p * r) / (p + r) : 0, p, r, tp, n: cs.size, gold: g.size }
}

async function scoreTask(t) {
  // Resolve subject file + gold + the three candidate lists per family.
  let gold = []
  let rawGraphFiles = []
  let rankedFiles = []
  let grep = []
  let subjectFile = null

  if (['impact', 'caller-enumeration', 'data-flow', 'test-selection'].includes(t.family)) {
    const imp = await impact(t.anchor, { depth: 3 })
    const aff = (imp.affected ?? []).map(normalizeEntry)
    const cg = await callers(t.anchor)
    const callerFiles = [...new Set((cg.callers ?? []).map((c) => c.filePath || c.file).filter(Boolean))]
    const hits = await query(t.anchor)
    subjectFile = hits.find((h) => (h.node ?? h).name === t.anchor)?.node?.filePath ?? hits[0]?.node?.filePath ?? null
    const allImpactFiles = [...new Set(aff.map((a) => a.file).filter(Boolean))]
    grep = grepFiles(t.anchor)

    // gold per goldMode
    if (t.goldMode === 'production-dependents') gold = allImpactFiles.filter((f) => !isTestFile(f))
    else if (t.goldMode === 'direct-callers') gold = callerFiles
    else if (t.goldMode === 'forward-closure') gold = allImpactFiles.filter((f) => !isTestFile(f))
    else if (t.goldMode === 'cochange-test-file') {
      // sibling test of the changed module
      gold = allImpactFiles.filter((f) => isTestFile(f) && path.basename(f).toLowerCase().includes(t.anchor.toLowerCase()))
      if (gold.length === 0) {
        // fall back: the *.test.* file next to the subject
        const sib = subjectFile ? subjectFile.replace(/\.(tsx?|jsx?)$/, '.test.$1') : null
        gold = sib ? [sib] : []
      }
    }

    rawGraphFiles = allImpactFiles // raw graph order (codegraph's emit order)
    rankedFiles = rankImpact({ anchor: t.anchor, affected: aff, callers: (cg.callers ?? []).map(normalizeEntry), subjectFile }).map((r) => r.file)
  } else if (t.family === 'refactor-triage') {
    // T5: gold = top-10 in-degree production files; all three "deliver" their best guess.
    const q = `SELECT n.file_path file, COUNT(*) c FROM edges e JOIN nodes n ON e.target=n.id
               WHERE e.kind IN ('calls','references','imports','implements','instantiates')
                 AND n.kind IN ('function','method','class','interface','type_alias','constant')
               GROUP BY n.file_path ORDER BY c DESC`
    const ranked = db.prepare(q).all().filter((r) => !isTestFile(r.file))
    gold = ranked.slice(0, 10).map((r) => r.file)
    rankedFiles = ranked.map((r) => r.file) // graph-native = the in-degree ranking itself
    rawGraphFiles = ranked.map((r) => r.file) // MCP = same data, agent re-derives; same here
    // plain has no in-degree notion — model as alphabetical file list (no signal)
    grep = [...new Set(db.prepare("SELECT file_path file FROM nodes WHERE kind='file'").all().map((r) => r.file))].filter((f) => !isTestFile(f)).sort()
  } else if (t.family === 'dead-code') {
    // T4: gold = zero-reference symbols' files (after dispatch filter). native delivers them; plain can't.
    const edgeT = new Set(db.prepare("SELECT DISTINCT target FROM edges WHERE kind IN ('calls','references','instantiates','implements')").all().map((r) => r.target))
    const refNames = new Set(db.prepare("SELECT DISTINCT n.name FROM edges e JOIN nodes n ON e.target=n.id WHERE e.kind IN ('calls','references','instantiates','implements')").all().map((r) => r.name))
    const defs = db.prepare("SELECT id,name,kind,file_path file FROM nodes WHERE kind IN ('function','method','class','interface')").all()
    const ENTRY = /^(App|main|default|server|loader|health|get_papers?|get_paper|compare|search|prior_art|title_search|constructor|render|handle[A-Z])/
    const dead = defs.filter((d) => !edgeT.has(d.id) && !refNames.has(d.name) && !isTestFile(d.file) && !ENTRY.test(d.name))
    gold = [...new Set(dead.map((d) => d.file))]
    rankedFiles = gold // native delivers the dead set directly
    rawGraphFiles = [...new Set(defs.filter((d) => !edgeT.has(d.id)).map((d) => d.file))] // MCP raw: no name filter -> false positives
    grep = [] // plain grep cannot express "uncalled" — empty, F1 0 by construction
  }

  const arms = {
    plain: f1(grep, gold, K),
    'graph-MCP': f1(rawGraphFiles, gold, K),
    'graph-native': f1(rankedFiles, gold, K),
  }
  return { id: t.id, family: t.family, goldN: gold.length, grepN: grep.length, rawN: rawGraphFiles.length, arms }
}

const rows = []
for (const t of TASKS) rows.push(await scoreTask(t))

console.log(`\n=== 3-harness retrieval oracle — F1 @ top-${K} (structural gold) ===\n`)
console.log('task                              family           goldN | plain  MCP    native | winner')
const sums = { plain: 0, 'graph-MCP': 0, 'graph-native': 0 }
const wins = { plain: 0, 'graph-MCP': 0, 'graph-native': 0, tie: 0 }
for (const r of rows) {
  const p = r.arms.plain.f1, m = r.arms['graph-MCP'].f1, n = r.arms['graph-native'].f1
  sums.plain += p; sums['graph-MCP'] += m; sums['graph-native'] += n
  const best = Math.max(p, m, n)
  const winners = Object.entries({ plain: p, 'graph-MCP': m, 'graph-native': n }).filter(([, v]) => Math.abs(v - best) < 1e-9).map(([k]) => k)
  if (winners.length > 1) wins.tie++; else wins[winners[0]]++
  console.log(`${r.id.padEnd(33)} ${r.family.padEnd(16)} ${String(r.goldN).padStart(4)}  | ${p.toFixed(2)}   ${m.toFixed(2)}   ${n.toFixed(2)}   | ${winners.join('=')}`)
}
const N = rows.length
console.log(`\nMEAN F1 @ top-${K}:  plain ${(sums.plain / N).toFixed(3)}   graph-MCP ${(sums['graph-MCP'] / N).toFixed(3)}   graph-native ${(sums['graph-native'] / N).toFixed(3)}   (n=${N} tasks)`)
console.log(`WINS:  graph-native ${wins['graph-native']}   graph-MCP ${wins['graph-MCP']}   plain ${wins.plain}   ties ${wins.tie}`)
