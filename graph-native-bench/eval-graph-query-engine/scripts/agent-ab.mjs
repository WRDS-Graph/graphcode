#!/usr/bin/env node
/**
 * agent-ab.mjs — live end-to-end agent A/B to VALIDATE the oracle (oracle-3harness.mjs).
 *
 * Runs a real `claude -p` agent in two harness configs on the SAME task and scores its actual
 * answer (a file list) against the same structural gold:
 *
 *   plain        — Read/Grep/Glob/Bash only. The agent must find the dependents itself.
 *   graph-native — the harness pre-computes the ranked, test-demoted blast radius and injects it
 *                  as a "GRAPH CONTEXT (already retrieved)" preamble; the agent refines/filters it.
 *
 * Measures F1 @ top-K vs gold + cost (USD, output tokens, cache reads) + turns + wall-clock.
 * This is n=1-2 by design — its job is to confirm the oracle PREDICTS the real-agent direction,
 * not to be the population estimate (the oracle is the reproducible scale layer).
 *
 * Usage: node scripts/graph/agent-ab.mjs PaperGraph --gold production-dependents --budget 15
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { impact, callers, query, normalizeEntry } from './cg.mjs'
import { rankImpact, isTestFile } from './impact-ranker.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const anchor = process.argv[2]
const arg = (n, d) => { const i = process.argv.indexOf(n); return i !== -1 ? process.argv[i + 1] : d }
const goldMode = arg('--gold', 'production-dependents')
const K = Number(arg('--budget', '15'))

function f1(cand, gold, k) {
  const c = [...new Set(cand)].slice(0, k)
  const g = new Set(gold), cs = new Set(c)
  let tp = 0; for (const x of cs) if (g.has(x)) tp++
  const p = cs.size ? tp / cs.size : 0, r = g.size ? tp / g.size : 0
  return { f1: p + r ? 2 * p * r / (p + r) : 0, p, r, tp, n: cs.size }
}

// Parse a file list out of the agent's free-text answer (any src/... or backend/... path).
function extractFiles(text) {
  const re = /\b((?:src|backend)\/[A-Za-z0-9_./-]+\.(?:tsx?|jsx?|py))/g
  return [...new Set([...text.matchAll(re)].map((m) => m[1]))]
}

function runAgent(prompt, allowedTools) {
  const out = execFileSync('claude', ['-p', prompt, '--output-format', 'json', '--allowedTools', allowedTools], {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000,
  })
  const j = JSON.parse(out)
  return { answer: j.result || '', cost: j.total_cost_usd, outTok: j.usage?.output_tokens, cacheRead: j.usage?.cache_read_input_tokens, turns: j.num_turns, ms: j.duration_ms }
}

// ---- gold + native preamble ----
const imp = await impact(anchor, { depth: 3 })
const aff = (imp.affected ?? []).map(normalizeEntry)
const cg = await callers(anchor)
const hits = await query(anchor)
const subjectFile = hits.find((h) => (h.node ?? h).name === anchor)?.node?.filePath ?? null
const allFiles = [...new Set(aff.map((a) => a.file).filter(Boolean))]
let gold = goldMode === 'direct-callers'
  ? [...new Set((cg.callers ?? []).map((c) => c.filePath || c.file).filter(Boolean))]
  : allFiles.filter((f) => !isTestFile(f))

const ranked = rankImpact({ anchor, affected: aff, callers: (cg.callers ?? []).map(normalizeEntry), subjectFile })
const preamble = ranked.filter((r) => r.tier !== 'test').slice(0, K).map((r) => `  ${r.file} (${r.tier}, refs ${r.refs})`).join('\n')

const TASK = `In this repo, the symbol \`${anchor}\` is going to change. List the production source files (NOT test files) that depend on it and would need review. Output ONLY a list of file paths, one per line.`

const PLAIN_PROMPT = `${TASK}\n\nUse Grep/Read/Glob to find them.`
const NATIVE_PROMPT = `${TASK}\n\nGRAPH CONTEXT (already retrieved and ranked for you — production dependents, test files already removed):\n${preamble}\n\nThis ranked list IS your primary answer source. Verify/trim it if needed, then output the final file list.`

console.log(`# Agent A/B on "${anchor}"  (gold=${goldMode}, |gold|=${gold.length}, budget top-${K})\n`)

const results = {}
for (const [arm, prompt, tools] of [
  ['plain', PLAIN_PROMPT, 'Grep Read Glob Bash'],
  ['graph-native', NATIVE_PROMPT, 'Grep Read Glob Bash'],
]) {
  process.stdout.write(`running ${arm} ... `)
  const r = runAgent(prompt, tools)
  const files = extractFiles(r.answer)
  const s = f1(files, gold, K)
  results[arm] = { ...r, files, ...s }
  console.log(`F1 ${s.f1.toFixed(2)} (p ${s.p.toFixed(2)} r ${s.r.toFixed(2)}, ${s.tp}/${gold.length})  $${r.cost?.toFixed(3)}  ${r.outTok}out-tok  ${r.turns}turns  ${(r.ms / 1000).toFixed(0)}s`)
}

console.log(`\n## Oracle prediction vs live agent`)
console.log(`(oracle said graph-native should win the firehose; check the live direction matches)`)
const p = results.plain, n = results['graph-native']
console.log(`  plain        F1 ${p.f1.toFixed(2)}  $${p.cost?.toFixed(3)}  ${p.outTok} out-tok`)
console.log(`  graph-native F1 ${n.f1.toFixed(2)}  $${n.cost?.toFixed(3)}  ${n.outTok} out-tok`)
console.log(`  -> graph-native ${n.f1 > p.f1 ? 'WINS' : n.f1 < p.f1 ? 'LOSES' : 'TIES'} on F1, ${n.cost < p.cost ? 'cheaper' : 'pricier'}, ${n.outTok < p.outTok ? 'fewer' : 'more'} out-tok`)
