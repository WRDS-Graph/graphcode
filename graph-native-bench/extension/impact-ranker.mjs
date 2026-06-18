/**
 * Graph-native impact ranker.
 *
 * The honest research finding (bench/AUDIT-FINDINGS.md, BENCHMARK-REDESIGN.md):
 * `codegraph impact <anchor>` has recall ~1.0 but precision ~0.06 — it returns a
 * 400-file firehose in file/line order, so its top-N is mediocre (F1 ~0.18). The
 * legacy harness "won" only by pasting that firehose into the prompt and letting a
 * recall-only substring metric reward transcription. Under gaming-resistant F1 with
 * a budget cap, that paste scores parity with brute-force grep — no real win.
 *
 * The REAL graph-native capability is RANKING: float the true dependents to the top
 * using graph signal so the budgeted top-N is mostly correct. This module does that.
 * Validated on 11 HELD-OUT impact tasks (not tuned on): mean F1 0.38 vs raw-impact
 * 0.18 — more than double, generalizing, with honestly-reported failures (hub
 * classes like `Server` where package-locality misleads).
 *
 * Signals combined per candidate file:
 *   - reference density: how many affected symbols (from `impact --json`) live in it
 *   - direct-caller bonus: file appears in `callers --json` (a 1-hop dependent)
 *   - package locality: file shares the subject's package (co-located co-dependents)
 *
 * Pure, dependency-light: takes parsed impact/callers JSON + the subject file path,
 * returns a ranked list of {file, score, basename}. The harness supplies the JSON by
 * shelling codegraph; tests supply fixtures.
 */

const WEIGHTS = {
  direct: 5, // file is a direct (1-hop) caller of the anchor
  pkg: 20, // file lives in the subject's own package (strongest locality signal)
};

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

/**
 * @param {object} opts
 * @param {object|null} opts.impactJson  parsed `codegraph impact --json` ({affected:[{filePath,...}]})
 * @param {object|null} opts.callersJson parsed `codegraph callers --json` ({callers:[{filePath,...}]})
 * @param {string} opts.subjectFile      path to the file that defines the anchor
 * @param {string} opts.anchor           the changing symbol (its own file is excluded)
 * @param {object} [opts.weights]        override WEIGHTS
 * @returns {Array<{file:string, basename:string, score:number, refs:number, direct:boolean, samePkg:boolean}>}
 */
export function rankImpact({ impactJson, callersJson, subjectFile, anchor, weights = WEIGHTS }) {
  const refCount = new Map(); // basename -> count of affected symbols
  const repPath = new Map(); // basename -> a representative full path
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

  const rows = [];
  // union of impact files and direct callers (a direct caller might not appear in impact)
  const keys = new Set([...refCount.keys(), ...direct]);
  for (const k of keys) {
    if (!k || k === anchorKey) continue; // exclude the subject symbol's own file
    const refs = refCount.get(k) || 0;
    const isDirect = direct.has(k);
    const path = repPath.get(k) || k;
    const samePkg = pkgOf(path) === subjPkg && subjPkg.length > 0;
    const score = refs + (isDirect ? weights.direct : 0) + (samePkg ? weights.pkg : 0);
    rows.push({ file: path, basename: k, score, refs, direct: isDirect, samePkg });
  }

  rows.sort((a, b) => (b.score - a.score) || a.basename.localeCompare(b.basename));
  return rows;
}

export { WEIGHTS };
