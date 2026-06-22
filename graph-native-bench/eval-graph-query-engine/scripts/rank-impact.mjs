#!/usr/bin/env node
/**
 * rank-impact.mjs — the SOP "Lever A" entry point.
 *
 * One command: given a changed symbol, query the syntactic graph (impact + callers),
 * rank with the v2 structural ranker, and print a tier-segmented, test-demoted shortlist
 * the Impact Checker / Graph Traverser agent starts from (retrieval-done, not reconstructed).
 *
 * Usage:
 *   node scripts/graph/rank-impact.mjs PaperGraph
 *   node scripts/graph/rank-impact.mjs computeOverlay --depth 2 --budget 15
 */
import { impact, callers, query, normalizeEntry } from './cg.mjs'
import { rankImpact } from './impact-ranker.mjs'

function arg(name, def) {
  const i = process.argv.indexOf(name)
  return i !== -1 ? process.argv[i + 1] : def
}

const anchor = process.argv[2]
if (!anchor || anchor.startsWith('--')) {
  console.error('usage: node scripts/graph/rank-impact.mjs <Symbol> [--depth N] [--budget K]')
  process.exit(2)
}
const depth = Number(arg('--depth', '3'))
const budget = Number(arg('--budget', '20'))

async function subjectFileOf(a) {
  const hits = await query(a)
  for (const h of hits) {
    const n = h.node ?? h
    if (n && n.name === a && n.filePath) return n.filePath
  }
  return hits[0]?.node?.filePath ?? null
}

const imp = await impact(anchor, { depth })
if (imp.notFound || (imp.affected ?? []).length === 0) {
  console.log(`No syntactic impact for "${anchor}".`)
  console.log(
    `If it is a React useCallback/closure or a string-keyed reducer action, codegraph may not`,
    `index it as a top-level symbol — fall back to the semantic CODE_GRAPH.md and Grep.`
  )
  if (imp.notFound) process.exit(0)
}
const cg = await callers(anchor)
const subjectFile = await subjectFileOf(anchor)
const ranked = rankImpact({
  anchor,
  affected: (imp.affected ?? []).map(normalizeEntry),
  callers: (cg.callers ?? []).map(normalizeEntry),
  subjectFile,
})

const byTier = { direct: [], strong: [], weak: [], test: [] }
for (const r of ranked) byTier[r.tier].push(r)

const setN = new Set(ranked.map((r) => r.file)).size
console.log(`# Ranked impact for "${anchor}"  (raw set ${setN} files, depth ${depth}, budget top-${budget})`)
console.log(`# subject file: ${subjectFile ?? '(unresolved)'}`)
let shown = 0
for (const tier of ['direct', 'strong', 'weak']) {
  if (!byTier[tier].length) continue
  console.log(`\n## ${tier.toUpperCase()}  — ${tier === 'direct' ? 'classify each Safe/Watch/Break' : tier === 'strong' ? 'likely consumers' : 'skim'}`)
  for (const r of byTier[tier]) {
    if (shown >= budget) break
    console.log(`  ${r.file}${r.refs ? `  (refs ${r.refs}${r.nameMatch ? ', name-match' : ''})` : r.nameMatch ? '  (name-match)' : ''}`)
    shown++
  }
}
if (byTier.test.length) {
  console.log(`\n## TEST (coverage set — every Watch/Break consumer should have one; demoted, not consumers)`)
  for (const r of byTier.test.slice(0, 10)) console.log(`  ${r.file}`)
}
