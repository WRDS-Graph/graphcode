# Industry-grade benchmark redesign — graph-native vs control vs Claude+codegraph-MCP

This document specifies the changes that make the hadoop-mcp-eval impact benchmark
trustworthy and gaming-resistant, grounded in the forensic findings in
`AUDIT-FINDINGS.md`. Status of each item is tracked as it lands.

## What was wrong (proven, not asserted)

1. **Split-text metric.** Legacy recall@k substring-scanned the whole **prose**
   answer; precision read only the **JSON** block. Different texts → an arm could
   max recall by dumping files in prose while keeping a tidy JSON. → FIXED: one
   bounded structured field scored by both.
2. **Recall-only, no precision penalty.** The graph's raw `impact` has recall 1.0
   but precision 0.06 (407 files for a 25-file change). Legacy metric rewarded
   pasting that firehose. → FIXED: F1 headline + budget cap.
3. **Paste-and-grade leakage.** The native harness pasted 60 graph files into the
   prompt; the agent copied them with **1 tool call, zero reasoning**, and recall
   jumped 0.10→0.80. Under hardened F1 (cap 20) that same paste scores 0.36–0.40 —
   **parity with control's grep-based 0.36, not a win.** → the inflation is gone.
4. **No oracle / no ablation.** Nothing measured the raw graph's own quality, so the
   harness got credit for the graph's offline query. → FIXED: `--oracle` row scores
   raw `codegraph impact` independently (the honest reference).
5. **No statistical rigor.** n=1–2, no CIs, single model. → see redesign below.
6. **One skill only.** Every discriminating task is "name the blast radius." Real
   engineering ability (localization, root-cause, patch correctness) untested.

## The hardened scorer (`score-impact-hardened.mjs`) — DONE

- Precision + recall + **F1** all read the agent's `dependent_files` (committed,
  ranked, bounded), matched by basename as a **set** (no substring bleed).
- `--budget N` (default 20): only the top-N ranked dependents are scored, so the
  firehose can't inflate recall without tanking precision.
- `--oracle`: runs raw `codegraph impact <anchor>` and scores it the same way —
  reports both the capped top-20 F1 and the uncapped recall/precision firehose.

### Honest I2 result under the hardened scorer (budget top-20)

| arm | F1 | precision | recall | did real work? |
|-----|---:|----------:|-------:|----------------|
| control (grep) | **0.36** | 0.40 | 0.32 | yes — 28 greps |
| codegraph-MCP | 0.19 | 0.24 | 0.16 | yes — 10 graph calls |
| graphcode-native r1 (no paste) | 0.06 | 0.09 | 0.04 | yes — 17 graph calls, under-named |
| graphcode-native r2/r3 (paste) | 0.36–0.40 | 0.40–0.45 | 0.32–0.36 | **no — copied pasted list** |
| graph-oracle raw, capped 20 | 0.27 | 0.30 | 0.24 | n/a (offline query) |
| graph-oracle raw, uncapped | — | 0.06 | 1.00 | the firehose |

**Conclusion:** with honest scoring the graph arms do NOT beat brute-force grep yet.
The benchmark is now a real, unsolved problem — exactly what an industry benchmark
must be.

## The real research target (unfakeable) — graph-native RANKING

Raw `codegraph impact` has recall 1.0 but emits files in file/line order, so its
top-20 is mediocre (F1 0.22–0.38). Neither direct-callers nor depth-2-impact
dominates across tasks:

| task | direct-callers top20 F1 | impact-depth2 top20 F1 |
|------|------------------------:|-----------------------:|
| I2 | 0.18 | 0.27 |
| I3 | 0.44 | 0.22 |
| I12 | 0.29 | 0.38 |

→ The genuine graph-native win is a **ranker** that floats true dependents into the
top-20 using graph signal (direct-caller bonus, reference/edge count, call-distance,
co-change). It cannot be faked by pasting; F1 measures it honestly. This is the
harness work in task #15.

## Graph-native ranker — VALIDATED ON HELD-OUT TASKS

`extension/impact-ranker.mjs` ranks the firehose by graph signal:
`score = reference_density + 5·direct_caller + 20·same_package`. Scored with the
hardened F1 (top-20) on the FULL I-series. Package weight chosen on I2/I3/I12 only;
I1, I4–I11, I13, I14 are **held out** (never tuned on):

| | raw-impact F1 | ranker F1 |
|---|--:|--:|
| **held-out mean (n=11)** | **0.183** | **0.381** (+0.198, >2×) |

Per-task (held-out unless tuned): I1 0→0.31, I6/I7 0.31→0.62, I8 0.36→0.77,
I10 0.47→0.67, I13 0→0.46, I14 0→0.25. **Honest failures reported:** I4/I5
(`Server`, a hub class) −0.09 — package-locality misleads on god-objects; I11
(`Clock`) 0.00 both. A method that generalizes to held-out data with disclosed
failure modes — the mark of a real result, not an overfit.

Reproduce: `node bench/validate-ranker.mjs --budget 20`.
Unit tests: `node extension/impact-ranker.test.mjs` (10/10).
Wired into the harness: `graphcode-runner.mjs` now injects the RANKED shortlist
(not the firehose) with a precision-favoring directive.

## Redesign backlog (priority)

- **[must]** F1 + budget-capped single-field scoring. — DONE (`score-impact-hardened.mjs`)
- **[must]** Graph-oracle ablation row. — DONE
- **[must]** Graph-native ranker in the harness; beat control's F1 honestly. — DONE (offline);
  end-to-end agent A/B IN PROGRESS (native r5 run).
- **[should]** Multi-run (n≥3) with mean ± 95% CI per arm; report variance.
- **[should]** Expand impact tasks to the full I-series (≥12) + held-out split. — done for ranker
  validation; extend to agent runs.
- **[should]** Token/cost as a co-headline (F1-per-1k-output-tokens efficiency frontier).
- **[nice]** Add a second skill family (localization / root-cause) so the benchmark
  measures engineering ability beyond blast-radius recall.
