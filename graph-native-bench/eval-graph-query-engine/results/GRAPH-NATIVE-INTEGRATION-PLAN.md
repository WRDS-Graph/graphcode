# Plan — Apply our graph-native work to Graph-Query-Engine (build + prove)

## What this repo is (verified, not assumed)
- **~24k LOC TS/TSX (79 files) + ~2.7k LOC Python Flask backend (15 files)**, 34 test files, active PR flow.
- It is a React + Vite research-paper workbench + a hybrid retrieval backend (BM25 + vector + graph-PPR fused with RRF).
- **It already practices graph-native debugging**: a hand-written `.claude/graph/CODE_GRAPH.md` + a 5-stage SOP (`problem-understander → graph-traverser → fix-planner → impact-checker → implementer/ui-tester`).
- **The gap our work fills**: the semantic graph is *manually authored* (goes stale, no precision metric), and the **syntactic graph does not exist** — `BUILD.md` points `Logical_inference/graph-code-indexing` at a Windows machine that isn't here. The `impact-checker` agent is told to "use both graphs" but the second graph is missing.

## De-risking done (live, this session)
- `codegraph init .` → **96 files, 1,267 nodes, 5,622 edges in 1.1s**; languages: typescript 61, tsx 19, python 15, js 1 — **100% coverage** of this repo via tree-sitter-wasms.
- `codegraph query`, `impact`, `callers` all return correct results on real symbols (`graphMatchingEngine`, `computeOverlay`). The graph engine works on this repo *now*.

## Thesis transfer (our past findings → this repo)
Our measured lesson was: **the win is not "having a graph," it's querying + ranking the graph in the harness before the agent's first token** (graph-native F1 0.79 vs graph-as-MCP-tool 0.50), and **the v2 structural ranker** (test-demotion + reference-density + direct-caller bonus + name-match) converts a raw impact firehose (F1 0.169) into a budget-bounded shortlist (F1 0.519). This repo's `impact-checker` step is exactly the "rank a firehose in-context" failure mode we showed collapses — so it's the highest-leverage place to inject our ranker.

---

## Phase 0 — Baseline + harness (no behavior change yet)
1. Commit a `.gitignore` entry for `.codegraph/` (don't commit the index).
2. Add `scripts/graph/` with a thin Node wrapper `cg.mjs` that shells `codegraph impact|callers|callees|query --json` and returns parsed JSON (the repo is Node-native; no Python venv needed).
3. **Capture a baseline**: pick 2 of the 9 open issues with real gold (e.g. **#7 loading indicator** — clean small surface; **#4 concept-search quality** — cross-module hub) and record what the *current hand-written-graph* flow localizes vs. what `codegraph impact/callers` localizes. This is the before/after substrate.

## Phase 1 — Port the v2 ranker to this repo (the core artifact)
4. Port `extension/impact-ranker-v2.mjs` → `scripts/graph/impact-ranker.mjs`, adapted for JS/TS/Python conventions instead of Java:
   - **test-file demotion**: `*.test.ts(x)`, `test_*.py`, `src/test/**` (this repo's convention) — never the gold answer for a production fix.
   - **reference density + additive direct-caller bonus + name-match** (kept from v2).
   - **package/module locality**: same `src/<feature>/` dir (matching, retrieval, query, state, renderer) instead of Java packages.
5. Unit-test the ranker (port the existing `impact-ranker-v2.test.mjs` shape) against this repo's symbols.
6. **Wire it into the SOP**: rewrite `.claude/agents/impact-checker.md` and `graph-traverser.md` so step 1 runs `codegraph impact <symbol> | ranker` and hands the agent a **pre-ranked, test-demoted, tier-segmented shortlist** (Safe/Watch/Break) instead of asking the agent to walk a hand-written table from memory. This is Lever A (turn-0 ranked injection) applied to their pipeline.

## Phase 2 — Auto-build the syntactic graph (close the BUILD.md gap)
7. Add `scripts/graph/build-syntactic.mjs` that runs `codegraph` and emits `.claude/graph/syntactic/graph-query-engine-graph.json` in the **node/edge shape `BUILD.md` documents** (nodes: file/class/function; edges: parent_child/calls/imports/inherits) — so the existing `impact-checker` "use both graphs" instruction finally has its second graph, built locally in ~1s instead of on a missing Windows box.
8. Add a **freshness check**: a script that diffs the hand-written `CODE_GRAPH.md` localization index (§7) against the live syntactic graph and flags drift (entries that no longer resolve to real symbols) — turns the stale-graph risk into a CI-able check.

## Phase 3 — Prove it on each task family (the "all code-related tasks" ask)
Demonstrate measured value on one concrete task per family, each as a small artifact under `.claude/graph/demos/`:
9. **Reconstruction / refactor**: use `codegraph` in-degree ranking to find the god-objects (`graphMatchingEngine.ts` is the obvious hub — 11458% search weight) and `impact` to scope a safe extraction; produce a ranked "what-breaks-if-I-split-this" report and compare to grep.
10. **Bug fix**: run the real 5-stage SOP on one open issue (**#7** recommended — small, UI-state, verifiable) using the new ranked impact-checker; record graph-trail + token usage vs. the hand-graph baseline from Phase 0.
11. **AI-slop cleanup**: use `callers`/`impact` to find **zero-in-degree dead code** (symbols nobody calls, minus entrypoints/tests) — grep can't prove "nobody calls this" across dispatch; this is our documented dead-code use case.
12. **Security**: trace **data-flow from untrusted input** — the Flask `/api/search` handler (`backend/server.py`) and the `OPENAI_API_KEY` paths — with `callees`/`explore` to enumerate the reachable sink set; flag unvalidated input reaching subprocess/file/eval-like sinks. (Backend is Python; same codegraph index covers it.)
13. Write **`.claude/graph/RESULTS.md`**: per-task before/after (hand-graph vs. codegraph+ranker) on localization precision, files-read, and token cost — the honest, reproducible scorecard, mirroring our ROBUSTNESS-REPORT discipline (disclose ties/negatives, no inflated headline).

---

## Deliverables
- `scripts/graph/{cg.mjs, impact-ranker.mjs, impact-ranker.test.mjs, build-syntactic.mjs, freshness-check.mjs}`
- Updated `.claude/agents/{graph-traverser, impact-checker}.md` (ranked turn-0 injection)
- `.claude/graph/syntactic/graph-query-engine-graph.json` (auto-built)
- `.claude/graph/demos/` (4 task-family demos) + `.claude/graph/RESULTS.md`

## Guardrails (honoring this repo's own rules + global rules)
- **No production code behavior change** in Phases 0–2; demos are analysis artifacts, not merged fixes. If Phase 3 #10 produces a real bug fix, it follows *their* SOP exactly (one-issue→one-branch→one-PR, **left open, never merged**), and only touches an issue actually in scope.
- Don't commit `.codegraph/` or copied `sample data`.
- Immutable-state + cytoscape-zoom + backend-optional landmines respected if any code is touched.
- Author vs. review kept in separate passes (ranker built, then verified by a separate check) per global rules.

## Open choice deferred to execution
- Whether to **replace** the hand-written `CODE_GRAPH.md` with a generated one or **keep it as the semantic layer and add codegraph as the syntactic layer underneath** (BUILD.md's stated two-graph design). Recommendation: **keep both** — their semantic graph encodes intent the syntactic graph can't, and our work is strongest as the precise, always-fresh syntactic + ranking layer beneath it.
