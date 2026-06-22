#!/usr/bin/env node
/**
 * capture-trace.mjs — run ONE task on all 3 harnesses with full streaming traces, and distill
 * each into a readable tool-use/reasoning trail for the report (so we can SHOW the process, not
 * just the final answer). Emits a compact JSON trace per arm under hardcore-runs/traces/.
 *
 * Usage: node scripts/graph/capture-trace.mjs H2
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { impact, callers, query, normalizeEntry } from './cg.mjs'
import { rankImpact } from './impact-ranker.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const HERE = path.join(REPO_ROOT, 'scripts', 'graph')
const OUT = path.join(REPO_ROOT, '.claude', 'graph', 'hardcore-runs', 'traces')
mkdirSync(OUT, { recursive: true })
const MCP_CONFIG = path.join(HERE, 'mcp-codegraph.json')

const cfg = JSON.parse(readFileSync(path.join(HERE, 'tasks-hardcore.json'), 'utf8'))
const want = (process.argv[2] || 'H2').toUpperCase()
const task = cfg.tasks.find((t) => t.id.toUpperCase().startsWith(want))
if (!task) { console.error('no task', want); process.exit(1) }
const K = cfg.budgetTopK

async function preamble(anchor) {
  if (!anchor) return ''
  const imp = await impact(anchor, { depth: 3 })
  if (imp.notFound) return ''
  const cg = await callers(anchor)
  const hits = await query(anchor)
  const subjectFile = hits.find((h) => (h.node ?? h).name === anchor)?.node?.filePath ?? null
  const ranked = rankImpact({ anchor, affected: (imp.affected ?? []).map(normalizeEntry), callers: (cg.callers ?? []).map(normalizeEntry), subjectFile })
  const lines = ranked.filter((r) => r.tier !== 'test').slice(0, K).map((r) => `  - ${r.file} (${r.tier}, refs ${r.refs})`)
  return `\n\nGRAPH CONTEXT (already retrieved & ranked for you — production dependents first, tests separated):\n${lines.join('\n')}\nUse this as your retrieval — verify/refine it, don't re-derive it from scratch.`
}

// Run claude -p with stream-json; collect tool_use + text events into a compact trail.
function runTrace(prompt, { tools, mcp }) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--allowedTools', tools]
  if (mcp) args.push('--mcp-config', MCP_CONFIG, '--strict-mcp-config')
  const res = spawnSync('claude', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 420000 })
  const events = []
  let cost = 0, turns = 0
  for (const line of (res.stdout || '').split('\n')) {
    if (!line.trim()) continue
    let j
    try { j = JSON.parse(line) } catch { continue }
    // assistant tool_use blocks
    if (j.type === 'assistant' && j.message?.content) {
      for (const b of j.message.content) {
        if (b.type === 'tool_use') {
          const inp = b.input || {}
          const summary = inp.command || inp.pattern || inp.query || inp.symbol || inp.file_path || inp.path || JSON.stringify(inp).slice(0, 80)
          events.push({ t: 'tool', name: b.name, arg: String(summary).slice(0, 100) })
        } else if (b.type === 'text' && b.text.trim()) {
          events.push({ t: 'think', text: b.text.trim().slice(0, 220) })
        }
      }
    }
    if (j.type === 'result') { cost = j.total_cost_usd || 0; turns = j.num_turns || 0 }
  }
  return { events, cost, turns }
}

const ARM_CFG = {
  plain: { tools: 'Read Grep Glob Bash', mcp: false, pre: false },
  'graph-MCP': { tools: 'Read Grep Glob Bash mcp__codegraph__*', mcp: true, pre: false },
  'graph-native': { tools: 'Read Grep Glob Bash', mcp: false, pre: true },
}

const pre = await preamble(task.anchor)
const tracePath = path.join(OUT, `${task.id}.trace.json`)
// --arms plain,graph-MCP restricts which arms to (re)capture; existing arms are preserved (merge).
const armFilter = (() => { const i = process.argv.indexOf('--arms'); return i !== -1 ? new Set(process.argv[i + 1].split(',')) : null })()
let out = { task: task.id, kind: task.kind, anchor: task.anchor, arms: {} }
if (armFilter && existsSync(tracePath)) out = JSON.parse(readFileSync(tracePath, 'utf8'))
for (const [arm, a] of Object.entries(ARM_CFG)) {
  if (armFilter && !armFilter.has(arm)) continue
  process.stdout.write(`tracing ${arm} ... `)
  const prompt = task.prompt + (a.pre ? pre : '')
  const r = runTrace(prompt, a)
  out.arms[arm] = r
  // compact tool-call tally
  const tally = {}
  for (const e of r.events) if (e.t === 'tool') tally[e.name] = (tally[e.name] || 0) + 1
  console.log(`${r.turns} turns, $${r.cost.toFixed(3)}, tools: ${Object.entries(tally).map(([k, v]) => `${k}×${v}`).join(' ') || 'none'}`)
}
writeFileSync(tracePath, JSON.stringify(out, null, 2))
console.log(`\nTrace written: .claude/graph/hardcore-runs/traces/${task.id}.trace.json`)
