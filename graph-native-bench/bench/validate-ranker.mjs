#!/usr/bin/env node
/**
 * Validate the shipped impact-ranker module against live codegraph output on the
 * full I-series, scoring with the SAME hardened F1 (budget top-20). Proves the
 * production ranker reproduces the prototype's held-out win (mean F1 ~0.38 vs
 * raw-impact ~0.18) — and prints per-task so failures (hub classes) are visible.
 *
 *   node validate-ranker.mjs [--budget 20]
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { rankImpact, basename } from "../extension/impact-ranker.mjs";

const CG = process.env.GRAPHCODE_CODEGRAPH_BIN || "/Users/eric/Documents/graphcode/codegraph/dist/bin/codegraph.js";
const EVAL = "/Users/eric/Documents/codegraph/hadoop-mcp-eval";
const HADOOP = "/Users/eric/Documents/codegraph/hadoop";

// Benchmark-integrity manifest: held-out split (no tuning leakage) + dedup groups
// (honest effective N) + oracle-as-floor. Single source of truth.
const MANIFEST = JSON.parse(readFileSync(`${EVAL}/tasks/impact-manifest.json`, "utf-8"));
const TUNED = new Set(MANIFEST.tuned_on);
// tasks to DROP because a dedup group keeps a different representative
const DROP = new Set(MANIFEST.dedup_groups.flatMap((g) => g.tasks.filter((t) => t !== g.keep)));

const budget = (() => {
  const i = process.argv.indexOf("--budget");
  return i >= 0 ? Number(process.argv[i + 1]) : 20;
})();

function loadYaml(path) {
  const out = spawnSync("python3", ["-c", "import json,yaml,sys;print(json.dumps(yaml.safe_load(open(sys.argv[1]))))", path], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out.stdout);
}
function cgJson(args) {
  const r = spawnSync(process.execPath, [CG, ...args], { encoding: "utf-8", timeout: 160_000, maxBuffer: 128 * 1024 * 1024 });
  try { return JSON.parse(r.stdout); } catch { return null; }
}
function impactFilesOrdered(impactJson) {
  const seen = new Set(); const out = [];
  for (const a of (impactJson?.affected || [])) {
    const fp = a?.filePath; if (!fp) continue;
    const k = basename(fp); if (!seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}
function prf(named, goldKeys, b) {
  const cap = named.slice(0, b);
  const matched = new Set(cap.filter((k) => goldKeys.has(k)));
  const valid = cap.filter((k) => goldKeys.has(k)).length;
  const p = cap.length ? valid / cap.length : 0;
  const r = goldKeys.size ? matched.size / goldKeys.size : 0;
  const f1 = p + r > 0 ? (2 * p * r) / (p + r) : 0;
  return { p, r, f1, valid };
}

const doc = loadYaml(`${EVAL}/tasks/pr-derived-tasks.yaml`);
const tasks = (doc.tasks || [])
  .filter((t) => t.category === "impact" && t.expected_caller_files && t.subject_file)
  .filter((t) => !DROP.has(t.id)); // collapse dedup groups → honest effective N

console.log(`\nRanker validation (budget top-${budget}) — production module vs raw-impact oracle`);
console.log(`manifest: ${TUNED.size} tuned, ${DROP.size} dropped as duplicates, ${tasks.length} scored\n`);
console.log("task".padEnd(5), "anchor".padEnd(28), "gold".padStart(4), " oracleF1", " rankerF1", " delta", " beats?", " set");
const held = [];
for (const t of tasks) {
  const anchor = t.expected_anchors[0];
  const goldKeys = new Set(t.expected_caller_files.map(basename));
  const impactJson = cgJson(["impact", anchor, "--path", HADOOP, "--depth", "2", "--json"]);
  const callersJson = cgJson(["callers", anchor, "--path", HADOOP, "--limit", "50", "--json"]);
  const oracleF1 = prf(impactFilesOrdered(impactJson), goldKeys, budget).f1; // raw-impact floor
  const ranked = rankImpact({ impactJson, callersJson, subjectFile: t.subject_file, anchor }).map((x) => x.basename);
  const rankF1 = prf(ranked, goldKeys, budget).f1;
  const tuned = TUNED.has(t.id);
  console.log(
    t.id.padEnd(5), anchor.slice(0, 27).padEnd(28), String(goldKeys.size).padStart(4),
    oracleF1.toFixed(2).padStart(8), rankF1.toFixed(2).padStart(8),
    ((rankF1 - oracleF1) >= 0 ? "+" : "") + (rankF1 - oracleF1).toFixed(2).padStart(5),
    (rankF1 > oracleF1 ? "  yes" : "   no").padStart(6),
    tuned ? " tuned" : " HELDOUT",
  );
  if (!tuned) held.push({ oracleF1, rankF1, beats: rankF1 > oracleF1 });
}
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
const beats = held.filter((h) => h.beats).length;
console.log(
  `\nHELD-OUT (n=${held.length}, dedup'd, never tuned): raw-impact oracle F1 ${mean(held.map((h) => h.oracleF1)).toFixed(3)} → ranker F1 ${mean(held.map((h) => h.rankF1)).toFixed(3)} ` +
  `(+${(mean(held.map((h) => h.rankF1)) - mean(held.map((h) => h.oracleF1))).toFixed(3)})`,
);
console.log(`ranker beats the oracle floor on ${beats}/${held.length} held-out tasks.`);
