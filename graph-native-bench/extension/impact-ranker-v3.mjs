/**
 * Graph-native impact ranker — v3 (= v2 + gold-blind CO-CHANGE signal).
 *
 * WHAT'S NEW vs v2
 * ----------------
 * v2 ranks by purely-static graph signal: reference density + 1-hop direct-caller
 * + name-match (implementor convention) + package locality, with test-file demotion.
 * Its disclosed failure is the class of gold dependents with NO static edge to the
 * anchor — reflection/DI wiring, framework-convention entry points, and sibling
 * classes a human always edits together. The canonical example is `Clock`
 * (held-out F1 ~0.07 under v2): most of its gold is 2-hop, low-density, and not
 * name-matched, so no static signal reaches it.
 *
 * v3 adds the one signal that DOES reach those files and that BOTH grep and static
 * reverse-reachability lack: **co-change frequency**. Mined gold-blind from git
 * history (`bench/mine-cochange.mjs`): for the anchor's subject file, how often does
 * each OTHER file change in the SAME commits. Files engineers historically edit
 * together with the anchor are likely real dependents even when no call edge exists.
 *
 * DESIGN (kept faithful to v2's "additive, no hard tiers" philosophy so it can't
 * bury denser production dependents):
 *   - The bonus is a BOUNDED, RANK-BASED nudge, not the raw count. Raw co-change
 *     counts span 3..95 across anchors; feeding them in raw would let a high-history
 *     hub swamp density. Instead we map a file's co-change RANK (1st, 2nd, … among
 *     co-changed files) to a small additive bonus that decays with rank, capped at
 *     `cochangeMax`. So "this is one of the handful of files most often edited with
 *     the anchor" is worth ≈ a few references; deep-tail co-change is worth ~0.
 *   - HISTORY-GATED: applied only when the subject file has ≥ `minCommits` commits
 *     of history (below that, co-change is too noisy to trust). Disclosed limit.
 *   - Co-change can ADD candidates the static graph never surfaced (a gold file with
 *     no impact/callers edge). Those enter as tier "cochange" with their bonus as
 *     the whole score — they sit just above pure-weak static files, below dense ones.
 *   - GOLD-BLIND: keyed only on the anchor's own commit history, never on which
 *     files are gold.
 *
 * The static half of the score is BYTE-FOR-BYTE v2 (same weights, same test penalty,
 * same name-match, same tiers) so any held-out delta is attributable to co-change alone.
 *
 * Pure & dependency-light: parsed impact/callers JSON + subjectFile + anchor +
 * optional `cochange` map ({basename: count}) in; ranked rows out. If `cochange` is
 * omitted/empty, v3 === v2 exactly (graceful no-op).
 */

const WEIGHTS = {
  direct: 8,
  pkg: 4,
  nameMatch: 10,
  minAnchorWord: 4,
  testPenalty: 100000,
  // ── co-change (v3) ──
  // Rank-based additive bonus: the i-th most-co-changed file (0-indexed) gets
  // cochangeMax * (1 - i/cochangeSpan), floored at 0.
  //
  // HONEST FINDING (validated held-out, see bench/COCHANGE-FINDING.md): at the
  // benchmark's headline budget (top-20), co-change is NEUTRAL-TO-NEGATIVE. A weight
  // sweep gives held-out mean F1 {max=2: 0.519 (= v2), max=4/6: 0.514, max=10/15:
  // 0.494} — there is NO setting that beats v2's 0.519. The signal is REAL (diag
  // shows it promotes true low-static-edge gold like dfsoutputstream/datastreamer/
  // namenoderpcserver into the top-20) but REDUNDANT here: v2's static top-20 is
  // already saturated with correct dense dependents, so co-change's unique finds get
  // crowded out rather than replacing wrong picks. At a TIGHTER budget (top-10) it is
  // a marginal +0.006. Therefore the DEFAULT is set to 2 (exactly neutral vs v2) and
  // co-change ships as an opt-in signal, not a headline win. Kept (not deleted) as a
  // documented, reproducible negative result and a building block for non-budget-
  // capped or multi-signal-fusion downstream uses.
  cochangeMax: 2,
  cochangeSpan: 15, // beyond the 15th co-changed file the bonus is ~0
  minCommits: 4, // history gate: fewer commits => co-change too noisy, skip it
  cochangeMinCount: 2, // a file must co-change >=2x to earn any bonus (drop 1-offs)
};

function anchorWord(anchor) {
  return String(anchor || "").toLowerCase().replace(/[^a-z0-9]/g, "").replace(/\d+$/, "");
}
function normPath(f) {
  return String(f || "").replace(/\\/g, "/");
}
export function basename(f) {
  return normPath(f).split("/").pop().toLowerCase().replace(/\.java$/, "");
}
function pkgOf(f) {
  const parts = normPath(f).split("/");
  parts.pop();
  return parts.join("/");
}

const TEST_PATH_RE = /(^|\/)(test|tests)\//i;
const TEST_NAME_RE = /^(test|mock|dummy|fake|stub|itest|abstracttest)|(test|tests|itcase|testcase|testbase)$/i;
export function isTestFile(filePath) {
  const p = normPath(filePath);
  if (TEST_PATH_RE.test(p)) return true;
  const b = p.split("/").pop().replace(/\.java$/i, "");
  return TEST_NAME_RE.test(b);
}

/**
 * Build a basename -> co-change bonus map from a mined co-change result.
 * `cochange` is { basename: count } sorted desc by count (mine-cochange.mjs output).
 * Returns a Map and the set of co-changed basenames that cleared cochangeMinCount.
 */
function cochangeBonuses(cochange, commits, weights) {
  const bonus = new Map();
  if (!cochange || typeof cochange !== "object") return bonus;
  if (!(commits >= weights.minCommits)) return bonus; // history gate
  const entries = Object.entries(cochange)
    .filter(([, c]) => c >= weights.cochangeMinCount)
    .sort((a, b) => b[1] - a[1]);
  for (let i = 0; i < entries.length; i++) {
    const decay = 1 - i / weights.cochangeSpan;
    if (decay <= 0) break;
    bonus.set(entries[i][0], weights.cochangeMax * decay);
  }
  return bonus;
}

/**
 * @param {object} opts
 * @param {object|null} opts.impactJson
 * @param {object|null} opts.callersJson
 * @param {string} opts.subjectFile
 * @param {string} opts.anchor
 * @param {object} [opts.cochange]   { basename: count } from mine-cochange (gold-blind)
 * @param {number} [opts.cochangeCommits] number of commits the co-change was mined over
 * @param {object} [opts.weights]
 */
export function rankImpact({ impactJson, callersJson, subjectFile, anchor, cochange = null, cochangeCommits = 0, weights = WEIGHTS }) {
  const refCount = new Map();
  const repPath = new Map();
  const affected = (impactJson && Array.isArray(impactJson.affected)) ? impactJson.affected : [];
  for (const a of affected) {
    const fp = a && a.filePath;
    if (!fp) continue;
    const k = basename(fp);
    refCount.set(k, (refCount.get(k) || 0) + 1);
    if (!repPath.has(k)) repPath.set(k, normPath(fp));
  }

  const direct = new Set();
  const callers = (callersJson && (callersJson.callers || callersJson.results)) || [];
  for (const c of callers) {
    const fp = (c && (c.filePath || (c.location && c.location.filePath))) || null;
    if (fp) {
      const k = basename(fp);
      direct.add(k);
      if (!repPath.has(k)) repPath.set(k, normPath(fp));
    }
  }

  const subjPkg = pkgOf(subjectFile);
  const anchorKey = String(anchor || "").toLowerCase();
  const aWord = anchorWord(anchor);
  const useName = aWord.length >= weights.minAnchorWord;
  const ccBonus = cochangeBonuses(cochange, cochangeCommits, weights);

  const rows = [];
  // v3: co-changed files can ADD candidates the static graph never surfaced.
  const keys = new Set([...refCount.keys(), ...direct, ...ccBonus.keys()]);
  for (const k of keys) {
    if (!k || k === anchorKey) continue;
    const path = repPath.get(k) || k;
    const refs = refCount.get(k) || 0;
    const isDirect = direct.has(k);
    const samePkg = pkgOf(path) === subjPkg && subjPkg.length > 0;
    const isTest = isTestFile(path);
    const nameMatch = useName && k.includes(aWord);
    const cc = ccBonus.get(k) || 0;

    // Static half is byte-for-byte v2; co-change is the only addition.
    let score =
      refs +
      (isDirect ? weights.direct : 0) +
      (samePkg ? weights.pkg : 0) +
      (nameMatch ? weights.nameMatch : 0) +
      cc;
    if (isTest) score -= weights.testPenalty;

    let tier;
    if (isTest) tier = "test";
    else if (isDirect) tier = "direct";
    else if (nameMatch) tier = "strong";
    else if (refs >= 3) tier = "strong";
    else if (cc > 0 && refs === 0) tier = "cochange"; // surfaced ONLY by history
    else tier = "weak";

    rows.push({ file: path, basename: k, score, tier, refs, direct: isDirect, samePkg, nameMatch, isTest, cochange: cc > 0 });
  }

  rows.sort((a, b) => (b.score - a.score) || (b.refs - a.refs) || a.basename.localeCompare(b.basename));
  return rows;
}

export { WEIGHTS };
