import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { rankImpact } from "/Users/eric/Documents/graphcode/graphcode-cli/extension/impact-ranker-v2.mjs";

/**
 * graphcode-native runner for the Hadoop MCP eval harness.
 *
 * This is the GRAPH-NATIVE arm: instead of "Claude Code + codegraph MCP", it
 * runs the pi coding-agent harness with the graphcode extension, which makes the
 * code graph the agent's PRIMARY retrieval surface (graph-first system prompt +
 * graph_* tools that shell the codegraph CLI). The research question is whether a
 * graph-native HARNESS beats a general agent with a graph bolted on via MCP.
 *
 * Fairness: same fixed model (sonnet-4.6), same task prompt + answer contract,
 * same repo, same read-only posture as the claude runner. The ONLY difference is
 * the harness. We emit the SAME normalized JSONL the downstream parser
 * (scripts/lib/trace-parse.mjs) consumes, so scoring is runner-agnostic:
 *
 *   pi tool            -> normalized name (parser contract)
 *   graph_explore      -> mcp_codegraph_explore   (counts as graph/MCP usage)
 *   graph_search       -> mcp_codegraph_search
 *   graph_callers      -> mcp_codegraph_callers
 *   graph_callees      -> mcp_codegraph_callees
 *   graph_impact       -> mcp_codegraph_impact
 *   read               -> Read
 *   grep               -> Grep
 *   bash               -> Shell
 *
 * Config comes from the environment (set by run-flow-agent.mjs's graphcode path):
 *   GRAPHCODE_PI_DIR        pi monorepo checkout (has node_modules/.bin/tsx + cli.ts)
 *   GRAPHCODE_CODEGRAPH_BIN codegraph CLI (the v1.0.1 dist that has `explore`)
 *   GRAPHCODE_EXTENSION     path to extension/codegraph.ts
 *   GRAPHCODE_PROVIDER      pi provider (default civitas)
 */

const GRAPH_TOOL_MAP = {
  graph_explore: "mcp_codegraph_explore",
  graph_node: "mcp_codegraph_node",
  graph_search: "mcp_codegraph_search",
  graph_callers: "mcp_codegraph_callers",
  graph_callees: "mcp_codegraph_callees",
  graph_impact: "mcp_codegraph_impact",
};

export function resolveGraphcodeConfig() {
  const piDir = process.env.GRAPHCODE_PI_DIR || "/tmp/graphcode_clone";
  const tsx = join(piDir, "node_modules", ".bin", "tsx");
  const piCli = join(piDir, "packages", "coding-agent", "src", "cli.ts");
  const piTsconfig = join(piDir, "tsconfig.json");
  const codegraphBin =
    process.env.GRAPHCODE_CODEGRAPH_BIN ||
    "/Users/eric/Documents/graphcode/codegraph/dist/bin/codegraph.js";
  const extension =
    process.env.GRAPHCODE_EXTENSION ||
    "/Users/eric/Documents/graphcode/graphcode-cli/extension/codegraph.ts";
  const provider = process.env.GRAPHCODE_PROVIDER || "civitas";
  return { piDir, tsx, piCli, piTsconfig, codegraphBin, extension, provider };
}

/**
 * Map one pi tool name to the parser's normalized name + the raw tool_call shape
 * that trace-parse.mjs reads for read paths / grep patterns / mcp args.
 */
function normalizePiTool(toolName, args) {
  const graphName = GRAPH_TOOL_MAP[toolName];
  if (graphName) {
    return {
      name: graphName,
      raw: {
        tool_call: {
          mcpToolCall: {
            args: {
              providerIdentifier: "codegraph",
              toolName: graphName.replace("mcp_codegraph_", ""),
              arguments: args || {},
            },
          },
        },
      },
    };
  }
  if (toolName === "read") {
    return {
      name: "Read",
      raw: { tool_call: { readToolCall: { args: { path: args?.path ?? args?.file_path ?? null } } } },
    };
  }
  if (toolName === "grep") {
    return {
      name: "Grep",
      raw: { tool_call: { grepToolCall: { args: { pattern: args?.pattern ?? args?.query ?? null } } } },
    };
  }
  if (toolName === "glob" || toolName === "find") {
    return { name: "Glob", raw: { tool_call: { globToolCall: { args: { pattern: args?.pattern ?? null } } } } };
  }
  if (toolName === "bash") {
    return { name: "Shell", raw: { tool_call: { shellToolCall: { args: { command: args?.command ?? null } } } } };
  }
  // Other pi tools (ls, list, etc.) — keep the name; parser ignores unknowns for counts.
  return { name: toolName, raw: { tool_call: { otherToolCall: { args: args || {} } } } };
}

/**
 * Lever A — auto-context injection (graph-first turn-0).
 *
 * The defining move of a graph-NATIVE harness: do graph retrieval BEFORE the
 * agent's first turn, so the agent starts with the flow already in context
 * instead of spending turns hunting for entry points. We pull candidate symbol
 * names out of the task prompt (CamelCase / Capitalized identifiers — the way
 * tasks name classes/methods), run `codegraph explore` on them, and hand the
 * agent the result as a preamble it can build on.
 *
 * Gated by GRAPHCODE_AUTOCONTEXT=1 so it can be A/B'd against the no-injection
 * harness on the same eval.
 */
function extractCandidateSymbols(prompt) {
  // CamelCase / PascalCase identifiers and dotted Class.method names. These are
  // how flow/impact tasks name the code (DFSClient, DFSOutputStream, newStreamForCreate).
  const matches = prompt.match(/\b[A-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)?\b/g) || [];
  const stop = new Set([
    "In", "The", "Trace", "Name", "Identify", "Explain", "Task", "Category", "MCP", "REQUIRED",
    "FORBIDDEN", "Git", "Use", "Answer", "List", "Apache", "Hadoop", "HDFS", "JSON", "Do", "You",
    "When", "If", "RPC", "EC", "A",
  ]);
  const seen = new Set();
  const out = [];
  for (const m of matches) {
    if (stop.has(m)) continue;
    if (m.length < 3) continue;
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
    if (out.length >= 8) break;
  }
  return out;
}

function runCg(cfg, repoPath, cgArgs) {
  const isJs = cfg.codegraphBin.endsWith(".js") || cfg.codegraphBin.endsWith(".mjs");
  const cmd = isJs ? process.execPath : cfg.codegraphBin;
  const args = isJs ? [cfg.codegraphBin, ...cgArgs] : cgArgs;
  const r = spawnSync(cmd, args, { cwd: repoPath, encoding: "utf-8", timeout: 90_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout || !r.stdout.trim()) return null;
  return r.stdout.replace(/\x1b\[[0-9;]*m/g, "").trim();
}

/** Run a codegraph subcommand with --json and parse it (null on failure). */
function runCgJson(cfg, repoPath, cgArgs) {
  const out = runCg(cfg, repoPath, [...cgArgs, "--json"]);
  if (!out) return null;
  try { return JSON.parse(out); } catch { return null; }
}

function buildAutoContext(cfg, repoPath, payload) {
  const prompt = payload.prompt;
  if (payload.taskCategory === "impact" && Array.isArray(payload.taskAnchors) && payload.taskAnchors.length) {
    const anchor = payload.taskAnchors[0];
    // GRAPH-NATIVE RANKING (not a firehose paste). Raw `impact` has recall ~1.0 but
    // precision ~0.06 — its file-order top-N is mediocre. We rank candidates by graph
    // signal (reference density + direct-caller + package locality) so the budgeted
    // shortlist is mostly TRUE dependents. Validated held-out: F1 0.38 vs 0.18 raw.
    const impactJson = runCgJson(cfg, repoPath, ["impact", anchor, "--path", repoPath, "--depth", "2"]);
    const callersJson = runCgJson(cfg, repoPath, ["callers", anchor, "--path", repoPath, "--limit", "50"]);
    if (impactJson || callersJson) {
      const ranked = rankImpact({
        impactJson, callersJson,
        subjectFile: payload.subjectFile || "",
        anchor,
      });
      if (ranked.length) {
        const impactText = runCg(cfg, repoPath, ["impact", anchor, "--path", repoPath, "--depth", "2"]);
        return { symbols: [anchor], text: impactText || "", tool: "impact", ranked };
      }
    }
    // Fallback to raw text if JSON path unavailable (older codegraph).
    const impactText = runCg(cfg, repoPath, ["impact", anchor, "--path", repoPath, "--depth", "2"]);
    if (impactText) return { symbols: [anchor], text: impactText, tool: "impact" };
  }
  let symbols = extractCandidateSymbols(prompt);
  if (!symbols.length) {
    const STOP = ["full","trace","client","into","name","explain","class","method","code","this","that","from","which","where","they","could","across","report","block","answer","format"];
    const words = (prompt.toLowerCase().match(/\b[a-z]{4,}\b/g) || []).filter((w) => !STOP.includes(w));
    const seeds = [...new Set(words)].slice(0, 5);
    if (seeds.length) {
      const searchText = runCg(cfg, repoPath, ["query", seeds.join(" "), "--path", repoPath, "--limit", "12"]);
      if (searchText) symbols = [...new Set(searchText.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g) || [])].slice(0, 8);
    }
  }
  if (!symbols.length) return null;
  const exploreText = runCg(cfg, repoPath, ["explore", symbols.join(" "), "--path", repoPath]);
  if (!exploreText) return null;
  return { symbols, text: exploreText, tool: "explore" };
}

/**
 * Run the pi graph-native harness headlessly and re-emit a normalized JSONL
 * transcript compatible with scripts/lib/trace-parse.mjs.
 *
 * `payload` shape mirrors what claude-runner consumes:
 *   { taskId, armId, modelId, runNumber, claudeModelId, prompt, repoPath,
 *     jsonlPath, lastMessagePath, stderrPath }
 */
export function invokeGraphcodeRunner(payload, timeoutMs) {
  const cfg = resolveGraphcodeConfig();
  mkdirSync(dirname(payload.jsonlPath), { recursive: true });
  writeFileSync(payload.jsonlPath, "", "utf-8");

  const startedAt = Date.now();
  const appendJsonl = (record) => {
    appendFileSync(payload.jsonlPath, `${JSON.stringify(record)}\n`, "utf-8");
  };
  const lastMessagePath = payload.lastMessagePath || payload.jsonlPath.replace(/\.jsonl$/, ".final.txt");
  const stderrPath = payload.stderrPath || payload.jsonlPath.replace(/\.jsonl$/, ".stderr.log");

  appendJsonl({
    type: "run_started",
    at: new Date(startedAt).toISOString(),
    taskId: payload.taskId,
    armId: payload.armId,
    modelId: payload.modelId,
    runNumber: payload.runNumber,
    harness: "graphcode-native (pi + graphcode extension)",
  });

  if (!existsSync(cfg.tsx) || !existsSync(cfg.piCli)) {
    appendJsonl({
      type: "run_complete",
      at: new Date().toISOString(),
      status: "startup_error",
      error: `pi harness not found (tsx=${cfg.tsx}, cli=${cfg.piCli}); set GRAPHCODE_PI_DIR`,
    });
    return { exitCode: 3, timedOut: false, stdout: "", stderr: "pi harness missing", parsed: { ok: false, exitCode: 3, status: "startup_error", jsonlPath: payload.jsonlPath } };
  }

  // The pi model id is the provider-addressed sonnet (civitas/claude-sonnet-4-6).
  // payload.claudeModelId is the bare slug (claude-sonnet-4-6); pi addresses the
  // model with --provider + --model.
  const piModel = payload.claudeModelId || "claude-sonnet-4-6";

  // Lever A: graph-first turn-0. Pre-run an explore over the task's named symbols
  // and inject the result, so the agent starts with the flow in context.
  let prompt = payload.prompt;
  if (process.env.GRAPHCODE_AUTOCONTEXT === "1") {
    const auto = buildAutoContext(cfg, payload.repoPath, payload);
    if (auto) {
      const toolName = auto.tool === "impact" ? "impact" : "explore";
      appendJsonl({
        type: "stream_event",
        at: new Date().toISOString(),
        event: {
          type: "tool_call",
          name: `mcp_codegraph_${toolName}`,
          status: "completed",
          raw: { tool_call: { mcpToolCall: { args: { providerIdentifier: "codegraph", toolName, arguments: { symbols: auto.symbols.join(" "), autocontext: true } } } } },
        },
      });
      if (auto.tool === "impact") {
        // GRAPH-NATIVE RANKING preamble. The harness ran the code graph and RANKED
        // the dependents by graph signal (reference density + direct-caller +
        // package locality) so the highest-signal true dependents are at the top.
        // The agent's job is to commit a PRECISION-AWARE shortlist — not dump the
        // firehose (that tanks F1). If the ranker is unavailable we fall back to the
        // raw file list (legacy behavior).
        const ranked = Array.isArray(auto.ranked) ? auto.ranked : null;
        if (ranked && ranked.length) {
          // v2 ranker emits explicit confidence TIERS and already demotes test files.
          // We exploit that structure two ways to close the offline→agent realization gap:
          //   (1) present a CLEAN, test-free, tier-segmented shortlist (not a flat list);
          //   (2) hand the agent a PRE-DRAFTED answer = the high-confidence tier, framed as
          //       a starting point to REFINE, not a list to re-derive from scratch. The
          //       offline ranker is strong (held-out F1 0.511); the agent's job is to edit
          //       it, not rebuild it — this is what stops the under-commit failure where the
          //       agent investigates and then names too few files.
          const real = ranked.filter((r) => !r.isTest); // tests are never gold caller files
          // High-confidence tier = direct callers + dense impact dependents (v2 "strong").
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
          prompt =
            `GRAPH ANALYSIS — the harness ran the code graph for ${payload.taskAnchors?.[0]} and ranked its dependents by structural signal (reference density + 1-hop direct-caller + package locality). Test files are already excluded (they are never the answer for a production blast radius). Two tiers:\n\n` +
            `HIGH-CONFIDENCE (direct callers and dense dependents — almost certainly affected):\n${highList}\n\n` +
            (moreList ? `LOWER-CONFIDENCE (weaker structural links — include only if a real dependency):\n${moreList}\n\n` : "") +
            `────────────────────────\n\n${payload.prompt}\n\n` +
            `Here is a STARTING ANSWER built from the high-confidence tier — your job is to REFINE it, not rebuild it:\n\n` +
            "```json\n" + draftJson + "\n```\n\n" +
            `Refine into your final "dependent_files" (most-important first): keep the high-confidence files unless graph_callers / graph_node gives you a CONCRETE reason a specific one is wrong; promote any lower-confidence file you verify is a real dependent. Do not drop high-confidence files just because you didn't personally re-trace them — the graph already did. Do not pad with weakly-connected files. Favor a complete, correctly-ordered set over a short or a bloated one.`;
        } else {
          const files = [...new Set((auto.text.match(/[A-Za-z0-9/_.-]+\.java/g) || []))]
            .filter((f) => !f.includes(`/${payload.taskAnchors?.[0]}.java`));
          const fileList = files.slice(0, 60).map((f) => `- ${f}`).join("\n");
          prompt =
            `GRAPH BLAST RADIUS (computed by the harness via the code graph for ${payload.taskAnchors?.[0]}):\n\n` +
            `${auto.text.slice(0, 4000)}\n\nDISTINCT DEPENDENT FILES (${files.length} total; first 60):\n${fileList}\n\n` +
            `────────────────────────\n\n${payload.prompt}\n\n` +
            `IMPORTANT: Select the genuinely-affected files from the list above, most-important first, favoring precision over raw count.`;
        }
      } else {
        prompt =
          `GRAPH CONTEXT (already retrieved by the harness before your turn — treat as authoritative, already-read source; do not re-fetch or read these files):\n\n${auto.text}\n\n────────────────────────\n\n${payload.prompt}`;
      }
    }
  }

  const args = [
    "--tsconfig",
    cfg.piTsconfig,
    cfg.piCli,
    "--mode",
    "json",
    "--provider",
    cfg.provider,
    "--model",
    piModel,
    "--extension",
    cfg.extension,
    "--approve",
    "-p",
    prompt,
  ];

  const child = spawnSync(cfg.tsx, args, {
    cwd: payload.repoPath,
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMs,
    env: {
      ...(payload.agentEnv || process.env),
      GRAPHCODE_CODEGRAPH_BIN: cfg.codegraphBin,
      GRAPHCODE_REPO_ROOT: payload.repoPath,
    },
  });

  const stderrText = child.stderr || "";
  if (stderrText) writeFileSync(stderrPath, stderrText, "utf-8");

  // Parse pi's --mode json stream: tool_execution_end carries {toolName, args};
  // the final assistant text is the last assistant message's text content.
  // Token accounting: pi attaches a per-assistant-message `usage` block. input is
  // the cumulative prompt size for that turn; output is that turn's generated
  // tokens. We sum output across turns (true generation cost) and take the max
  // input (peak context) — the two halves of token cost. Cache reads are tracked
  // separately since they are cheap.
  let finalAnswer = null;
  let sessionId = null;
  let outTokens = 0;
  let peakInput = 0;
  let cacheRead = 0;
  let lastTotal = 0;
  const accUsage = (u) => {
    if (!u || typeof u !== "object") return;
    if (typeof u.output === "number") outTokens += u.output;
    if (typeof u.input === "number") peakInput = Math.max(peakInput, u.input);
    if (typeof u.cacheRead === "number") cacheRead += u.cacheRead;
    if (typeof u.totalTokens === "number") lastTotal = Math.max(lastTotal, u.totalTokens);
  };
  for (const line of (child.stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (ev.type === "session" && ev.id) sessionId = ev.id;
    // Accumulate usage from message_end assistant turns (one final block per turn).
    if (ev.type === "message_end" && ev.message?.role === "assistant" && ev.message.usage) {
      accUsage(ev.message.usage);
    }

    // Count tool calls from tool_execution_end (one per completed call, with args).
    if (ev.type === "tool_execution_end" && ev.toolName) {
      const norm = normalizePiTool(ev.toolName, ev.args);
      appendJsonl({
        type: "stream_event",
        at: new Date().toISOString(),
        event: { type: "tool_call", name: norm.name, status: "completed", raw: norm.raw },
      });
      continue;
    }

    // Capture the final assistant text (a message_end with role assistant whose
    // content holds text blocks). The last such text is the answer.
    if (ev.type === "message_end" && ev.message?.role === "assistant" && Array.isArray(ev.message.content)) {
      const text = ev.message.content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("");
      if (text.trim()) finalAnswer = text;
    }
    // Some pi builds emit a terminal {type:"result"} — capture if present.
    if (ev.type === "result" && typeof ev.result === "string" && ev.result.trim()) {
      finalAnswer = ev.result;
    }
  }

  if (finalAnswer != null) writeFileSync(lastMessagePath, String(finalAnswer), "utf-8");

  const timedOut = child.error?.code === "ETIMEDOUT";
  const exitCode = timedOut ? 124 : child.status ?? (finalAnswer != null ? 0 : 1);
  const finishedAt = Date.now();
  const status = timedOut ? "timeout" : exitCode === 0 ? "finished" : "error";

  appendJsonl({
    type: "run_complete",
    at: new Date(finishedAt).toISOString(),
    status,
    agentId: sessionId,
    runId: sessionId,
    durationMs: finishedAt - startedAt,
    costUsd: null,
    usage: { output: outTokens, peakInput, cacheRead, totalTokens: lastTotal },
    result: finalAnswer,
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
      durationMs: finishedAt - startedAt,
      costUsd: null,
      jsonlPath: payload.jsonlPath,
      lastMessagePath,
      stderrPath: stderrText ? stderrPath : null,
      stderrBytes: Buffer.byteLength(stderrText),
    },
  };
}
