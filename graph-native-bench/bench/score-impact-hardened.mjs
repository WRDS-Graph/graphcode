#!/usr/bin/env node
/**
 * Hardened impact scorer (gaming-resistant).
 *
 * Motivation (see bench/AUDIT-FINDINGS.md): the legacy impact metric is
 * `recall@k` computed as a SUBSTRING SCAN over the agent's whole prose answer,
 * while precision was computed only over the JSON block. That split lets an arm
 * paste the graph's 400-file firehose into prose to max out recall while a tidy
 * JSON keeps "precision" looking fine — and the graph's raw `impact` query has
 * recall 1.0 but precision ~0.06, so a paste-and-transcribe harness wins without
 * any engineering. Proven: native I2 went 0.10 → 0.80 recall purely by the
 * harness pasting the list and the agent copying it (1 tool call, 0 reasoning).
 *
 * This scorer closes the hole:
 *   1. ONE bounded structured answer. Precision AND recall both read the agent's
 *      `dependent_files` (its committed, ranked answer) — not prose, not different
 *      texts. Naming the firehose now tanks precision.
 *   2. F1 is the headline. Recall-only rewards dumping everything; F1 punishes the
 *      94%-false-positive firehose exactly as a real engineer would be punished for
 *      calling 400 files "affected" by a 25-file change.
 *   3. Budget cap (--budget N, default 20). Only the agent's top-N ranked
 *      dependents are scored, so the task becomes RANKING true dependents above
 *      false positives within a budget — a genuine graph capability, not transcription.
 *   4. Set-based matching by basename (no substring bleed: "NameNode.java" no longer
 *      matches inside "SecondaryNameNode.java" prose).
 *
 * Usage:
 *   node score-impact-hardened.mjs --task I2 --arms control,codegraph,graphcode-native
 *   node score-impact-hardened.mjs --task I2 --budget 20 --oracle   # add raw-graph reference row
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractFinalAnswer, extractToolTrace, readJsonl } from "../../../codegraph/hadoop-mcp-eval/scripts/lib/trace-parse.mjs";

const EVAL_DEFAULT = "/Users/eric/Documents/codegraph/hadoop-mcp-eval";
const CODEGRAPH_BIN = process.env.GRAPHCODE_CODEGRAPH_BIN || "/Users/eric/Documents/graphcode/codegraph/dist/bin/codegraph.js";

function loadYaml(path) {
  const script = "import json,yaml,sys\nprint(json.dumps(yaml.safe_load(open(sys.argv[1]))))";
  const out = spawnSync("python3", ["-c", script, path], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) throw new Error(`yaml load failed: ${out.stderr}`);
  return JSON.parse(out.stdout);
}

/** Basename comparison key: strip dirs + .java, lowercase. */
function baseKey(s) {
  return String(s).replace(/\\/g, "/").split("/").pop().toLowerCase().replace(/\.java$/, "");
}

/**
 * The agent's COMMITTED, RANKED answer — its `dependent_files` (∪ dependent_classes)
 * from the fenced JSON block, in order. This is the only thing scored: precision and
 * recall read the SAME bounded set. If the answer has no JSON block we fall back to
 * the markdown bullet list of *.java paths (still order-preserving), so a non-JSON
 * answer isn't unfairly zeroed — but prose substring bleed is never used.
 */
function namedDependentsRanked(answer) {
  const m = (answer || "").match(/```json\s*([\s\S]*?)```/i);
  if (m) {
    try {
      const obj = JSON.parse(m[1]);
      const files = (obj?.dependent_files || []).map(String);
      const classes = (obj?.dependent_classes || []).map(String);
      // files first (more specific), then classes; preserve order, dedup by basename
      const seen = new Set();
      const out = [];
      for (const x of [...files, ...classes]) {
        const k = baseKey(x);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push(k);
      }
      if (out.length) return out;
    } catch { /* malformed JSON — fall through */ }
  }
  // Fallback: ordered .java paths from prose bullets (NOT a substring scan of gold).
  const paths = answer.match(/[A-Za-z0-9/_.-]+\.java/g) || [];
  const seen = new Set();
  const out = [];
  for (const p of paths) {
    const k = baseKey(p);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/** Precision / recall / F1 of a ranked named-set against gold, capped to a budget. */
function scoreSet(rankedNamed, gold, budget) {
  const goldKeys = new Set(gold.map(baseKey));
  const capped = rankedNamed.slice(0, budget);
  if (capped.length === 0) {
    return { precision: 0, recall: 0, f1: 0, named: 0, valid: 0, gold: goldKeys.size };
  }
  let valid = 0;
  const matchedGold = new Set();
  for (const n of capped) {
    if (goldKeys.has(n)) { valid += 1; matchedGold.add(n); }
  }
  const precision = valid / capped.length;
  const recall = goldKeys.size ? matchedGold.size / goldKeys.size : null;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, named: capped.length, valid, gold: goldKeys.size };
}

/** Run raw `codegraph impact <anchor>` and return its ranked file basenames. */
function graphOracleRanked(anchor, repoPath, depth) {
  const isJs = CODEGRAPH_BIN.endsWith(".js") || CODEGRAPH_BIN.endsWith(".mjs");
  const cmd = isJs ? process.execPath : CODEGRAPH_BIN;
  const args = isJs ? [CODEGRAPH_BIN, "impact", anchor, "--path", repoPath, "--depth", String(depth)]
                    : ["impact", anchor, "--path", repoPath, "--depth", String(depth)];
  const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: 150_000, maxBuffer: 128 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) return [];
  const out = r.stdout.replace(/\x1b\[[0-9;]*m/g, "");
  const paths = out.match(/[A-Za-z0-9/_.-]+\.java/g) || [];
  const seen = new Set();
  const ranked = [];
  for (const p of paths) {
    const k = baseKey(p);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    ranked.push(k);
  }
  return ranked;
}

function parseArgs(argv) {
  const o = {
    task: "I2",
    arms: "control,codegraph,graphcode-native",
    model: "sonnet-4.6",
    runs: 1,
    eval: EVAL_DEFAULT,
    tasksFile: "tasks/pr-derived-tasks.yaml",
    budget: 20,
    depth: 2,
    oracle: false,
    run: null,
    allRuns: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--task") o.task = argv[++i];
    else if (a === "--arms") o.arms = argv[++i];
    else if (a === "--model") o.model = argv[++i];
    else if (a === "--runs") o.runs = Number(argv[++i]);
    else if (a === "--run") o.run = Number(argv[++i]);
    else if (a === "--all-runs") o.allRuns = true;
    else if (a === "--eval") o.eval = argv[++i];
    else if (a === "--tasks-file") o.tasksFile = argv[++i];
    else if (a === "--budget") o.budget = Number(argv[++i]);
    else if (a === "--depth") o.depth = Number(argv[++i]);
    else if (a === "--oracle") o.oracle = true;
  }
  return o;
}

function runComplete(records) {
  return [...records].reverse().find((r) => r.type === "run_complete") || {};
}
function extractCost(records) {
  const rc = runComplete(records);
  const u = rc.usage || {};
  return {
    output: u.output_tokens ?? u.output ?? null,
    cacheRead: u.cache_read_input_tokens ?? u.cacheRead ?? null,
    costUsd: rc.costUsd ?? rc.cost_usd ?? null,
  };
}

function scoreRun(jsonlPath, task, budget) {
  if (!existsSync(jsonlPath)) return null;
  const records = readJsonl(jsonlPath);
  const trace = extractToolTrace(records);
  const answer = extractFinalAnswer(records) || "";
  const cost = extractCost(records);
  const gold = task.expected_caller_files || [];
  const ranked = namedDependentsRanked(answer);
  const s = scoreSet(ranked, gold, budget);
  const graphCalls = Object.entries(trace.tool_counts)
    .filter(([n]) => n.toLowerCase().includes("codegraph") || n.toLowerCase().startsWith("mcp_"))
    .reduce((acc, [, c]) => acc + c, 0);
  return {
    precision: s.precision, recall: s.recall, f1: s.f1,
    named: s.named, valid: s.valid, gold: s.gold,
    read: trace.read_count, grep: trace.grep_count, graph_calls: graphCalls,
    out_tokens: cost.output, cache_read: cost.cacheRead, cost_usd: cost.costUsd,
  };
}

const med = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] : null);
const fmt = (x, d = 2) => (x == null ? "—" : Number(x).toFixed(d));

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tasksDoc = loadYaml(join(opts.eval, opts.tasksFile));
  const task = (tasksDoc.tasks || []).find((t) => t.id === opts.task);
  if (!task) throw new Error(`task ${opts.task} not found in ${opts.tasksFile}`);
  const repoPath = tasksDoc.repo?.path || "/Users/eric/Documents/codegraph/hadoop";
  const arms = opts.arms.split(",").map((s) => s.trim());

  console.log(`\nTask ${opts.task} — ${task.title}`);
  console.log(`gold=${(task.expected_caller_files || []).length} files | budget=top-${opts.budget} | model ${opts.model}\n`);
  console.log(
    "arm".padEnd(20), "F1".padEnd(6), "prec".padEnd(6), "recall".padEnd(7),
    "valid/named".padEnd(12), "graph", "read", "grep", "outTok", "costUSD",
  );

  const report = { task: opts.task, budget: opts.budget, gold: (task.expected_caller_files || []).length, arms: {} };
  for (const arm of arms) {
    const armDir = join(opts.eval, "outputs", "agent-runs", opts.model, opts.task, arm);
    // Run selection: --run N pins a specific run; otherwise score the LATEST
    // available r*.jsonl (run files may be r5/r6/r7, not r1). This keeps the
    // canonical scorer consistent with the documented results instead of silently
    // reading a stale r1. --all-runs scores every available run (for medians).
    let runFiles = [];
    if (opts.run != null) {
      runFiles = [join(armDir, `r${opts.run}.jsonl`)];
    } else if (existsSync(armDir)) {
      const nums = readdirSync(armDir)
        .map((f) => /^r(\d+)\.jsonl$/.exec(f))
        .filter(Boolean)
        .map((m) => Number(m[1]))
        .sort((a, b) => a - b);
      if (opts.allRuns) runFiles = nums.map((n) => join(armDir, `r${n}.jsonl`));
      else if (nums.length) runFiles = [join(armDir, `r${nums[nums.length - 1]}.jsonl`)];
    }
    const runs = [];
    for (const p of runFiles) {
      const sc = scoreRun(p, task, opts.budget);
      if (sc) runs.push({ ...sc, _file: p.split("/").pop() });
    }
    report.arms[arm] = runs;
    if (!runs.length) { console.log(arm.padEnd(20), "(no runs)"); continue; }
    const f1 = med(runs.map((r) => r.f1));
    const pr = med(runs.map((r) => r.precision));
    const rc = med(runs.map((r) => r.recall).filter((x) => x != null));
    const vn = `${med(runs.map((r) => r.valid))}/${med(runs.map((r) => r.named))}`;
    console.log(
      arm.padEnd(20), fmt(f1).padEnd(6), fmt(pr).padEnd(6), fmt(rc).padEnd(7),
      vn.padEnd(12),
      String(med(runs.map((r) => r.graph_calls))).padEnd(5),
      String(med(runs.map((r) => r.read))).padEnd(4),
      String(med(runs.map((r) => r.grep))).padEnd(4),
      (() => { const o = runs.map((r) => r.out_tokens).filter((x) => x != null); return o.length ? String(med(o)) : "—"; })().padEnd(6),
      (() => { const c = runs.map((r) => r.cost_usd).filter((x) => x != null); return c.length ? med(c).toFixed(3) : "—"; })(),
      runs.length === 1 ? `[${runs[0]._file}]` : `[n=${runs.length}]`,
    );
  }

  if (opts.oracle) {
    const anchor = (task.expected_anchors || [])[0];
    const ranked = graphOracleRanked(anchor, repoPath, opts.depth);
    const sFull = scoreSet(ranked, task.expected_caller_files || [], 10_000);
    const sCap = scoreSet(ranked, task.expected_caller_files || [], opts.budget);
    console.log(
      "graph-oracle(raw)".padEnd(20), fmt(sCap.f1).padEnd(6), fmt(sCap.precision).padEnd(6), fmt(sCap.recall).padEnd(7),
      `${sCap.valid}/${sCap.named}`.padEnd(12), "1".padEnd(5), "0".padEnd(4), "0".padEnd(4), "0".padEnd(6), "0.000",
    );
    console.log(
      `   └─ uncapped raw impact: ${ranked.length} files, recall=${fmt(sFull.recall)} precision=${fmt(sFull.precision, 3)} ` +
      `(this is the firehose the legacy metric rewarded)`,
    );
    report.oracle = { uncapped: sFull, capped: sCap, fileCount: ranked.length };
  }

  console.log("\n" + JSON.stringify(report, null, 2));
}

main();
