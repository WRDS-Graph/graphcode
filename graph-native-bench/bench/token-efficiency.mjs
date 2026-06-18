#!/usr/bin/env node
/**
 * Token-efficiency frontier: F1 vs output tokens per arm.
 *
 * The graph-native arm's strongest HONEST claim isn't raw F1 — on a clean-structure
 * task the MCP arm can win outright — it's COST: it reaches competitive F1 with far
 * fewer output tokens, because a ranked shortlist means fewer false positives to
 * describe and fewer retrieval turns. This re-scores existing run outputs (no new
 * agent runs) and reports F1, output tokens, and F1-per-1k-output-tokens.
 *
 *   node token-efficiency.mjs --tasks I2,I8 --arms control,codegraph,graphcode-native --budget 20
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { extractFinalAnswer, readJsonl } from "../../../codegraph/hadoop-mcp-eval/scripts/lib/trace-parse.mjs";

const EVAL = "/Users/eric/Documents/codegraph/hadoop-mcp-eval";
const MODEL = "sonnet-4.6";

function loadYaml(path) {
  const out = spawnSync("python3", ["-c", "import json,yaml,sys;print(json.dumps(yaml.safe_load(open(sys.argv[1]))))", path], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out.stdout);
}
function baseKey(s) { return String(s).replace(/\\/g, "/").split("/").pop().toLowerCase().replace(/\.java$/, ""); }
function namedRanked(answer) {
  const m = (answer || "").match(/```json\s*([\s\S]*?)```/i);
  const out = []; const seen = new Set();
  if (m) { try {
    const o = JSON.parse(m[1]);
    for (const x of [...(o.dependent_files || []), ...(o.dependent_classes || [])]) {
      const k = baseKey(x); if (k && !seen.has(k)) { seen.add(k); out.push(k); }
    }
  } catch { /* */ } }
  return out;
}
function f1(named, gold, budget) {
  const g = new Set(gold.map(baseKey)); const cap = named.slice(0, budget);
  const valid = cap.filter((k) => g.has(k)).length;
  const matched = new Set(cap.filter((k) => g.has(k)));
  const p = cap.length ? valid / cap.length : 0;
  const r = g.size ? matched.size / g.size : 0;
  return p + r > 0 ? (2 * p * r) / (p + r) : 0;
}
function outTokens(records) {
  const rc = [...records].reverse().find((r) => r.type === "run_complete") || {};
  const u = rc.usage || {};
  return u.output_tokens ?? u.output ?? null;
}

const args = process.argv.slice(2);
const get = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const tasks = get("--tasks", "I2,I8").split(",");
const arms = get("--arms", "control,codegraph,graphcode-native").split(",");
const budget = Number(get("--budget", "20"));
const doc = loadYaml(`${EVAL}/tasks/pr-derived-tasks.yaml`);

console.log(`\nToken-efficiency frontier (budget top-${budget})\n`);
console.log("task".padEnd(5), "arm".padEnd(20), "F1".padEnd(6), "outTok".padEnd(8), "F1/1k-outTok");
const agg = {};
for (const tid of tasks) {
  const task = doc.tasks.find((t) => t.id === tid);
  if (!task) continue;
  const gold = task.expected_caller_files || [];
  for (const arm of arms) {
    // pick the best available run file (r1..r6), preferring the latest committed
    let chosen = null;
    for (const r of [6, 5, 4, 3, 2, 1]) {
      const p = join(EVAL, "outputs", "agent-runs", MODEL, tid, arm, `r${r}.jsonl`);
      if (existsSync(p)) { chosen = p; break; }
    }
    if (!chosen) { console.log(tid.padEnd(5), arm.padEnd(20), "(no run)"); continue; }
    const records = readJsonl(chosen);
    const ans = extractFinalAnswer(records) || "";
    const score = f1(namedRanked(ans), gold, budget);
    const tok = outTokens(records);
    const eff = tok ? (score / (tok / 1000)) : null;
    console.log(
      tid.padEnd(5), arm.padEnd(20), score.toFixed(2).padEnd(6),
      (tok ?? "—").toString().padEnd(8), eff != null ? eff.toFixed(3) : "—",
    );
    (agg[arm] ||= []).push({ score, tok, eff });
  }
  console.log("");
}
console.log("── per-arm means ──");
for (const arm of arms) {
  const xs = (agg[arm] || []).filter((x) => x.tok != null);
  if (!xs.length) continue;
  const mean = (k) => xs.reduce((s, x) => s + x[k], 0) / xs.length;
  console.log(`${arm.padEnd(20)} meanF1 ${mean("score").toFixed(2)}  meanOutTok ${Math.round(mean("tok"))}  meanF1/1k ${mean("eff").toFixed(3)}`);
}
