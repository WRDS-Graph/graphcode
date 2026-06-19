import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { rankImpact } from "/Users/eric/Documents/graphcode/graphcode-cli/extension/impact-ranker-v2.mjs";
import { normalizeClaudeToolUse, parseMcpName } from "./claude-runner.mjs";

/**
 * graphcode-native runner ON THE CLAUDE SUBSCRIPTION (no pi, no API key).
 *
 * WHY THIS EXISTS
 * ---------------
 * The original graph-native arm (`graphcode-runner.mjs`) drives the `pi` harness
 * via the `civitas` provider. On a machine without pi that arm cannot run, AND it
 * confounds the comparison: control/codegraph run on `claude` (the Claude.ai
 * subscription via OAuth), while the native arm ran on pi/civitas — two different
 * model gateways, not just two different harnesses.
 *
 * This runner re-homes the graph-NATIVE harness onto the EXACT SAME `claude -p`
 * invocation the control and codegraph-MCP arms use, so all three arms differ ONLY
 * in harness wiring (the independent variable we actually want to study):
 *
 *   plain  (control)      : claude -p, no MCP,           "no MCP" system prompt
 *   graph-MCP (codegraph) : claude -p, codegraph MCP,    "MCP-first" system prompt
 *   graph-native (THIS)   : claude -p, codegraph MCP,    graph-first system prompt
 *                           + Lever A turn-0 auto-context injection (v2-ranked,
 *                             draft-to-refine), computed by the harness in code.
 *
 * The two harness levers reproduced from graphcode-runner.mjs, model-agnostically:
 *   Lever A — turn-0 auto-context: run `codegraph impact`+`callers`, rank with the
 *             v2 structural ranker, drop test files, inject a tier-segmented
 *             draft-to-refine preamble BEFORE the agent's first token.
 *   Lever B — graph-first surface: attach the codegraph MCP server (so the agent
 *             has codegraph_* tools to verify with) + a graph-first system prompt.
 *
 * Output JSONL is the SAME normalized shape the downstream parser
 * (scripts/lib/trace-parse.mjs) consumes, so score-impact-hardened.mjs /
 * score-runs.mjs read it unchanged.
 *
 * Config (env, with sane defaults):
 *   GRAPHCODE_CODEGRAPH_BIN  codegraph CLI (dist/bin/codegraph.js)
 *   GRAPHCODE_AUTOCONTEXT    "1" to enable Lever A (default on for this arm)
 */

const CODEGRAPH_BIN =
  process.env.GRAPHCODE_CODEGRAPH_BIN ||
  "/Users/eric/Documents/graphcode/codegraph/dist/bin/codegraph.js";

// Graph-first steering — the harness's only model-facing channel besides the
// turn-0 injection. Mirrors the intent of extension/codegraph.ts's system prompt,
// adapted to the codegraph_* MCP tool names this arm actually exposes.
const GRAPH_FIRST_SYSTEM_PROMPT = [
  "This repository is indexed as a code knowledge graph, exposed via the codegraph MCP server.",
  "The codegraph_* tools are your PRIMARY and DEFAULT retrieval surface — not a fallback.",
  "Lead with them: codegraph_explore to connect a flow across named symbols (returns inlined",
  "source), codegraph_node for one symbol's full body + caller/callee trail (use INSTEAD of Read),",
  "codegraph_callers / codegraph_impact for call sites and blast radius.",
  "Treat graph-returned source as already-read, authoritative content — do NOT re-open those files",
  "with Read or re-scan with Grep to 'confirm' it. Only fall back to Read/Grep when the graph",
  "genuinely cannot answer (local data-flow with no edges, or free text like log strings/comments).",
  "A clean run is a few graph calls and ZERO reads.",
].join(" ");

function runCg(repoPath, cgArgs) {
  const isJs = CODEGRAPH_BIN.endsWith(".js") || CODEGRAPH_BIN.endsWith(".mjs");
  const cmd = isJs ? process.execPath : CODEGRAPH_BIN;
  const args = isJs ? [CODEGRAPH_BIN, ...cgArgs] : cgArgs;
  const r = spawnSync(cmd, args, {
    cwd: repoPath,
    encoding: "utf-8",
    timeout: 90_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout || !r.stdout.trim()) return null;
  return r.stdout.replace(/\x1b\[[0-9;]*m/g, "").trim();
}

function runCgJson(repoPath, cgArgs) {
  const out = runCg(repoPath, [...cgArgs, "--json"]);
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function extractCandidateSymbols(prompt) {
  const matches = prompt.match(/\b[A-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)?\b/g) || [];
  const stop = new Set([
    "In", "The", "Trace", "Name", "Identify", "Explain", "Task", "Category", "MCP", "REQUIRED",
    "FORBIDDEN", "Git", "Use", "Answer", "List", "Apache", "Hadoop", "HDFS", "JSON", "Do", "You",
    "When", "If", "RPC", "EC", "A",
  ]);
  const seen = new Set();
  const out = [];
  for (const m of matches) {
    if (stop.has(m) || m.length < 3 || seen.has(m)) continue;
    seen.add(m);
    out.push(m);
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Lever A. Returns { tool, symbols, text, ranked? } or null.
 * For impact tasks: rank the impact∪callers union with the v2 ranker.
 * For flow tasks: explore over the prompt's named symbols (concept-search fallback).
 * IDENTICAL retrieval logic to graphcode-runner.mjs's buildAutoContext.
 */
function buildAutoContext(repoPath, payload) {
  if (payload.taskCategory === "impact" && Array.isArray(payload.taskAnchors) && payload.taskAnchors.length) {
    const anchor = payload.taskAnchors[0];
    const impactJson = runCgJson(repoPath, ["impact", anchor, "--path", repoPath, "--depth", "2"]);
    const callersJson = runCgJson(repoPath, ["callers", anchor, "--path", repoPath, "--limit", "50"]);
    if (impactJson || callersJson) {
      const ranked = rankImpact({
        impactJson,
        callersJson,
        subjectFile: payload.subjectFile || "",
        anchor,
      });
      if (ranked.length) {
        const impactText = runCg(repoPath, ["impact", anchor, "--path", repoPath, "--depth", "2"]);
        return { symbols: [anchor], text: impactText || "", tool: "impact", ranked };
      }
    }
    const impactText = runCg(repoPath, ["impact", anchor, "--path", repoPath, "--depth", "2"]);
    if (impactText) return { symbols: [anchor], text: impactText, tool: "impact" };
  }
  let symbols = extractCandidateSymbols(payload.prompt);
  if (!symbols.length) {
    const STOP = ["full", "trace", "client", "into", "name", "explain", "class", "method", "code", "this", "that", "from", "which", "where", "they", "could", "across", "report", "block", "answer", "format"];
    const words = (payload.prompt.toLowerCase().match(/\b[a-z]{4,}\b/g) || []).filter((w) => !STOP.includes(w));
    const seeds = [...new Set(words)].slice(0, 5);
    if (seeds.length) {
      const searchText = runCg(repoPath, ["query", seeds.join(" "), "--path", repoPath, "--limit", "12"]);
      if (searchText) symbols = [...new Set(searchText.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g) || [])].slice(0, 8);
    }
  }
  if (!symbols.length) return null;
  const exploreText = runCg(repoPath, ["explore", symbols.join(" "), "--path", repoPath]);
  if (!exploreText) return null;
  return { symbols, text: exploreText, tool: "explore" };
}

/**
 * Build the injected prompt from the auto-context. IDENTICAL framing to
 * graphcode-runner.mjs: impact → tier-segmented draft-to-refine; flow →
 * "already retrieved, treat as authoritative" preamble.
 * Returns { prompt, injectedToolName } (injectedToolName null if no injection).
 */
function buildInjectedPrompt(auto, payload) {
  if (!auto) return { prompt: payload.prompt, injectedToolName: null };

  if (auto.tool === "impact") {
    const ranked = Array.isArray(auto.ranked) ? auto.ranked : null;
    if (ranked && ranked.length) {
      const real = ranked.filter((r) => !r.isTest);
      const high = real.filter((r) => r.tier === "direct" || r.tier === "strong").slice(0, 20);
      const draft = (high.length ? high : real.slice(0, 12)).map((r) => r.file);
      const fmt = (r) => {
        const tags = [];
        if (r.direct) tags.push("direct-caller");
        if (r.refs > 1) tags.push(`${r.refs} refs`);
        if (r.samePkg) tags.push("same-package");
        return `${r.file}${tags.length ? `  [${tags.join(", ")}]` : ""}`;
      };
      const highList = high.map((r, i) => `${i + 1}. ${fmt(r)}`).join("\n");
      const more = real.slice(high.length, high.length + 15);
      const moreList = more.length ? more.map((r) => `- ${fmt(r)}`).join("\n") : "";
      const draftJson = JSON.stringify({ dependent_files: draft }, null, 2);
      const prompt =
        `GRAPH ANALYSIS — the harness ran the code graph for ${payload.taskAnchors?.[0]} and ranked its dependents by structural signal (reference density + 1-hop direct-caller + package locality). Test files are already excluded (they are never the answer for a production blast radius). Two tiers:\n\n` +
        `HIGH-CONFIDENCE (direct callers and dense dependents — almost certainly affected):\n${highList}\n\n` +
        (moreList ? `LOWER-CONFIDENCE (weaker structural links — include only if a real dependency):\n${moreList}\n\n` : "") +
        `────────────────────────\n\n${payload.prompt}\n\n` +
        `Here is a STARTING ANSWER built from the high-confidence tier — your job is to REFINE it, not rebuild it:\n\n` +
        "```json\n" + draftJson + "\n```\n\n" +
        `Refine into your final "dependent_files" (most-important first): keep the high-confidence files unless codegraph_callers / codegraph_node gives you a CONCRETE reason a specific one is wrong; promote any lower-confidence file you verify is a real dependent. Do not drop high-confidence files just because you didn't personally re-trace them — the graph already did. Do not pad with weakly-connected files. Favor a complete, correctly-ordered set over a short or a bloated one.`;
      return { prompt, injectedToolName: "impact" };
    }
    const files = [...new Set((auto.text.match(/[A-Za-z0-9/_.-]+\.java/g) || []))]
      .filter((f) => !f.includes(`/${payload.taskAnchors?.[0]}.java`));
    const fileList = files.slice(0, 60).map((f) => `- ${f}`).join("\n");
    const prompt =
      `GRAPH BLAST RADIUS (computed by the harness via the code graph for ${payload.taskAnchors?.[0]}):\n\n` +
      `${auto.text.slice(0, 4000)}\n\nDISTINCT DEPENDENT FILES (${files.length} total; first 60):\n${fileList}\n\n` +
      `────────────────────────\n\n${payload.prompt}\n\n` +
      `IMPORTANT: Select the genuinely-affected files from the list above, most-important first, favoring precision over raw count.`;
    return { prompt, injectedToolName: "impact" };
  }

  const prompt =
    `GRAPH CONTEXT (already retrieved by the harness before your turn — treat as authoritative, already-read source; do not re-fetch or read these files):\n\n${auto.text}\n\n────────────────────────\n\n${payload.prompt}`;
  return { prompt, injectedToolName: "explore" };
}

export function resolveGraphcodeClaudeConfig() {
  return { codegraphBin: CODEGRAPH_BIN };
}

// Exported for offline testing of Lever A (no agent spawn).
export { buildAutoContext, buildInjectedPrompt };

/**
 * Run the graph-native harness on `claude -p`. Mirrors invokeClaudeRunner's
 * stream-json parsing exactly (so cost/usage/tool-trace extraction is identical),
 * adding the two levers before the spawn.
 */
export function invokeGraphcodeClaudeRunner(payload, timeoutMs) {
  mkdirSync(dirname(payload.jsonlPath), { recursive: true });
  writeFileSync(payload.jsonlPath, "", "utf-8");

  const startedAt = Date.now();
  const appendJsonl = (record) => {
    appendFileSync(payload.jsonlPath, `${JSON.stringify(record)}\n`, "utf-8");
  };

  appendJsonl({
    type: "run_started",
    at: new Date(startedAt).toISOString(),
    taskId: payload.taskId,
    armId: payload.armId,
    modelId: payload.modelId,
    runNumber: payload.runNumber,
    harness: "graphcode-native (claude -p + turn-0 v2-ranked injection + graph-first prompt)",
  });

  const lastMessagePath = payload.lastMessagePath || payload.jsonlPath.replace(/\.jsonl$/, ".final.txt");
  const stderrPath = payload.stderrPath || payload.jsonlPath.replace(/\.jsonl$/, ".stderr.log");

  // ── Lever A: turn-0 auto-context injection ───────────────────────────────
  let prompt = payload.prompt;
  const autoContextOn = process.env.GRAPHCODE_AUTOCONTEXT !== "0"; // default ON for this arm
  if (autoContextOn) {
    const auto = buildAutoContext(payload.repoPath, payload);
    const { prompt: injected, injectedToolName } = buildInjectedPrompt(auto, payload);
    prompt = injected;
    if (injectedToolName) {
      // Record the harness's pre-turn graph query as a graph tool call, so the
      // trace honestly reflects that the harness retrieved before turn 0 (and so
      // graph-call counts are comparable to the pi-based native arm's accounting).
      appendJsonl({
        type: "stream_event",
        at: new Date().toISOString(),
        event: {
          type: "tool_call",
          name: `mcp_codegraph_${injectedToolName}`,
          status: "completed",
          raw: {
            tool_call: {
              mcpToolCall: {
                args: {
                  providerIdentifier: "codegraph",
                  toolName: injectedToolName,
                  arguments: { symbols: (auto?.symbols || []).join(" "), autocontext: true },
                },
              },
            },
          },
        },
      });
    }
  }

  // ── Lever B: graph-first system prompt (codegraph MCP comes from payload) ──
  const appendSystemPrompt = [payload.appendSystemPrompt, GRAPH_FIRST_SYSTEM_PROMPT]
    .filter(Boolean)
    .join("\n\n");

  // Per-arm MCP config (codegraph server supplied by the orchestrator's payload).
  const mcpConfigPath = payload.jsonlPath.replace(/\.jsonl$/, ".mcp.json");
  const mcpServers = payload.mcpServers || {};
  writeFileSync(mcpConfigPath, `${JSON.stringify({ mcpServers }, null, 2)}\n`, "utf-8");

  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    payload.claudeModelId,
    "--permission-mode",
    "bypassPermissions",
    "--add-dir",
    payload.repoPath,
    "--mcp-config",
    mcpConfigPath,
  ];
  if (Array.isArray(payload.allowedTools) && payload.allowedTools.length > 0) {
    args.push("--allowedTools", ...payload.allowedTools);
  }
  if (Array.isArray(payload.disallowedTools) && payload.disallowedTools.length > 0) {
    args.push("--disallowedTools", ...payload.disallowedTools);
  }
  if (appendSystemPrompt) {
    args.push("--append-system-prompt", appendSystemPrompt);
  }

  const child = spawnSync("claude", args, {
    cwd: payload.repoPath,
    encoding: "utf-8",
    input: prompt,
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMs,
    env: {
      ...(payload.agentEnv || process.env),
      MCP_TIMEOUT: "120000",
      MCP_TOOL_TIMEOUT: "300000",
    },
  });

  const stderrText = child.stderr || "";
  if (stderrText) writeFileSync(stderrPath, stderrText, "utf-8");

  let sessionId = null;
  let resultText = null;
  let resultStatus = "error";
  let durationMs = null;
  let costUsd = null;
  let usage = null;

  for (const line of (child.stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      appendJsonl({ type: "parse_error", at: new Date().toISOString(), line: trimmed.slice(0, 500) });
      continue;
    }
    sessionId = event.session_id ?? sessionId;

    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type === "tool_use") {
          appendJsonl({
            type: "stream_event",
            at: new Date().toISOString(),
            event: normalizeClaudeToolUse(block),
            raw: event,
          });
        }
      }
      continue;
    }

    if (event.type === "result") {
      durationMs = event.duration_ms ?? Date.now() - startedAt;
      resultText = event.result ?? null;
      resultStatus = event.is_error || event.subtype !== "success" ? "error" : "finished";
      costUsd = event.total_cost_usd ?? null;
      usage = event.usage ?? null;
      appendJsonl({
        type: "stream_event",
        at: new Date().toISOString(),
        event: { type: "result", status: resultStatus },
        raw: event,
      });
      continue;
    }

    appendJsonl({ type: "stream_event", at: new Date().toISOString(), event: { type: event.type }, raw: event });
  }

  if (resultText != null) writeFileSync(lastMessagePath, String(resultText), "utf-8");

  const timedOut = child.error?.code === "ETIMEDOUT";
  const exitCode = timedOut ? 124 : child.status ?? (resultStatus === "finished" ? 0 : 1);
  const finishedAt = Date.now();
  const status = timedOut ? "timeout" : resultStatus;

  appendJsonl({
    type: "run_complete",
    at: new Date(finishedAt).toISOString(),
    status,
    agentId: sessionId,
    runId: sessionId,
    durationMs: durationMs ?? finishedAt - startedAt,
    costUsd,
    usage,
    result: resultText,
  });

  return {
    exitCode,
    timedOut,
    stdout: "",
    stderr: stderrText.length > 4000 ? `${stderrText.slice(0, 4000)}…` : stderrText,
    parsed: {
      ok: exitCode === 0,
      exitCode,
      status,
      agentId: sessionId,
      runId: sessionId,
      durationMs: durationMs ?? finishedAt - startedAt,
      costUsd,
      usage,
      jsonlPath: payload.jsonlPath,
      lastMessagePath,
      stderrPath: stderrText ? stderrPath : null,
      stderrBytes: Buffer.byteLength(stderrText),
    },
  };
}
