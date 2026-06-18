#!/usr/bin/env node
/**
 * Focused scorer for the graph-native research loop.
 *
 * Scores a set of arm transcripts for ONE task using the EXACT metric logic from
 * hadoop-mcp-eval/scripts/score-runs.mjs (scoreEdge/scoreDta/scoreCfrd/scoreQuality)
 * and trace-parse.mjs for tool counts — so numbers are directly comparable to the
 * eval's, but scoring is isolated to my runs and never clobbers the committed
 * outputs/agent-runs/agent-summary.* .
 *
 * Usage:
 *   node score-arms.mjs --task H1 --arms control,codegraph,graphcode-native \
 *     [--model sonnet-4.6] [--runs 1] [--eval <hadoop-mcp-eval root>]
 *
 * Reads <eval>/outputs/agent-runs/<model>/<task>/<arm>/r<N>.jsonl and the task
 * definition from <eval>/tasks/tasks.yaml. Prints a per-arm table + JSON.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractFinalAnswer, extractToolTrace, readJsonl } from "../../../codegraph/hadoop-mcp-eval/scripts/lib/trace-parse.mjs";

// ── exact metric logic copied from score-runs.mjs (keep byte-faithful) ──────────
function normalizeText(text) {
  return (text || "").toLowerCase();
}
function mentionsSymbol(answer, symbol) {
  return normalizeText(answer).includes(symbol.toLowerCase());
}
function mentionsFile(answer, filePath) {
  const lower = normalizeText(answer);
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const base = normalized.split("/").pop();
  return lower.includes(normalized) || (base && lower.includes(base));
}
function scoreEdge(answer, edge) {
  const lower = normalizeText(answer);
  const from = edge.from.toLowerCase();
  const to = edge.to.toLowerCase();
  if (!lower.includes(from) || !lower.includes(to)) return false;
  const fromIdx = lower.indexOf(from);
  const toIdx = lower.indexOf(to);
  const distance = Math.abs(fromIdx - toIdx);
  if (distance > 1200) return false;
  const window = lower.slice(
    Math.min(fromIdx, toIdx),
    Math.max(fromIdx, toIdx) + Math.max(from.length, to.length) + 200,
  );
  const relationHints = [
    "->", "→", "to ", "calls", "delegat", "handoff", "creates", "starts", "uses",
    "via", "through", "forwards", "submits", "dispatches", "extends", "implements",
    "builds", "launches", "wires", "informs", "enqueues", "reports", "removes",
    "process", "handle", "run(",
  ];
  return relationHints.some((hint) => window.includes(hint));
}
function scoreDta(answer, task) {
  const edges = task?.expected_edges_seed || [];
  const total = task?.scoring?.dta_edges_total ?? edges.length;
  if (!edges.length || total === 0) return { dta: null, correct: 0, total: 0, eligible: false };
  if (task.verification_status !== "verified" && task.verification_status !== "partial")
    return { dta: null, correct: 0, total, eligible: false };
  let correct = 0;
  for (const edge of edges) if (scoreEdge(answer, edge)) correct += 1;
  return { dta: total > 0 ? correct / total : null, correct, total, eligible: true };
}
function scoreCfrd(answer, task) {
  const expectedDepth = task?.scoring?.expected_cross_file_depth ?? 0;
  const files = task?.expected_files || [];
  if (!expectedDepth || !files.length) return { cfrd: null, eligible: false };
  const mentioned = files.filter((f) => mentionsFile(answer, f));
  const depth = Math.min(mentioned.length, expectedDepth);
  return { cfrd: expectedDepth > 0 ? Math.min(depth / expectedDepth, 1) : null, eligible: true };
}
function scoreQuality(answer, task, dta, anchorsFound) {
  const anchors = task?.expected_anchors || [];
  const anchorRatio = anchors.length ? anchorsFound / anchors.length : 0;
  if (!answer || !answer.trim()) return 0;
  if (anchorRatio === 0) return 0;
  if (anchorRatio < 0.5) return 1;
  const dtaVal = dta.dta ?? 0;
  if (anchorRatio >= 0.75 && dtaVal >= 0.67) return 3;
  if (anchorRatio >= 0.5 && dtaVal >= 0.33) return 2;
  return 1;
}

function loadYaml(path) {
  const script = "import json,yaml,sys\nprint(json.dumps(yaml.safe_load(open(sys.argv[1]))))";
  const out = spawnSync("python3", ["-c", script, path], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) throw new Error(`yaml load failed: ${out.stderr}`);
  return JSON.parse(out.stdout);
}

function parseArgs(argv) {
  const o = { task: "H1", arms: "control,codegraph,graphcode-native", model: "sonnet-4.6", runs: 1, eval: "/Users/eric/Documents/codegraph/hadoop-mcp-eval", tasksFile: "tasks/tasks.yaml" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--task") o.task = argv[++i];
    else if (a === "--arms") o.arms = argv[++i];
    else if (a === "--model") o.model = argv[++i];
    else if (a === "--runs") o.runs = Number(argv[++i]);
    else if (a === "--eval") o.eval = argv[++i];
    else if (a === "--tasks-file") o.tasksFile = argv[++i];
  }
  return o;
}

function runComplete(records) {
  return [...records].reverse().find((r) => r.type === "run_complete") || {};
}

// Cost/token signal. Claude arms carry Anthropic usage (output_tokens,
// cache_read_input_tokens) + cost_usd. The pi/civitas native arm carries
// {output, cacheRead} and cost 0 (gateway). Normalize both to {output, cacheRead, costUsd}.
function extractCost(records) {
  const rc = runComplete(records);
  const u = rc.usage || {};
  const output = u.output_tokens ?? u.output ?? null;
  const cacheRead = u.cache_read_input_tokens ?? u.cacheRead ?? null;
  const costUsd = rc.costUsd ?? rc.cost_usd ?? null;
  return { output, cacheRead, costUsd };
}

// ── impact-task scoring (from score-impact-runs.mjs) — recall@k + precision ──────
function recallAt(answer, goldFiles, k) {
  const top = goldFiles.slice(0, k);
  if (top.length === 0) return null;
  const hit = top.filter((f) => mentionsFile(answer, f)).length;
  return hit / top.length;
}
function namedDependents(answer) {
  const m = (answer || "").match(/```json\s*([\s\S]*?)```/i);
  let obj = null;
  if (m) { try { obj = JSON.parse(m[1]); } catch { /* malformed */ } }
  const files = (obj?.dependent_files || []).map((f) => String(f));
  const classes = (obj?.dependent_classes || []).map((c) => String(c));
  return { files, classes };
}
function baseKey(s) {
  return String(s).replace(/\\/g, "/").split("/").pop().toLowerCase().replace(/\.java$/, "");
}
function precisionAgainstUniverse(answer, fullCallerFiles) {
  const { files, classes } = namedDependents(answer);
  const named = new Set([...files, ...classes].map(baseKey).filter(Boolean));
  if (named.size === 0) return { precision: null, validNamed: 0, totalNamed: 0 };
  const universe = new Set(fullCallerFiles.map(baseKey));
  let valid = 0;
  for (const n of named) if (universe.has(n)) valid++;
  return { precision: valid / named.size, validNamed: valid, totalNamed: named.size };
}

function scoreImpactRun(records, task) {
  const answer = extractFinalAnswer(records) || "";
  const gold = task.expected_caller_files || [];
  const prec = precisionAgainstUniverse(answer, gold);
  return {
    recall10: recallAt(answer, gold, 10),
    recall20: recallAt(answer, gold, 20),
    precision: prec.precision,
    valid_named: prec.validNamed,
    total_named: prec.totalNamed,
    gold_count: gold.length,
  };
}

function scoreRun(jsonlPath, task) {
  if (!existsSync(jsonlPath)) return null;
  const records = readJsonl(jsonlPath);
  const trace = extractToolTrace(records);
  const answer = extractFinalAnswer(records) || "";
  const cost = extractCost(records);
  const impact = task.category === "impact" ? scoreImpactRun(records, task) : null;
  const anchors = task?.expected_anchors || [];
  const anchorsFound = anchors.filter((a) => mentionsSymbol(answer, a)).length;
  const dta = scoreDta(answer, task);
  const cfrd = scoreCfrd(answer, task);
  const quality = scoreQuality(answer, task, dta, anchorsFound);
  const graphCalls = Object.entries(trace.tool_counts)
    .filter(([n]) => n.toLowerCase().includes("codegraph") || n.toLowerCase().startsWith("mcp_"))
    .reduce((s, [, c]) => s + c, 0);
  return {
    quality,
    anchors_found: anchorsFound,
    anchors_total: anchors.length,
    dta: dta.dta,
    dta_correct: dta.correct,
    dta_total: dta.total,
    cfrd: cfrd.cfrd,
    read: trace.read_count,
    grep: trace.grep_count,
    graph_calls: graphCalls,
    tool_counts: trace.tool_counts,
    answer_chars: answer.length,
    out_tokens: cost.output,
    cache_read: cost.cacheRead,
    cost_usd: cost.costUsd,
    impact,
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tasksDoc = loadYaml(join(opts.eval, opts.tasksFile));
  const task = (tasksDoc.tasks || []).find((t) => t.id === opts.task);
  if (!task) throw new Error(`task ${opts.task} not found`);
  const arms = opts.arms.split(",").map((s) => s.trim());

  const report = { task: opts.task, model: opts.model, arms: {} };
  for (const arm of arms) {
    const runs = [];
    for (let r = 1; r <= opts.runs; r++) {
      const p = join(opts.eval, "outputs", "agent-runs", opts.model, opts.task, arm, `r${r}.jsonl`);
      const scored = scoreRun(p, task);
      if (scored) runs.push(scored);
    }
    report.arms[arm] = { runs: runs.length, detail: runs };
  }

  // table
  const med = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] : null);
  const isImpact = task.category === "impact";
  console.log(`\nTask ${opts.task} — ${task.title} (${task.category}) | model ${opts.model}\n`);
  if (isImpact) {
    console.log(
      "arm".padEnd(20), "recall@10", "recall@20", "prec", "valid/named", "graph", "read", "grep", "outTok", "cacheRead", "costUSD",
    );
    for (const arm of arms) {
      const rs = report.arms[arm].detail;
      if (!rs.length) { console.log(arm.padEnd(20), "(no runs)"); continue; }
      const r10 = rs.map((r) => r.impact?.recall10).filter((x) => x != null);
      const r20 = rs.map((r) => r.impact?.recall20).filter((x) => x != null);
      const pr = rs.map((r) => r.impact?.precision).filter((x) => x != null);
      const vn = `${med(rs.map((r) => r.impact?.valid_named ?? 0))}/${med(rs.map((r) => r.impact?.total_named ?? 0))}`;
      const g = med(rs.map((r) => r.graph_calls));
      const rd = med(rs.map((r) => r.read));
      const gp = med(rs.map((r) => r.grep));
      const ot = rs.map((r) => r.out_tokens).filter((x) => x != null);
      const cr = rs.map((r) => r.cache_read).filter((x) => x != null);
      const cu = rs.map((r) => r.cost_usd).filter((x) => x != null);
      console.log(
        arm.padEnd(20),
        (r10.length ? med(r10).toFixed(2) : "—").padEnd(9),
        (r20.length ? med(r20).toFixed(2) : "—").padEnd(9),
        (pr.length ? med(pr).toFixed(2) : "—").padEnd(4),
        vn.padEnd(11),
        String(g).padEnd(5),
        String(rd).padEnd(4),
        String(gp).padEnd(4),
        (ot.length ? String(med(ot)) : "—").padEnd(6),
        (cr.length ? String(med(cr)) : "—").padEnd(9),
        cu.length ? med(cu).toFixed(3) : "—",
      );
    }
    console.log("\n" + JSON.stringify(report, null, 2));
    return;
  }
  console.log(
    "arm".padEnd(20), "qual", "anch", "DTA", "CFRD", "graph", "read", "grep", "outTok", "cacheRead", "costUSD",
  );
  for (const arm of arms) {
    const rs = report.arms[arm].detail;
    if (!rs.length) { console.log(arm.padEnd(20), "(no runs)"); continue; }
    const q = med(rs.map((r) => r.quality));
    const an = `${med(rs.map((r) => r.anchors_found))}/${rs[0].anchors_total}`;
    const dta = rs.map((r) => r.dta).filter((x) => x != null);
    const cfrd = rs.map((r) => r.cfrd).filter((x) => x != null);
    const g = med(rs.map((r) => r.graph_calls));
    const rd = med(rs.map((r) => r.read));
    const gp = med(rs.map((r) => r.grep));
    const ot = rs.map((r) => r.out_tokens).filter((x) => x != null);
    const cr = rs.map((r) => r.cache_read).filter((x) => x != null);
    const cu = rs.map((r) => r.cost_usd).filter((x) => x != null);
    console.log(
      arm.padEnd(20),
      String(q).padEnd(4),
      an.padEnd(4),
      (dta.length ? med(dta).toFixed(2) : "—").padEnd(4),
      (cfrd.length ? med(cfrd).toFixed(2) : "—").padEnd(4),
      String(g).padEnd(5),
      String(rd).padEnd(4),
      String(gp).padEnd(4),
      (ot.length ? String(med(ot)) : "—").padEnd(6),
      (cr.length ? String(med(cr)) : "—").padEnd(9),
      cu.length ? med(cu).toFixed(3) : "—",
    );
  }
  console.log("\n" + JSON.stringify(report, null, 2));
}

main();
