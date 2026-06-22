#!/usr/bin/env node
/**
 * score-localization.mjs — benchmark harness for graph-native localization on THIS repo.
 *
 * For each issue in issue-gold.json, seed codegraph with the anchor symbol, take the
 * blast radius, and score the file set against the maintainers' human gold (CODE_GRAPH §7)
 * at a top-K budget using hardened F1 (precision + recall over the SAME bounded file set).
 *
 * Two modes:
 *   raw    — codegraph `impact` file order, capped at K (the "before" / firehose baseline)
 *   ranked — same blast radius re-ranked by the v2-style structural ranker (the "after")
 *
 * Usage:
 *   node scripts/graph/score-localization.mjs --mode raw    --budget 20
 *   node scripts/graph/score-localization.mjs --mode ranked --budget 20
 *   node scripts/graph/score-localization.mjs --compare     --budget 20   (runs both, prints delta)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { impact, callers, query, normalizeEntry } from './cg.mjs'
import { rankImpact } from './impact-ranker.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GOLD = JSON.parse(readFileSync(path.join(HERE, 'issue-gold.json'), 'utf8')).issues

function arg(name, def) {
  const i = process.argv.indexOf(name)
  return i !== -1 ? process.argv[i + 1] : def
}
const BUDGET = Number(arg('--budget', '20'))

/** Distinct files from a list of graph entries (normalized), preserving order. */
function filesOf(entries) {
  const seen = new Set()
  const out = []
  for (const e of entries) {
    const f = (e.file ?? e.filePath)
    if (f && !seen.has(f)) {
      seen.add(f)
      out.push(f)
    }
  }
  return out
}

/** Hardened F1: precision + recall over the candidate file set capped at K vs gold. */
function f1(candidateFiles, goldFiles, k) {
  const cand = candidateFiles.slice(0, k)
  const goldSet = new Set(goldFiles)
  const candSet = new Set(cand)
  let tp = 0
  for (const f of candSet) if (goldSet.has(f)) tp++
  const prec = candSet.size ? tp / candSet.size : 0
  const rec = goldSet.size ? tp / goldSet.size : 0
  const f = prec + rec ? (2 * prec * rec) / (prec + rec) : 0
  return { f1: f, prec, rec, tp, nCand: candSet.size, nGold: goldSet.size }
}

/** Resolve the file that defines the anchor symbol (for self-exclusion + module locality). */
async function subjectFileOf(anchor) {
  const hits = await query(anchor)
  for (const h of hits) {
    const n = h.node ?? h
    if (n && n.name === anchor && n.filePath) return n.filePath
  }
  return hits[0]?.node?.filePath ?? null
}

async function scoreIssue(issue, mode) {
  const imp = await impact(issue.anchor, { depth: 3 })
  const affected = imp.affected ?? []
  let files
  if (mode === 'raw') {
    files = filesOf(affected)
  } else {
    const cg = await callers(issue.anchor)
    const subjectFile = await subjectFileOf(issue.anchor)
    const ranked = rankImpact({
      anchor: issue.anchor,
      affected: affected.map(normalizeEntry),
      callers: (cg.callers ?? []).map(normalizeEntry),
      subjectFile,
    })
    files = ranked.map((r) => r.file)
  }
  const score = f1(files, issue.gold, BUDGET)
  return { id: issue.id, slug: issue.slug, anchor: issue.anchor, rawSetSize: filesOf(affected).length, ...score, top: files.slice(0, BUDGET) }
}

async function runMode(mode) {
  const rows = []
  for (const issue of GOLD) rows.push(await scoreIssue(issue, mode))
  return rows
}

function printTable(rows, label) {
  console.log(`\n=== ${label} (F1 @ top-${BUDGET}, gold = CODE_GRAPH §7) ===`)
  console.log('id  slug                          anchor                     setN  F1    prec  rec   tp/gold')
  for (const r of rows) {
    console.log(
      `${String(r.id).padEnd(3)} ${r.slug.padEnd(29)} ${r.anchor.padEnd(26)} ${String(r.rawSetSize).padStart(4)}  ${r.f1.toFixed(2)}  ${r.prec.toFixed(2)}  ${r.rec.toFixed(2)}  ${r.tp}/${r.nGold}`
    )
  }
  const mean = rows.reduce((a, r) => a + r.f1, 0) / rows.length
  console.log(`mean F1 @ top-${BUDGET}: ${mean.toFixed(3)}  (n=${rows.length})`)
  return mean
}

const main = async () => {
  if (process.argv.includes('--compare')) {
    const raw = await runMode('raw')
    const ranked = await runMode('ranked')
    const rawMean = printTable(raw, 'RAW codegraph impact (before)')
    const rankMean = printTable(ranked, 'RANKED (v2 structural ranker, after)')
    console.log(`\n>>> DELTA: raw ${rawMean.toFixed(3)} -> ranked ${rankMean.toFixed(3)}  (+${(rankMean - rawMean).toFixed(3)})`)
    let wins = 0, ties = 0, losses = 0
    for (let i = 0; i < raw.length; i++) {
      if (ranked[i].f1 > raw[i].f1 + 1e-9) wins++
      else if (ranked[i].f1 < raw[i].f1 - 1e-9) losses++
      else ties++
    }
    console.log(`>>> ranked beats raw on ${wins}/${raw.length} issues (ties ${ties}, regressions ${losses})`)
  } else {
    const mode = arg('--mode', 'raw')
    printTable(await runMode(mode), mode === 'raw' ? 'RAW codegraph impact' : 'RANKED')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
