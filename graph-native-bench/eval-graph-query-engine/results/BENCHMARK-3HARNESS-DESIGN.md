# Rigorous 3-harness × multi-task benchmark — design

**Goal.** Measure graph-native vs plain vs harness+graph-MCP across *different task types*, and
map **which graph structure (subgraph) serves which task** in a full-refactor / code-cleanup
scenario. Deep, honest, reproducible — the ROBUSTNESS-REPORT discipline applied to this repo.

## The three harnesses (independent variable = harness wiring only)

| Arm | Wiring | Runs via |
|---|---|---|
| **plain** | `claude -p`, tools = Read/Grep/Glob/Bash. No graph. | `claude -p --allowedTools "Read Grep Glob Bash"` |
| **graph-MCP** | same agent + codegraph MCP server (`codegraph_explore/node/impact/...`). Graph-as-a-tool. | `claude -p` + `codegraph install` MCP |
| **graph-native** | harness pre-runs the ranked blast radius (`rank-impact.mjs`) and injects a tier-segmented draft BEFORE turn 0, + graph-first prompt, + MCP to verify. | `claude -p` + injected preamble |

Same model, same gold, same budget. The only difference is *when/where retrieval+ranking happens*.

## Task families (each needs a different graph projection)

| # | Task type | Deliverable (machine-scorable) | Graph projection it needs |
|---|---|---|---|
| **T1 Impact / blast-radius** | "what files break if `X` changes?" → ranked file list | **reference graph** (reverse reachability) + ranker |
| **T2 Caller enumeration** | "every call site of `m()`" → call-site file list | **call graph** (direct reverse edges) |
| **T3 Data-flow trace** | "how does input reach sink `Y`?" → ordered path | **call+import graph** forward walk |
| **T4 Dead-code / AI-slop** | "uncalled exported symbols" → deletion list | **reference graph**, zero in-degree |
| **T5 God-object / refactor triage** | "which files to split first" → ranked hub list | **reference graph**, in-degree ranking |
| **T6 Test selection** | "which tests cover this change" → test-file list | **test subgraph** (source→test edges) |

Gold per task is derived structurally (graph-verifiable) or from `CODE_GRAPH §7`, capped, F1-scored.

## Metrics (per arm × task × n runs)
- **F1 @ top-K** (precision+recall, basename set-match) — the quality axis.
- **Cost:** output tokens, cache-read tokens, USD (from `claude -p` usage), wall-clock.
- **Tool churn:** #Read, #Grep, #graph-calls — the efficiency axis.
- **Variance:** 95% CI across n=3 (consistency is a reliability axis).

## The structural research question (the "which graph for which task" map)
For a **full-codebase refactor / spaghetti-cleanup**, decompose into phases and map each to the
subgraph that drives it (Triage → Plan → Execute → Verify). Validated against this repo's live graph.

## Honesty rails
- Disclose ties and negatives. No arm is expected to dominate all tasks (that would signal a rigged metric).
- Predict each win from task *structure* (firehose → big graph-native win; clean 1-hop → marginal) and check the prediction.
- Where running real agents is too costly for n=3 × 6 tasks × 3 arms, run the **retrieval-layer oracle** (what each harness *can deliver* to the agent) and clearly label it as oracle vs end-to-end.

## Execution plan
1. Build `tasks-3harness.json` — anchors + structural gold for T1–T6.
2. Build `oracle-3harness.mjs` — computes, per task, what plain (grep-equivalent) vs MCP (raw graph, in-context-ranked proxy) vs native (pre-ranked) deliver. This is the deterministic, fast, reproducible core.
3. Run a *small* end-to-end agent A/B (n=1–2) on 1–2 tasks to validate the oracle predicts real-agent behavior (the link the Hadoop study established).
4. Write `BENCHMARK-3HARNESS-RESULTS.md` + the refactor graph-structure map.
