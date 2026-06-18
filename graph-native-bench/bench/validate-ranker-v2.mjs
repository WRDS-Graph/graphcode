#!/usr/bin/env node
/**
 * Held-out validator for an arbitrary ranker module — lets us A/B ranker v1 vs v2
 * on the SAME live codegraph signal with the SAME hardened F1 (budget top-20),
 * honoring the integrity manifest (tuned split + dedup). Caches codegraph JSON to
 * disk so iterating on the ranker doesn't re-pay the 12k-file graph queries.
 *
 *   node validate-ranker-v2.mjs --ranker ../extension/impact-ranker.mjs      # v1 baseline
 *   node validate-ranker-v2.mjs --ranker ../extension/impact-ranker-v2.mjs   # v2 candidate
 *   node validate-ranker-v2.mjs --ranker ../extension/impact-ranker-v2.mjs --diag   # per-task tier diag
 *
 * The headline line is identical in format to validate-ranker.mjs so numbers are
 * directly comparable to the published 0.386-vs-0.169 baseline.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";

const CG = process.env.GRAPHCODE_CODEGRAPH_BIN || "/Users/eric/Documents/graphcode/codegraph/dist/bin/codegraph.js";
const EVAL = "/Users/eric/Documents/codegraph/hadoop-mcp-eval";
const HADOOP = "/Users/eric/Documents/codegraph/hadoop";
const CACHE = "/Users/eric/Documents/graphcode/graphcode-cli/bench/.cg-cache";

const args = process.argv.slice(2);
const get = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const has = (f) => args.includes(f);
const budget = Number(get("--budget", "20"));
const rankerArg = get("--ranker", "../extension/impact-ranker.mjs");
const rankerPath = isAbsolute(rankerArg) ? rankerArg : resolve(process.cwd(), rankerArg);
const diag = has("--diag");

const MANIFEST = JSON.parse(readFileSync(`${EVAL}/tasks/impact-manifest.json`, "utf-8"));
const TUNED = new Set(MANIFEST.tuned_on);
const DROP = new Set(MANIFEST.dedup_groups.flatMap((g) => g.tasks.filter((t) => t !== g.keep)));

function baseKey(p) { return String(p).replace(/\\/g, "/").split("/").pop().toLowerCase().replace(/\.java$/, ""); }
function loadYaml(path) {
  const out = spawnSync("python3", ["-c", "import json,yaml,sys;print(json.dumps(yaml.safe_load(open(sys.argv[1]))))", path], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out.stdout);
}
function cgJsonCached(args, key) {
  if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
  const cp = join(CACHE, `${key}.json`);
  if (existsSync(cp)) { try { return JSON.parse(readFileSync(cp, "utf-8")); } catch { /* refetch */ } }
  const r = spawnSync(process.execPath, [CG, ...args], { encoding: "utf-8", timeout: 160_000, maxBuffer: 128 * 1024 * 1024 });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { parsed = null; }
  if (parsed) writeFileSync(cp, JSON.stringify(parsed), "utf-8");
  return parsed;
}
function impactFilesOrdered(impactJson) {
  const seen = new Set(); const out = [];
  for (const a of (impactJson?.affected || [])) {
    const fp = a?.filePath; if (!fp) continue;
    const k = baseKey(fp); if (!seen.has(k)) { seen.add(k); out.push(k); }
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

const { rankImpact, basename } = await import(rankerPath);

const doc = loadYaml(`${EVAL}/tasks/pr-derived-tasks.yaml`);
const tasks = (doc.tasks || [])
  .filter((t) => t.category === "impact" && t.expected_caller_files && t.subject_file)
  .filter((t) => !DROP.has(t.id));

console.log(`\nRanker validation (budget top-${budget}) — module: ${rankerArg}`);
console.log(`manifest: ${TUNED.size} tuned, ${DROP.size} dropped as duplicates, ${tasks.length} scored\n`);
console.log("task".padEnd(5), "anchor".padEnd(26), "gold".padStart(4), " oracleF1", " rankerF1", " delta", " beats?", " set");
const held = []; const all = [];
for (const t of tasks) {
  const anchor = t.expected_anchors[0];
  const goldKeys = new Set(t.expected_caller_files.map(baseKey));
  const impactJson = cgJsonCached(["impact", anchor, "--path", HADOOP, "--depth", "2", "--json"], `impact_${anchor}`);
  const callersJson = cgJsonCached(["callers", anchor, "--path", HADOOP, "--limit", "50", "--json"], `callers_${anchor}`);
  const oracleF1 = prf(impactFilesOrdered(impactJson), goldKeys, budget).f1;
  const ranked = rankImpact({ impactJson, callersJson, subjectFile: t.subject_file, anchor });
  const rankedKeys = ranked.map((x) => x.basename);
  const m = prf(rankedKeys, goldKeys, budget);
  const tuned = TUNED.has(t.id);
  console.log(
    t.id.padEnd(5), anchor.slice(0, 25).padEnd(26), String(goldKeys.size).padStart(4),
    oracleF1.toFixed(2).padStart(8), m.f1.toFixed(2).padStart(8),
    ((m.f1 - oracleF1) >= 0 ? "+" : "") + (m.f1 - oracleF1).toFixed(2).padStart(5),
    (m.f1 > oracleF1 ? "  yes" : "   no").padStart(6),
    tuned ? " tuned" : " HELDOUT",
  );
  if (diag) {
    const top = ranked.slice(0, budget);
    const hit = top.filter((r) => goldKeys.has(r.basename)).map((r) => r.basename);
    const miss = [...goldKeys].filter((g) => !rankedKeys.slice(0, budget).includes(g));
    console.log(`      hits@${budget}: ${hit.join(", ") || "(none)"}`);
    console.log(`      missed gold: ${miss.join(", ") || "(none)"}`);
  }
  const row = { id: t.id, oracleF1, rankF1: m.f1, beats: m.f1 > oracleF1, tuned };
  all.push(row);
  if (!tuned) held.push(row);
}
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
const beats = held.filter((h) => h.beats).length;
const oMean = mean(held.map((h) => h.oracleF1));
const rMean = mean(held.map((h) => h.rankF1));
console.log(
  `\nHELD-OUT (n=${held.length}, dedup'd, never tuned): raw-impact oracle F1 ${oMean.toFixed(3)} → ranker F1 ${rMean.toFixed(3)} (+${(rMean - oMean).toFixed(3)})`,
);
console.log(`ranker beats the oracle floor on ${beats}/${held.length} held-out tasks.`);
console.log(`ALL-TASK mean ranker F1 (incl. tuned, n=${all.length}): ${mean(all.map((h) => h.rankF1)).toFixed(3)}`);
