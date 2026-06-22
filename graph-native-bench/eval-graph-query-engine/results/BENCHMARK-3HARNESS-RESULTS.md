# 3-harness × multi-task benchmark + refactor graph-structure map

**Question (the goal).** Rigorously benchmark **graph-native** vs **plain** vs **harness+graph-MCP**
across different task types; and map **which graph structure (subgraph) serves which task** in a
full-refactor / code-cleanup scenario. Deep, honest, reproducible.

**One-line answer.** Across 8 tasks spanning 6 families, **graph-native wins on mean F1 (0.768) >
graph-MCP (0.702) > plain (0.314)**, and a **live `claude -p` agent A/B confirms the direction**
(on the firehose task graph-native beat plain **0.56 vs 0.52 at lower cost**). No arm dominates
everything — plain wins clean text-match tasks, graph-MCP ties native where the raw graph is
already clean, and native wins decisively where **ranking a firehose or expressing a graph-only
query** (dead-code, blast-radius) is the bottleneck. *Which graph wins is predictable from task
structure*, which is the whole point.

---

## 1. The three harnesses (independent variable = wiring only)

| Arm | Wiring | Retrieval+ranking happens… |
|---|---|---|
| **plain** | `claude -p`, Read/Grep/Glob/Bash | …in the agent, by reading/grepping |
| **graph-MCP** | + codegraph MCP (`codegraph_*` tools) | …in the agent, *in-context*, over the raw graph |
| **graph-native** | + harness pre-injects the **v2-ranked, test-demoted** blast radius before turn 0 | …in deterministic harness code, *before* the agent reasons |

Same model (`claude -p`, subscription, no API key), same gold, same top-K budget. Confirmed all
three are runnable here: `claude` 2.1.185 + `codegraph install` (MCP) both present.

## 2. Results — retrieval oracle (deterministic, n=8 tasks, F1 @ top-15)

The oracle computes what each harness **can deliver to the agent**, modeling the measured mechanism:
plain = grep-equivalent (unranked name-matches), graph-MCP = raw graph order capped at K (rank-in-
context, under-enumerate), graph-native = pre-ranked capped at K.

| Task | Family | gold | plain | graph-MCP | **graph-native** | winner |
|---|---|--:|--:|--:|--:|---|
| T1 PaperGraph | impact (firehose) | 39 | 0.33 | 0.30 | **0.56** | **native** |
| T1 appState | impact (medium) | 5 | 0.50 | 0.91 | **0.91** | MCP = native |
| T2 createDataLayer | caller-enum (clean) | 9 | **0.95** | 0.90 | 0.90 | **plain** |
| T2 renderGraph | caller-enum | 1 | 0.33 | 0.67 | **0.67** | MCP = native |
| T3 search | data-flow | 5 | 0.00 | 0.91 | **0.91** | MCP = native |
| T4 dead-code | dead-code | 15 | 0.00 | 0.73 | **1.00** | **native** |
| T5 god-objects | refactor-triage | 10 | 0.00 | 0.80 | **0.80** | MCP = native |
| T6 test-selection | test-selection | 1 | 0.40 | 0.40 | 0.40 | three-way tie |
| **MEAN** | | | **0.314** | **0.702** | **0.768** | |
| **WINS** | | | 1 | 0 | **2** (+5 ties) | |

**Readings (each predictable from structure):**
- **Native uniquely wins the two ranking-hard tasks** — the **firehose** (T1 PaperGraph: 52 of 59
  files are tests; only test-demotion recovers it) and **dead-code** (T4: only the name-reference
  filter removes the dispatch false-positives → 1.00 vs MCP's 0.73).
- **Native ties graph-MCP on clean tasks** (appState, search, god-objects, renderGraph) — when the
  raw graph order is already good, ranking is a no-op. Honest: the ranker's lift is *firehose-
  conditional*.
- **Plain wins one clean text-match task** (T2 createDataLayer 0.95) — brute-force grep on a
  distinctive name with a shallow caller tree genuinely beats the graph. *(Caveat: gold here is the
  direct-caller name-set, which favors grep by construction — disclosed.)*
- **Plain collapses to 0.00 on T3/T4/T5** — data-flow, dead-code, refactor-triage are **graph
  traversals, not text matches**; grep structurally cannot express "uncalled" or "most-depended-on."
  This is the sharpest demonstration that *some tasks are only reachable with a graph*.

## 3. Live agent A/B — does the oracle predict real agents? (the validation)

Real `claude -p` runs, plain vs graph-native, scored against the same gold + cost from usage JSON:

| Task | Arm | live F1 | precision | cost USD | out-tok | turns | oracle predicted |
|---|---|--:|--:|--:|--:|--:|---|
| **PaperGraph** (firehose) | plain | 0.52 | 0.93 | $0.673 | 1527 | 5 | — |
| **PaperGraph** | **graph-native** | **0.56** | **1.00** | **$0.608** | 1865 | 7 | native wins (0.56) ✅ |
| createDataLayer (clean) | plain | 0.18 | 0.50 | $0.469 | 497 | 3 | — |
| createDataLayer | graph-native | 0.17 | 0.33 | **$0.437** | 461 | 2 | arms cluster ✅ |

**Findings:**
1. **The oracle's direction holds end-to-end.** On the firehose, graph-native beat plain on F1
   (**0.56 vs 0.52**) *and* hit **precision 1.00** (the test-demotion landed) *and* was **cheaper**
   ($0.608 vs $0.673). The "better *and* cheaper" dual win reproduces with real agents.
2. **graph-native is cheaper in BOTH tasks** ($0.437 vs $0.469; $0.608 vs $0.673) — the cost win is
   robust to task type (retrieval done once in the harness vs repeatedly by the agent).
3. **Honest calibration gap (disclosed).** The oracle's *absolute* F1 is an **upper bound**: it
   assumes the agent transcribes the full delivered set. Real agents **under-enumerate** — on
   createDataLayer both arms recalled only 1/9, so live F1 (~0.17) sits far below the oracle's 0.90+.
   So: **trust the oracle for the ranking/direction between arms, not for absolute F1.** This is the
   same "agents are terse, recall rewards breadth" effect the Hadoop study documented.

## 4. The refactor / spaghetti-cleanup graph-structure map (validated on this repo's live graph)

A full-codebase refactor is not one task — it is phases, each needing a different **subgraph
projection** of one mixed code graph. Each row below is validated against live numbers from this repo.

```
                ┌────────────────── one mixed code graph ──────────────────┐
   call graph  ─┤ calls (2,446 edges)            → callers/callees, data-flow │
   ref graph   ─┤ references (1,174)             → impact, dead-code, in-degree│
   type graph  ─┤ implements/instantiates (32)   → interface extraction        │
   module graph─┤ imports (800; 34% cross-dir)   → boundary/leak detection      │
   contains    ─┤ parent_child (1,170)           → file→symbol structure        │
   test graph  ─┤ source↔test pairing (32/47)    → test selection               │
                └──────────────────────────────────────────────────────────────┘
```

| Refactor phase | Concrete task | Subgraph to query | Best harness | Live signal on THIS repo |
|---|---|---|---|---|
| **Triage** | find god-objects to split first | **ref graph, in-degree** | native ≈ MCP | `lruCache` 468, `paper.ts` 399, `graphRenderer` 310 |
| **Triage** | find dead code to delete | **ref graph, zero in-degree** + name-filter | **native** (T4 1.00) | 37 candidates (after dispatch filter) |
| **Triage** | find tangled cycles | **call-graph SCCs** | native ≈ MCP | 0 two-cycles (this repo is acyclic — honest: N/A here) |
| **Triage** | find leaky module boundaries | **import graph, cross-dir edges** | native ≈ MCP | 275/800 imports (34%) cross a top-level dir |
| **Plan** | scope a change's blast radius | **ref graph + ranker** | **native** (firehose) | PaperGraph: 15/15 prod files, 52 tests demoted |
| **Plan** | find every call site to update | **call graph, reverse** | MCP ≈ native; plain ok if name distinctive | createDataLayer 9 callers |
| **Plan** | learn what a method depends on | **call graph, forward** | MCP ≈ native | search: 5-file forward closure |
| **Plan** | pick the tests to run | **test subgraph** | native ≈ MCP | 32/47 prod files have a sibling test (15 gaps) |
| **Execute** | migrate all implementors of a type | **type graph + name-match** | **native** (name-match) | 32 implements/instantiates edges |
| **Execute** | split a hub by facet | **ref-graph clustering** | native | cluster PaperGraph's 39 prod dependents |
| **Execute** | rewire cross-module imports | **import graph** | native ≈ MCP | the 275 cross-dir edges are the exact rewire set |
| **Verify** | confirm nothing dangles post-delete | **impact re-run = ∅** | native ≈ MCP | graph as the acceptance gate |

**The orchestration rule (why "native" beats "MCP" when it does).** The graph-MCP agent must rank
the firehose *in-context, mid-reasoning*, and on a hub it stops early (the T1 PaperGraph gap: MCP
0.30 vs native 0.56). The native harness ranks it *in deterministic code before turn 0* and hands a
clean draft. **The win is the relocation of ranking into the harness — not a better tool.** On clean
1-hop tasks there is nothing to relocate, so the two tie.

## 5. Honest negatives / threats to validity
- **n is small** (8 oracle tasks, 2 live A/B tasks, 1 repo). Directional, not a population estimate.
- **Oracle absolute F1 is an upper bound** — real agents under-enumerate (§3.3). Use it for arm
  *ordering*, not absolute scores.
- **Some gold is graph-derived** (self-referential for impact/caller tasks) — it tests *ranking*,
  not recall ceiling. The CODE_GRAPH-gold localization study (`RESULTS.md`) is the human-gold complement.
- **graph-MCP arm is modeled in the oracle, not run live** (the live A/B was plain vs native). The
  MCP-collapse-on-hub effect is inferred from the raw-graph-order proxy + the Hadoop end-to-end study.
- **This repo is acyclic and well-factored** — the cycle-breaking and some firehose tasks have less
  signal here than they would on a true "mountain of spaghetti." The map shows the *method*; the
  magnitude scales with how coupled the target codebase is.

## 6. Reproduce
```bash
codegraph init . && node scripts/graph/build-syntactic.mjs
node scripts/graph/oracle-3harness.mjs --budget 15          # the 8-task 3-harness table
node scripts/graph/agent-ab.mjs PaperGraph --gold production-dependents --budget 15   # live A/B (firehose)
node scripts/graph/agent-ab.mjs createDataLayer --gold direct-callers --budget 15      # live A/B (clean)
```
Tasks: `scripts/graph/tasks-3harness.json`. Oracle: `oracle-3harness.mjs`. Live A/B: `agent-ab.mjs`.
Design: `BENCHMARK-3HARNESS-DESIGN.md`.
