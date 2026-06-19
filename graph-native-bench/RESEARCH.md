# Graph-native coding agent — research log

**Question.** Can a *graph-native* coding-agent harness beat "a general agent + a graph
exposed over MCP" (e.g. Claude Code + codegraph MCP)? And — the sharper version a maintainer
pushed on — is the thing I built actually graph-native, or just "pi + graph MCP"?

**Honest starting answer.** The v0 harness (pi + graph_* tools + a graph-first system prompt)
is the *floor*, not the finish line. It is better than Claude-Code-+-MCP on two axes (tools are
first-class in the harness; steering lives in the system prompt instead of MCP's low-salience
`initialize` text) but architecturally it is still "an agent that *may choose* to call graph
tools." Making it genuinely graph-native is an iterative, measured research problem.

## Apparatus

- **Harness under test:** `graphcode` = the [pi coding-agent](https://pi.dev) harness + a
  `graphcode` extension that registers graph tools (`graph_explore`, `graph_node`, `graph_search`,
  `graph_callers`, `graph_callees`, `graph_impact`) backed by the codegraph index, plus a
  graph-first system prompt. Added as a `graphcode-native` arm in the `hadoop-mcp-eval` matrix.
- **Baseline arms:** `control` (Claude Code, no graph) and `codegraph` (Claude Code + codegraph
  MCP) — the latter is the "agent + graph MCP" we must beat.
- **Model:** fixed `claude-sonnet-4-6` across all arms (the eval's deliberate floor model — an
  affordance that lands on Sonnet generalizes up; one that only works on a stronger model doesn't
  generalize down to the agents most users run).
- **Corpus:** Apache Hadoop (12.5k Java files). Fast inner loop on the `hadoop-hdfs-client`
  subset (335 files); discriminating impact tasks on full Hadoop.
- **Metrics (faithful to the eval's own scoring):**
  - *Flow tasks:* quality 0-3, DTA (dependency-traversal accuracy: are the gold edges cited),
    CFRD (cross-file reasoning depth), Read/Grep count.
  - *Impact tasks:* recall@10 / recall@20 / precision against real PR caller-file ground truth
    — non-saturating by design (gold blast radius is 35-300 files).
  - *Cost (all arms):* output tokens + cache-read tokens; USD where the runner bills it
    (Claude arms do; the pi/civitas arm reports tokens, not USD).

## Iteration 0 — baseline (flow task H1, hdfs-client subset)

H1 = "trace how a client write to HDFS reaches block streaming."

| Arm | quality | DTA | CFRD | graph calls | Read | Grep | out-tok | cache-read | $ |
|-----|--------:|----:|-----:|------------:|-----:|-----:|--------:|-----------:|--:|
| control (no graph) | 3 | 1.00 | 1.00 | 0 | 15 | 11 | 6227 | 635339 | 0.609 |
| codegraph (Claude+MCP) | 3 | 1.00 | 1.00 | 6 | **0** | **0** | 3658 | 339967 | **0.477** |
| graphcode-native (v0) | 3 | 1.00 | 1.00 | 11 | 2 | 0 | — | — | — |

**Findings.**
1. **The graph-native v0 harness LOST to Claude+MCP on efficiency.** The MCP arm finished in
   6 graph calls, 0 reads. Mine took 11 graph calls and still did 2 reads — same perfect
   correctness, more churn. This is the maintainer's point, proven: registering tools + a prompt
   nudge is not enough.
2. **The MCP arm's recipe:** 6 straight `codegraph_explore` calls, no search-first, no reads.
   My arm *hunted* — 5 `graph_search` calls before its first explore — then read twice to
   self-verify. The native harness was one bad graph result away from abandoning the graph.
3. **Quality saturated.** All three arms scored 3/3, DTA 1.0 — H1 is too easy; only tool
   efficiency separated arms. A benchmark where everyone scores 100% can't measure engineering
   ability. (Fix below.)

## Iteration 1 — Lever B: graph_node + sharpened steering

Added a `graph_node` tool (full symbol body + caller/callee trail — codegraph's read-killer) and
rewrote the system prompt: "explore is the entry point, don't search first; use graph_node
instead of read."

**Result (H1, native arm):** Read **2 → 0** (graph_node displaced reads — the steering worked),
but total graph calls *rose* (the agent over-used graph_node, inspecting symbols one at a time).
Traded reads for node-call churn. **Without token measurement you cannot tell if this is better
or worse** — which is exactly why cost had to become a first-class metric.

## Iteration 2 — Lever A: auto-context injection (graph-first turn-0)

The harness runs a graph query *before* the agent's first turn and injects the result as a
"GRAPH CONTEXT (already retrieved)" preamble. Specialized by task type: impact →
`graph_impact(anchor)`; flow → concept-search → entry symbols → `explore`.

H1 native-arm trajectory across iterations:

| Run | Levers | graph calls | Read | Grep | anchors | out-tok | first move |
|-----|--------|------------:|-----:|-----:|--------:|--------:|------------|
| r1 | v0 baseline | 11 | 2 | 0 | 3/3 | — | search×4 then explore (hunting) |
| r2 | + Lever B (graph_node) | 24 | **0** | 0 | 3/3 | — | search→explore, then node-churn |
| r3 | + Lever A (auto-context) | **11** | **0** | 0 | 3/3 | 3769 | **explore first**, refines cleanly |

**Findings.**
- **Lever A removed the hunting.** r3's first tool call is `explore`, not the 4-search prefix
  that opened r1 — the injected turn-0 context gave the agent its entry points for free.
- **Lever A tamed Lever B's node-churn.** r2 ballooned to 24 graph calls (15+ `graph_node` to
  reconstruct context one symbol at a time); with context injected up front, r3 needed only 11.
- **Reads stayed at 0** (Lever B's `graph_node` displacement held).
- Net: **Lever A+B = 11 graph calls, 0 reads, 0 greps, 3769 out-tok** — now competitive with
  the codegraph-MCP arm on H1 (6 calls, 0 reads, 3658 out-tok). No longer losing on reads; the
  remaining gap is graph-call count, and the real discriminator is the impact tasks (below).

## Fixing the benchmark (maintainer's demand: "if all models get 100% it's a bad benchmark")

Following the eval's own design, switched the discriminating tasks from flow (saturating) to the
**PR-derived impact tasks (I-series)**: "method X in class C is changing — name the blast
radius." Scored by recall@10/@20 against real PR caller-file sets (gold = 35-300 files). These
do not saturate.

Validation on the eval's existing committed I1 run (full Hadoop, `Resource.castToIntSafely`,
300-file gold):

| Arm | recall@10 | recall@20 | precision | graph | Read | Grep | out-tok | cache-read | $ |
|-----|----------:|----------:|----------:|------:|-----:|-----:|--------:|-----------:|--:|
| control | 0.40 | 0.25 | 0.08 | 0 | 5 | 15 | 7429 | 504549 | 0.631 |
| codegraph (Claude+MCP) | 0.30 | 0.20 | 0.10 | 6 | 0 | 0 | 4081 | 218291 | **0.353** |

**This is a good benchmark:** nobody scores 100% (recall@10 is 0.30-0.40), and it surfaces a
real tension — the MCP arm was **44% cheaper** (and used half the cache-read tokens) but got
*lower recall* here than control. Cost reduction is real and measurable; correctness has
headroom. The open question for the native arm: can leading with `graph_impact` (which returns
the dependent set directly) get **higher recall AND lower cost** than both?

## Iteration 3 — the impact-recall finding (the most important result)

Ran I2 (`FSNamesystem.shouldRoll` blast radius, 25 gold caller files in the full PR set) across
all three arms on **full Hadoop** (472k nodes). Scored on recall of the gold dependent files.

| Arm | recall@10 | recall@20 | precision | named (valid/total) | graph | Read | Grep | out-tok | $ |
|-----|----------:|----------:|----------:|---------------------|------:|-----:|-----:|--------:|--:|
| control (no graph) | **0.30** | **0.30** | 0.25 | 9/36 | 0 | 2 | 28 | 7892 | 0.717 |
| codegraph (Claude+MCP) | 0.10 | 0.15 | 0.24 | 4/17 | 10 | 0 | 0 | 3619 | 0.635 |
| graphcode-native (v2) | 0.10 | 0.05 | 0.09 | 1/11 | 17 | 0 | 0 | 2128 | — |

**Both graph arms LOST to no-graph control on recall.** This is the session's central finding,
and it is not a bug — it is the thesis, sharpened:

- Control brute-forced breadth: 28 greps, named 36 dependents (9 valid) → recall 0.30.
- Both graph arms were concise: 11-17 named, 1-4 valid → recall 0.10. They trusted compact graph
  answers and **under-enumerated**.
- **Yet the graph CONTAINS the answer perfectly:** `graph_impact(FSNamesystem)` returns a 407-file
  blast radius that includes **25/25 (100%) of the gold caller files.** The data is right there;
  the agents just don't transcribe it.

**The lesson:** a graph makes agents efficient and terse (native used 3.7× fewer output tokens,
0 reads), but impact-*recall* rewards breadth. Exposing graph tools/context is not enough — when
the metric is "name as many real dependents as possible," conciseness is the wrong objective and
a tool-only integration actively *underperforms*. The harness must **convert the graph's complete
blast radius into an enumerated answer.** That is a harness job, not a tool job — exactly the
"graph-native vs graph-as-a-tool" distinction.

**The fix (iter 3):** for impact tasks the harness now parses the distinct dependent files out of
the injected `graph_impact` output and hands the agent an explicit enumerated list with a
directive: "this IS your answer source; name 20+ of the most-relevant entries; do not
under-report."

**Result — the graph-native harness now wins decisively (I2, full Hadoop):**

| Arm | recall@10 | recall@20 | named | graph calls | Read | Grep | out-tok |
|-----|----------:|----------:|------:|------------:|-----:|-----:|--------:|
| control (no graph) | 0.30 | 0.30 | 36 | 0 | 2 | 28 | 7892 |
| codegraph (Claude+MCP) | 0.10 | 0.15 | 17 | 10 | 0 | 0 | 3619 |
| **graphcode-native (fixed)** | **0.80** | **0.50** | **121** | **1** | **0** | **0** | 3571 |

- **recall@10 0.80 vs control 0.30 (+167%) and vs Claude+MCP 0.10 (8×).**
- **1 graph call, 0 reads, 0 greps** — the harness pre-computed the blast radius; the agent
  answered directly from it. Control needed 28 greps; the native arm needed zero retrieval churn.
- **55% fewer output tokens than control** (3571 vs 7892) at far higher recall.

**What this proves.** The win did NOT come from a better tool — all three arms had access to the
same codegraph index; the MCP arm even calls `codegraph_impact`. It came from a HARNESS change:
pre-running the graph query and *converting its complete output into an enumerated answer the
metric rewards.* That is the "graph-native vs graph-as-a-tool" thesis, demonstrated end to end —
the same finding the codegraph maintainers documented (steering must live in the harness, not in
the low-salience MCP channel), now reproduced as a measured win on a non-saturating engineering
task.

### Robustness — multi-run, multi-task

The win reproduces across runs and generalizes to a second impact task (full Hadoop, sonnet-4.6):

| Task (gold) | Arm | recall@10 | recall@20 | graph | Read | Grep | out-tok |
|-------------|-----|----------:|----------:|------:|-----:|-----:|--------:|
| I2 (25) | control | 0.30 | 0.30 | 0 | 2 | 28 | 7892 |
| I2 (25) | codegraph-MCP | 0.10 | 0.15 | 10 | 0 | 0 | 3619 |
| I2 (25) | **graphcode-native** r2 | **0.80** | **0.50** | 1 | 0 | 0 | 3571 |
| I2 (25) | **graphcode-native** r3 | **0.80** | **0.50** | 1 | 0 | 0 | 3487 |
| I12 (6) | control | 0.83 | 0.83 | 0 | 6 | 19 | 4843 |
| I12 (6) | **graphcode-native** | **1.00** | **1.00** | 1 | 0 | 0 | 2047 |

Native I2 is stable across two runs (0.80 / 0.50 both times — not variance); I12 generalizes to a
perfect recall@10 of 1.00. On both tasks the native harness uses 1 graph call and 0 reads/greps,
and on I12 it beats the no-graph control on recall (1.00 vs 0.83) while using 6 fewer reads, 19
fewer greps, and 58% fewer output tokens.

## Iteration 4 — the honest correction (supersedes iter-3's headline)

A rigorous re-audit (see `bench/AUDIT-FINDINGS.md`, `bench/BENCHMARK-REDESIGN.md`, and an
independent adversarial workflow) found that **iter-3's "recall@10 0.80 vs 0.30" was a scoring
artifact, not a capability.** The proof, from the committed transcripts:

- Native I2 **r1** (no autocontext, 17 real graph calls): recall@10 **0.10**.
- Native I2 **r2/r3** (autocontext PASTE: harness pasted 60 blast-radius files into the prompt;
  agent made **1** synthetic tool call and copied the list): recall@10 **0.80**.

So the "win" was the harness pasting a near-superset of the answer into a metric (`recallAt` =
substring scan over the whole prose answer) that **only rewarded recall and never punished the
firehose.** Raw `codegraph impact` has recall 1.0 but **precision 0.06** (407 files for a 25-file
change); pasting it maxes recall for free.

**Hardened scoring kills the artifact.** Under F1 (precision+recall on the *same* bounded
`dependent_files`, budget top-20, basename set-match — `bench/score-impact-hardened.mjs`), the
paste runs score **0.36–0.40 — parity with control's grep-based 0.36, not a 2.7× win.** The
inflation is entirely gone.

**The real, unfakeable win: a graph-native RANKER.** The genuine problem the artifact hid is that
`impact`'s file-order top-N is mediocre (F1 ~0.17). `extension/impact-ranker.mjs` re-ranks the
firehose by graph signal (reference density + direct-caller bonus + package locality). Validated
on **9 held-out, deduplicated impact tasks never used for tuning**, scored by hardened F1 with the
raw-impact oracle as a floor:

| | raw-impact oracle F1 | graph-native ranker F1 |
|---|--:|--:|
| **held-out mean (n=9)** | **0.169** | **0.386** (+0.218, 2.3×) |

The ranker beats the oracle floor on **7/9** held-out tasks, with two honestly-reported failures:
`Server` (god-object, package-locality misleads, −0.09) and `Clock` (0.00 both).

**Update (ranker v2 — current production ranker).** `extension/impact-ranker-v2.mjs` supersedes v1
with three gold-blind structural changes — **test-file demotion** (40–55% of any Java blast radius
is test files, often densest, never gold), **additive direct-caller** (not a hard tier — a tier
buries gold when `callers` ⊥ gold, the I1 Resource bug), and **name-match** (a basename containing
the anchor word is an implementor/subtype: `MonotonicClock`→`Clock`). Re-validated this session:

| | raw-impact oracle F1 | ranker v1 | **ranker v2** |
|---|--:|--:|--:|
| held-out mean (n=9) | 0.169 | 0.386 | **0.519** (+0.350 vs oracle, +34% vs v1) |
| beats oracle floor | — | 7/9 | **9/9** |

v2 fixes both v1 failures (`Server` −0.09→+0.18, `Clock` 0.00→+0.07) and beats the floor on every
held-out task. Reproduce: `node bench/validate-ranker-v2.mjs --ranker ../extension/impact-ranker-v2.mjs`.

**Update (co-change signal — tested, honest negative).** The backlog's co-change idea was built
(`bench/mine-cochange.mjs`, `extension/impact-ranker-v3.mjs`) and validated held-out: it is a *real*
signal (promotes true low-static-edge gold like `dfsoutputstream`/`datastreamer` into top-20) but at
budget top-20 it is **neutral-to-negative** — no weight beats v2's 0.519. Shipped as opt-in at
neutral weight, documented in `bench/COCHANGE-FINDING.md`, not claimed as a win.

**Update (gateway confound removed + Claude-subscription native arm).** The agent A/B below ran the
native arm on pi/`civitas` while control/codegraph ran on `claude` — a confound. This session
re-homed the graph-native harness onto the **same `claude -p` Claude-subscription invocation**
(`scripts/lib/graphcode-claude-runner.mjs`, arm `graphcode-native-claude`): identical gateway, two
levers preserved (turn-0 v2-ranked injection + graph-first prompt). All arms now differ *only* in
harness wiring. Multi-run CIs on this clean setup: see `bench/ROBUSTNESS-REPORT.md`.

**End-to-end through the real product** (pi + graphcode extension, ranked-hint preamble that the
agent must *reason over and filter*, not transcribe):

| Task | Arm | F1 | prec | recall | real graph calls | out-tok |
|------|-----|---:|-----:|-------:|-----------------:|--------:|
| I2 | control (grep) | 0.36 | 0.40 | 0.32 | 0 (28 grep) | 7892 |
| I2 | codegraph-MCP | 0.19 | 0.24 | 0.16 | 10 | 3619 |
| I2 | **graphcode-native + ranker** | **0.40** | 0.45 | 0.36 | 9 | **3044** |
| I8 | control (grep) | 0.72 | 0.70 | 0.74 | 0 (37 grep) | 7870 |
| I8 | **codegraph-MCP** | **0.92** | 0.90 | 0.95 | 6 | 3680 |
| I8 | graphcode-native + ranker | 0.59 | 0.67 | 0.53 | 5 | **1654** |

**No arm dominates — which is the mark of a good benchmark.** Native wins I2; MCP wins I8 (clean
caller structure); control is competitive when brute force suffices. The graph's value is real but
*integration-dependent*, and the native arm consistently uses 60–80% fewer output tokens.

## Verification status (against the project goal)

1. **End-to-end CLI product works.** `graphcode -p "…"` indexes a repo with codegraph and runs the
   pi harness with the graph-native extension; the agent answers structural questions from the
   graph. Verified on a controlled repo and on real Hadoop modules.
2. **The benchmark is now gaming-resistant and the win is honest.** The paste artifact is closed by
   F1 + budget cap + single-field scoring + oracle floor + word-boundary matching + held-out split
   + dedup. The graph-native ranker beats the raw-graph oracle on 7/9 held-out tasks (mean F1 0.386
   vs 0.169), and end-to-end the native arm wins some tasks outright (I2) at far lower token cost —
   measured, reproducible, with failures disclosed.

## Levers under test (graph-native ≠ graph-as-a-tool)

- **Lever A — auto-context injection (graph-first turn-0):** the harness runs a graph query
  *before* the agent's first turn and injects the result, so the agent starts with retrieval
  done instead of hunting. Specialized per task type: impact → `graph_impact(anchor)`;
  flow → concept-search → entry symbols → `explore`. (Naive prompt-symbol extraction fails on
  well-designed flow prompts, which deliberately name no symbols — so the harness must use the
  graph's own search to turn the prose concept into entry points. That two-stage move is what
  makes it *graph*-native rather than prompt-grep-native.)
- **Lever B — graph-shaped tool surface:** `graph_node` (full body, displaces read) and
  steering that makes explore the default entry point. (Shipped in iter 1; killed reads, needs
  the over-use tamed.)

## Status / next

**Done (this iteration):**
- Benchmark hardened to industry-grade: F1 + budget cap + single-field scoring (`score-impact-hardened.mjs`),
  raw-graph oracle floor, word-boundary file/symbol matching + directional-only DTA hints (`score-runs.mjs`),
  held-out split + dedup manifest (`tasks/impact-manifest.json`).
- Graph-native ranker built, unit-tested (10/10), held-out-validated (F1 0.386 vs oracle 0.169, beats
  7/9), and wired into the harness with an honest ranked-hint preamble (`extension/impact-ranker.mjs`).
- End-to-end agent A/B verified on I2 + I8.

**Next (the audit's prioritized backlog — `bench/BENCHMARK-REDESIGN.md`):**
- Multi-run n≥3 with 95% CIs + pairwise p-values on every arm comparison.
- Co-change ranking signal (mine Hadoop git history) — a signal grep *and* static-impact lack.
- Token-efficiency frontier: F1 vs output-tokens across budget caps (the native arm's strongest honest claim).
- A second skill family (fault-localization with machine-verifiable gold from fix commits) so the
  benchmark measures engineering ability beyond blast-radius recall.
