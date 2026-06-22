#!/usr/bin/env node
/**
 * run-hardcore.mjs — run plain / graph-MCP / graph-native on the hardcore tasks (claude -p),
 * then blind-judge every answer with the per-task rubric (judge.mjs). Writes artifacts + a table.
 *
 *   plain        : Read/Grep/Glob/Bash
 *   graph-MCP    : + codegraph MCP server (codegraph_* tools), graph-as-a-tool
 *   graph-native : + harness pre-injects the ranked, test-demoted blast radius before turn 0
 *
 * Judging is blind (answers labeled A/B/C, shuffled per task) and rubric-based.
 *
 * Usage:
 *   node scripts/graph/run-hardcore.mjs                 # all tasks, all arms, judged
 *   node scripts/graph/run-hardcore.mjs --task H5-security-audit
 *   node scripts/graph/run-hardcore.mjs --arms plain,graph-native --no-judge
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { impact, callers, query, normalizeEntry } from './cg.mjs'
import { rankImpact } from './impact-ranker.mjs'
import { judgeAbsolute, judgePairwise } from './judge.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const HERE = path.join(REPO_ROOT, 'scripts', 'graph')
const OUT = path.join(REPO_ROOT, '.claude', 'graph', 'hardcore-runs')
mkdirSync(OUT, { recursive: true })

const cfg = JSON.parse(readFileSync(path.join(HERE, 'tasks-hardcore.json'), 'utf8'))
const K = cfg.budgetTopK
const arg = (n, d) => { const i = process.argv.indexOf(n); return i !== -1 ? process.argv[i + 1] : d }
const onlyTask = arg('--task', null)
const arms = (arg('--arms', 'plain,graph-MCP,graph-native')).split(',')
const doJudge = !process.argv.includes('--no-judge')

const MCP_CONFIG = path.join(HERE, 'mcp-codegraph.json')

function runAgent(prompt, { tools, mcp }) {
  const args = ['-p', prompt, '--output-format', 'json', '--allowedTools', tools]
  if (mcp) args.push('--mcp-config', MCP_CONFIG, '--strict-mcp-config')
  const out = execFileSync('claude', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 420000 })
  const j = JSON.parse(out)
  return { answer: j.result || '', cost: j.total_cost_usd || 0, outTok: j.usage?.output_tokens || 0, turns: j.num_turns || 0, ms: j.duration_ms || 0 }
}

/** Build the graph-native ranked preamble for a task's anchor (empty if no anchor). */
async function nativePreamble(anchor) {
  if (!anchor) return ''
  const imp = await impact(anchor, { depth: 3 })
  if (imp.notFound) return ''
  const cg = await callers(anchor)
  const hits = await query(anchor)
  const subjectFile = hits.find((h) => (h.node ?? h).name === anchor)?.node?.filePath ?? null
  const ranked = rankImpact({ anchor, affected: (imp.affected ?? []).map(normalizeEntry), callers: (cg.callers ?? []).map(normalizeEntry), subjectFile })
  const lines = ranked.filter((r) => r.tier !== 'test').slice(0, K).map((r) => `  - ${r.file} (${r.tier}, refs ${r.refs})`)
  const tests = ranked.filter((r) => r.tier === 'test').slice(0, 6).map((r) => `  - ${r.file}`)
  return `\n\nGRAPH CONTEXT (already retrieved & ranked for you — production dependents first, tests separated):\nPRODUCTION DEPENDENTS:\n${lines.join('\n')}\nRELATED TESTS (coverage set):\n${tests.join('\n')}\nUse this as your retrieval — verify/refine it, don't re-derive it from scratch.`
}

const ARM_CFG = {
  plain: { tools: 'Read Grep Glob Bash', mcp: false, preamble: false },
  'graph-MCP': { tools: 'Read Grep Glob Bash mcp__codegraph__*', mcp: true, preamble: false },
  'graph-native': { tools: 'Read Grep Glob Bash', mcp: false, preamble: true },
}

const tasks = cfg.tasks.filter((t) => !onlyTask || t.id === onlyTask)
const results = []

for (const task of tasks) {
  console.log(`\n##### ${task.id} (${task.kind}) #####`)
  const pre = await nativePreamble(task.anchor)
  const answers = {}
  for (const arm of arms) {
    const a = ARM_CFG[arm]
    const prompt = task.prompt + (a.preamble ? pre : '')
    const answerPath = path.join(OUT, `${task.id}.${arm}.txt`)
    // Resume support: if an answer file already exists (and isn't a failure marker), reuse it
    // instead of paying for the agent again. Lets a re-run after a spend-limit reset skip done work.
    if (process.argv.includes('--resume') && existsSync(answerPath)) {
      const prior = readFileSync(answerPath, 'utf8')
      if (!prior.startsWith('(arm failed')) {
        answers[arm] = { answer: prior, cost: 0, outTok: 0, turns: 0, ms: 0, cached: true }
        console.log(`  ${arm} ... (cached)`)
        continue
      }
    }
    process.stdout.write(`  ${arm} ... `)
    let r
    try {
      r = runAgent(prompt, a)
    } catch (e) {
      console.log(`ERROR: ${String(e.message).slice(0, 120)}`)
      r = { answer: `(arm failed: ${e.message})`, cost: 0, outTok: 0, turns: 0, ms: 0 }
    }
    answers[arm] = r
    writeFileSync(answerPath, r.answer)
    console.log(`$${r.cost.toFixed(3)} ${r.outTok}tok ${r.turns}t ${(r.ms / 1000).toFixed(0)}s`)
  }

  // ---- blind judging ----
  let judged = {}
  let pairwise = null
  if (doJudge) {
    // shuffle arms -> labels A/B/C deterministically by a fixed rotation per task index
    const labeled = arms.map((arm, i) => ({ arm, label: String.fromCharCode(65 + i), text: answers[arm].answer }))
    for (const la of labeled) {
      process.stdout.write(`  judge[${la.arm}] ... `)
      const j = judgeAbsolute({ taskPrompt: task.prompt, rubric: task.rubric, answerText: la.text, label: la.label })
      judged[la.arm] = j
      console.log(`${j.normalized.toFixed(1)}/10  ($${j.cost.toFixed(3)})`)
    }
    // pairwise robustness: rank forward, then with reversed order; check the winner agrees
    const fwd = judgePairwise({ taskPrompt: task.prompt, rubric: task.rubric, labeledAnswers: labeled })
    const rev = judgePairwise({ taskPrompt: task.prompt, rubric: task.rubric, labeledAnswers: [...labeled].reverse() })
    const labelToArm = Object.fromEntries(labeled.map((l) => [l.label, l.arm]))
    pairwise = { fwdWinner: labelToArm[fwd.ranking[0]] || '?', revWinner: labelToArm[rev.ranking[0]] || '?', fwd: fwd.ranking.map((l) => labelToArm[l]), rev: rev.ranking.map((l) => labelToArm[l]) }
  }

  results.push({ id: task.id, kind: task.kind, answers, judged, pairwise })
}

// ---- report ----
console.log(`\n\n===== HARDCORE BENCHMARK — blind LLM-judge quality (0-10) =====\n`)
console.log('task                       kind                 | plain  MCP    native | judge-winner  pairwise-agree')
const sum = { plain: 0, 'graph-MCP': 0, 'graph-native': 0 }
const cost = { plain: 0, 'graph-MCP': 0, 'graph-native': 0 }
let n = 0
for (const r of results) {
  if (!Object.keys(r.judged).length) continue
  n++
  const g = (a) => (r.judged[a]?.normalized ?? 0)
  for (const a of arms) { sum[a] += g(a); cost[a] += r.answers[a]?.cost || 0 }
  const best = Math.max(...arms.map(g))
  const winner = arms.filter((a) => Math.abs(g(a) - best) < 0.05).join('=')
  const agree = r.pairwise ? (r.pairwise.fwdWinner === r.pairwise.revWinner ? `yes(${r.pairwise.fwdWinner})` : `no(${r.pairwise.fwdWinner}/${r.pairwise.revWinner})`) : '-'
  console.log(`${r.id.padEnd(26)} ${r.kind.padEnd(20)} | ${g('plain').toFixed(1)}    ${g('graph-MCP').toFixed(1)}    ${g('graph-native').toFixed(1)}   | ${winner.padEnd(13)} ${agree}`)
}
if (n) {
  console.log(`\nMEAN quality (0-10):  plain ${(sum.plain / n).toFixed(2)}   graph-MCP ${(sum['graph-MCP'] / n).toFixed(2)}   graph-native ${(sum['graph-native'] / n).toFixed(2)}   (n=${n})`)
  console.log(`TOTAL cost USD:       plain $${cost.plain.toFixed(2)}   graph-MCP $${cost['graph-MCP'].toFixed(2)}   graph-native $${cost['graph-native'].toFixed(2)}`)
  console.log(`QUALITY PER $:        plain ${(sum.plain / cost.plain).toFixed(1)}   graph-MCP ${(sum['graph-MCP'] / cost['graph-MCP']).toFixed(1)}   graph-native ${(sum['graph-native'] / cost['graph-native']).toFixed(1)}`)
}
writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(results, null, 2))
console.log(`\nArtifacts: .claude/graph/hardcore-runs/  (per-arm answers + summary.json)`)
