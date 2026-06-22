/**
 * Graph-native impact ranker — ported from graphcode-cli/extension/impact-ranker-v2.mjs
 * (held-out F1 0.519 vs raw-impact oracle 0.169 on the Hadoop benchmark) and adapted from
 * Java/Maven conventions to THIS repo's JS/TS/TSX + Python/Flask conventions.
 *
 * The thesis is unchanged: raw `codegraph impact` is a high-recall / low-precision firehose
 * (e.g. `impact PaperGraph` = 261 files, ~half of them *.test.ts). The ranker converts it into
 * a budget-bounded, test-demoted, tier-segmented shortlist the agent can refine instead of
 * reconstruct. The win is the RANKING, relocated out of the model's context into this code.
 *
 * Three structural signals (all gold-blind — keyed on the anchor word and on file structure,
 * never on which files are the "right answer"):
 *   1. TEST-FILE DEMOTION — in this repo, co-located `.test.ts(x)`, `.spec.ts`, `src/test/`,
 *      `__tests__/`, and `backend/.../test_*.py` are 40-55% of any blast radius and are NEVER the
 *      production file a feature/bug fix touches. Demoted hard (penalty, not a hard drop, so they
 *      still appear at the tail for coverage tests).
 *   2. ADDITIVE DIRECT-CALLER BONUS — a 1-hop caller (from `codegraph callers`) is high-precision
 *      when it covers gold, but can be disjoint from gold on widely-used types, so it's ADDITIVE
 *      (can't bury a denser true dependent), not a hard tier.
 *   3. NAME-MATCH — a file whose basename contains the anchor word is usually an implementor /
 *      consumer of it (`graphMatchingEngine.ts` ↔ `GraphMatchingEngine`, `LeftPanel.test.tsx` ↔
 *      `LeftPanel`). Reaches low-density 2-hop gold that neither density nor callers surface.
 *
 *   score = refs + (direct?+8) + (sameModule?+4) + (nameMatch?+10) − (isTest?+100000)
 *
 * Pure / dependency-light: takes normalized { anchor, affected[], callers[] } and returns a
 * ranked [{file, basename, score, tier, refs, direct, sameModule, nameMatch, isTest}].
 */

const WEIGHTS = {
  direct: 8, // additive 1-hop-caller bonus
  module: 4, // same src/<feature> or backend/<area> dir: a small locality tiebreak
  nameMatch: 10, // basename contains the anchor word -> likely implementor/consumer
  minAnchorWord: 4, // don't name-match on short anchors ("id", "rrf", "ppr")
  testPenalty: 100000, // co-located tests / specs: pushed below everything real
}

const SRC_EXT_RE = /\.(tsx?|jsx?|mts|cts|py)$/i

function normPath(f) {
  return String(f || '').replace(/\\/g, '/')
}

/** Basename without source extension, lowercased. `src/matching/graphMatchingEngine.ts` -> `graphmatchingengine`. */
export function basename(f) {
  return normPath(f).split('/').pop().replace(SRC_EXT_RE, '').toLowerCase()
}

/** Directory of a file, used as the "module" for locality. `src/matching/x.ts` -> `src/matching`. */
function moduleOf(f) {
  const parts = normPath(f).split('/')
  parts.pop()
  return parts.join('/')
}

/**
 * Anchor word for name-matching: lowercased, non-alphanumerics stripped, trailing version
 * digits removed so `HttpServer2`-style names still match. For TS the anchor is often a
 * PascalCase symbol or a file stem; we match on substring containment of this word.
 */
function anchorWord(anchor) {
  return String(anchor || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/\d+$/, '')
}

/**
 * Test/spec detector for THIS repo's conventions (vitest co-located + pytest backend):
 *   - co-located unit tests:  .test.ts, .test.tsx, .spec.ts(x)
 *   - test source roots:      src/test/, any __tests__/ dir
 *   - backend pytest:         backend/search/test_*.py  (e.g. backend/search/test_processor.py)
 * This is a general fact about what a "blast radius" contains, not an issue-specific allowlist.
 */
const TEST_PATH_RE = /(^|\/)(__tests__|test)\//i
const TEST_NAME_RE = /(\.(test|spec))$|^test_/i
export function isTestFile(filePath) {
  const p = normPath(filePath)
  if (TEST_PATH_RE.test(p)) return true
  const stem = p.split('/').pop().replace(SRC_EXT_RE, '')
  return TEST_NAME_RE.test(stem)
}

/**
 * @param {object} opts
 * @param {string} opts.anchor            the changing symbol
 * @param {Array<{name,kind,file,line}>} opts.affected  normalized codegraph `impact` entries
 * @param {Array<{name,kind,file,line}>} [opts.callers]  normalized codegraph `callers` entries
 * @param {string} [opts.subjectFile]     path to the file defining the anchor
 * @param {boolean} [opts.excludeSubject]  drop the anchor's own file from output. Default FALSE.
 *   In the Hadoop "who-depends-on-me" benchmark the anchor's file is never gold, so it was
 *   excluded. For ISSUE LOCALIZATION on this repo, a fix usually edits the defining file too,
 *   so the subject file IS part of the answer and is kept (seeded as a top `direct` candidate).
 * @param {object} [opts.weights]
 * @returns {Array<{file,basename,score,tier,refs,direct,sameModule,nameMatch,isTest}>}
 */
export function rankImpact({ anchor, affected = [], callers = [], subjectFile = null, excludeSubject = false, weights = WEIGHTS }) {
  // refs = how many affected symbols live in each file (density)
  const refCount = new Map()
  const repPath = new Map()
  for (const a of affected) {
    const fp = a.file
    if (!fp || !SRC_EXT_RE.test(fp)) continue
    const k = normPath(fp)
    refCount.set(k, (refCount.get(k) || 0) + 1)
    if (!repPath.has(k)) repPath.set(k, k)
  }

  const direct = new Set()
  for (const c of callers) {
    const fp = c.file
    if (fp && SRC_EXT_RE.test(fp)) {
      const k = normPath(fp)
      direct.add(k)
      if (!repPath.has(k)) repPath.set(k, k)
    }
  }

  const subjMod = subjectFile ? moduleOf(subjectFile) : null
  const subjFileNorm = subjectFile ? normPath(subjectFile) : null
  const aWord = anchorWord(anchor)
  const useName = aWord.length >= weights.minAnchorWord

  // Seed the subject file as a candidate (a fix usually edits where the symbol is defined).
  // It carries no `refs` of its own, so give it a direct-caller-grade floor so it ranks high.
  if (subjFileNorm && !excludeSubject && SRC_EXT_RE.test(subjFileNorm)) {
    if (!refCount.has(subjFileNorm)) refCount.set(subjFileNorm, 0)
    direct.add(subjFileNorm)
    if (!repPath.has(subjFileNorm)) repPath.set(subjFileNorm, subjFileNorm)
  }

  const rows = []
  const files = new Set([...refCount.keys(), ...direct])
  for (const f of files) {
    if (excludeSubject && subjFileNorm && f === subjFileNorm) continue // Hadoop-style exclusion
    const refs = refCount.get(f) || 0
    const isDirect = direct.has(f)
    const sameModule = subjMod != null && moduleOf(f) === subjMod && subjMod.length > 0
    const isTest = isTestFile(f)
    const nameMatch = useName && basename(f).includes(aWord)

    let score = refs + (isDirect ? weights.direct : 0) + (sameModule ? weights.module : 0) + (nameMatch ? weights.nameMatch : 0)
    if (isTest) score -= weights.testPenalty

    let tier
    if (isTest) tier = 'test'
    else if (isDirect) tier = 'direct'
    else if (nameMatch) tier = 'strong'
    else if (refs >= 3) tier = 'strong'
    else tier = 'weak'

    rows.push({ file: f, basename: basename(f), score, tier, refs, direct: isDirect, sameModule, nameMatch, isTest })
  }

  rows.sort((a, b) => b.score - a.score || b.refs - a.refs || a.basename.localeCompare(b.basename))
  return rows
}

export { WEIGHTS }
