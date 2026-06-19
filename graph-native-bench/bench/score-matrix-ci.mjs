#!/usr/bin/env node
/**
 * Multi-run matrix scorer with confidence intervals.
 *
 * Closes the original benchmark's #1 statistical threat-to-validity (n=1 per cell).
 * For each task × arm, scores EVERY available run (r<min>..r<max>, or an explicit
 * --runs list) with the SAME hardened F1 (budget top-20, basename set-match, single
 * `dependent_files` field) as score-impact-hardened.mjs, then reports:
 *   - mean F1 ± 95% CI (Student-t for small n), and per-run F1 values
 *   - mean precision / recall / output tokens / cost / graph / read / grep
 *   - the raw-codegraph-impact ORACLE floor (scored identically), as the bar to beat
 *   - per-task winner among arms (by mean F1)
 *
 * Usage:
 *   node score-matrix-ci.mjs --tasks I1,I8,I10 \
 *     --arms control,codegraph,graphcode-native-claude --runs 101,102,103 --budget 20
 *   (omit --runs to auto-discover all r*.jsonl per cell)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractFinalAnswer, extractToolTrace, readJsonl } from "../../../codegraph/hadoop-mcp-eval/scripts/lib/trace-parse.mjs";

const EVAL = "/Users/eric/Documents/codegraph/hadoop-mcp-eval";
const CG = process.env.GRAPHCODE_CODEGRAPH_BIN || "/Users/eric/Documents/graphcode/codegraph/dist/bin/codegraph.js";
const HADOOP = "/Users/eric/Documents/codegraph/hadoop";
const MODEL = "sonnet-4.6";

const args = process.argv.slice(2);
const get = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const tasks = get("--tasks", "I1,I8,I10").split(",").map((s) => s.trim());
const arms = get("--arms", "control,codegraph,graphcode-native-claude").split(",").map((s) => s.trim());
const runsArg = get("--runs", null);
const explicitRuns = runsArg ? runsArg.split(",").map((s) => Number(s.trim())) : null;
const budget = Number(get("--budget", "20"));

function loadYaml(path) {
  const out = spawnSync("python3", ["-c", "import json,yaml,sys;print(json.dumps(yaml.safe_load(open(sys.argv[1]))))", path], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out.stdout);
}
function baseKey(s) { return String(s).replace(/\\/g, "/").split("/").pop().toLowerCase().replace(/\.java$/, ""); }
function namedRanked(answer) {
  const m = (answer || "").match(/```json\s*([\s\S]*?)```/i);
  const out = []; const seen = new Set();
  if (m) {
    try {
      const o = JSON.parse(m[1]);
      for (const x of [...(o.dependent_files || []), ...(o.dependent_classes || [])]) {
        const k = baseKey(x); if (k && !seen.has(k)) { seen.add(k); out.push(k); }
      }
    } catch { /* */ }
  }
  if (!out.length) {
    for (const p of (answer.match(/[A-Za-z0-9/_.-]+\.java/g) || [])) {
      const k = baseKey(p); if (k && !seen.has(k)) { seen.add(k); out.push(k); }
    }
  }
  return out;
}
function prf(named, gold, b) {
  const g = new Set(gold.map(baseKey)); const cap = named.slice(0, b);
  const matched = new Set(cap.filter((k) => g.has(k)));
  const valid = cap.filter((k) => g.has(k)).length;
  const p = cap.length ? valid / cap.length : 0;
  const r = g.size ? matched.size / g.size : 0;
  const f1 = p + r > 0 ? (2 * p * r) / (p + r) : 0;
  return { p, r, f1 };
}
function oracleRanked(anchor) {
  const r = spawnSync(process.execPath, [CG, "impact", anchor, "--path", HADOOP, "--depth", "2"], { encoding: "utf-8", timeout: 150_000, maxBuffer: 128 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) return [];
  const out = r.stdout.replace(/\x1b\[[0-9;]*m/g, "");
  const seen = new Set(); const ranked = [];
  for (const p of (out.match(/[A-Za-z0-9/_.-]+\.java/g) || [])) { const k = baseKey(p); if (k && !seen.has(k)) { seen.add(k); ranked.push(k); } }
  return ranked;
}
function runComplete(records) { return [...records].reverse().find((r) => r.type === "run_complete") || {}; }
function scoreRun(jsonlPath, gold) {
  if (!existsSync(jsonlPath)) return null;
  const records = readJsonl(jsonlPath);
  const rc = runComplete(records);
  if (rc.status !== "finished") return null; // skip unfinished/timeout/shallow-error
  const trace = extractToolTrace(records);
  const answer = extractFinalAnswer(records) || "";
  const u = rc.usage || {};
  const s = prf(namedRanked(answer), gold, budget);
  const graph = Object.entries(trace.tool_counts).filter(([n]) => n.toLowerCase().includes("codegraph") || n.toLowerCase().startsWith("mcp_")).reduce((a, [, c]) => a + c, 0);
  return {
    f1: s.f1, p: s.p, r: s.r,
    out: u.output_tokens ?? u.output ?? null,
    cost: rc.costUsd ?? null,
    read: trace.read_count, grep: trace.grep_count, graph,
  };
}
// Student-t two-sided 95% critical values for small df (1..10), then ~1.96.
const T95 = { 1: 12.71, 2: 4.30, 3: 3.18, 4: 2.78, 5: 2.57, 6: 2.45, 7: 2.36, 8: 2.31, 9: 2.26, 10: 2.23 };
function meanCI(xs) {
  const n = xs.length;
  if (!n) return { mean: null, ci: null, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { mean, ci: null, n: 1 };
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const t = T95[n - 1] ?? 1.96;
  return { mean, ci: t * sd / Math.sqrt(n), n };
}
const fmt = (x, d = 2) => (x == null ? "—" : Number(x).toFixed(d));

const doc = loadYaml(`${EVAL}/tasks/pr-derived-tasks.yaml`);
const report = { budget, tasks: {} };
console.log(`\n=== Multi-run matrix — hardened F1 @ top-${budget}, mean ± 95% CI ===\n`);

for (const tid of tasks) {
  const task = doc.tasks.find((t) => t.id === tid);
  if (!task) { console.log(`(task ${tid} not found)`); continue; }
  const gold = task.expected_caller_files || [];
  const anchor = (task.expected_anchors || [])[0];
  console.log(`── ${tid}  (${task.title})  gold=${gold.length}`);
  console.log("   arm".padEnd(28), "n", " meanF1±95%CI".padEnd(18), "perRunF1".padEnd(22), "prec", "rec ", "outTok", "cost", "g/r/grep");
  const armMeans = {};
  for (const arm of arms) {
    const armDir = join(EVAL, "outputs", "agent-runs", MODEL, tid, arm);
    let runNums = [];
    if (explicitRuns) runNums = explicitRuns;
    else if (existsSync(armDir)) runNums = readdirSync(armDir).map((f) => /^r(\d+)\.jsonl$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
    const scored = [];
    for (const rn of runNums) { const s = scoreRun(join(armDir, `r${rn}.jsonl`), gold); if (s) scored.push(s); }
    report.tasks[tid] = report.tasks[tid] || { gold: gold.length, arms: {} };
    report.tasks[tid].arms[arm] = scored;
    if (!scored.length) { console.log(`   ${arm.padEnd(25)} (no finished runs)`); continue; }
    const f1s = scored.map((s) => s.f1);
    const ci = meanCI(f1s);
    armMeans[arm] = ci.mean;
    const mAcc = (k) => { const xs = scored.map((s) => s[k]).filter((x) => x != null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
    console.log(
      `   ${arm.padEnd(25)}`,
      String(ci.n).padEnd(1),
      `${fmt(ci.mean)}${ci.ci != null ? ` ± ${fmt(ci.ci)}` : ""}`.padEnd(18),
      `[${f1s.map((x) => fmt(x)).join(",")}]`.padEnd(22),
      fmt(mAcc("p")), fmt(mAcc("r")),
      String(Math.round(mAcc("out") ?? 0)).padEnd(6),
      mAcc("cost") != null ? `$${fmt(mAcc("cost"), 3)}` : "—",
      `${fmt(mAcc("graph"), 0)}/${fmt(mAcc("read"), 0)}/${fmt(mAcc("grep"), 0)}`,
    );
  }
  // Oracle floor
  if (anchor) {
    const ranked = oracleRanked(anchor);
    const o = prf(ranked, gold, budget);
    report.tasks[tid].oracle = { f1: o.f1, p: o.p, r: o.r, files: ranked.length };
    console.log(`   ${"graph-oracle(raw impact)".padEnd(25)} -`, `${fmt(o.f1)}`.padEnd(18), `(precision floor; ${ranked.length} files uncapped)`);
  }
  const winner = Object.entries(armMeans).sort((a, b) => b[1] - a[1])[0];
  if (winner) console.log(`   → winner: ${winner[0]} (mean F1 ${fmt(winner[1])})\n`);
  report.tasks[tid].winner = winner ? winner[0] : null;
}

// Aggregate across tasks
console.log("=== Aggregate (mean of per-task mean F1) ===");
const agg = {};
for (const arm of arms) {
  const means = tasks.map((t) => {
    const a = report.tasks[t]?.arms?.[arm];
    if (!a || !a.length) return null;
    return a.reduce((s, x) => s + x.f1, 0) / a.length;
  }).filter((x) => x != null);
  if (means.length) agg[arm] = means.reduce((a, b) => a + b, 0) / means.length;
}
for (const [arm, m] of Object.entries(agg).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${arm.padEnd(28)} mean-of-means F1 = ${fmt(m)}`);
}
console.log("\n" + JSON.stringify(report, null, 2));
