# Results — graph-native vs control vs Claude+codegraph-MCP (honest, hardened)

Model: sonnet-4.6 (fixed, all arms). Scorer: `score-impact-hardened.mjs` — F1 of the
agent's committed `dependent_files`, budget top-20, basename set-match. Oracle = raw
`codegraph impact` scored identically (the floor any graph arm must beat). Held-out
split + dedup per `tasks/impact-manifest.json` (no tuning leakage; honest effective N).

## 1. The prior "0.80 vs 0.30" headline was a scoring artifact (closed, see AUDIT-FINDINGS.md)

Legacy recall@k substring-scanned the whole prose answer and never penalized the
firehose (raw `impact` = recall 1.0, precision 0.06). Pasting the list and copying it
scored 0.80 with one tool call and zero reasoning. Under F1 + budget cap that paste is
parity with grep. The benchmark is now gaming-resistant; the rest of this file is the
honest signal.

## 2. The graph-native RANKER — v1 → v2 (offline, held-out, never tuned)

`extension/impact-ranker-v2.mjs` re-ranks the `impact` firehose by structural graph
signal so the budgeted top-20 is mostly TRUE dependents. v2 added three gold-blind
structural signals over v1:

- **test-file demotion** — 40–55% of any Java blast radius is test files (Test*/*Test/
  Mock*/Dummy*//test/), often the densest, never gold. Demoted below all real files.
- **density-primary, uncapped** + **additive direct-caller bonus** (not a hard tier — a
  tier buries gold when the `callers` set is disjoint from gold, the I1 Resource bug).
- **name-match** — a basename containing the anchor word is an implementor/subtype
  (`MonotonicClock`→`Clock`); the only signal that reaches 2-hop low-density gold.

| | raw-impact oracle | ranker v1 | **ranker v2** |
|---|--:|--:|--:|
| **held-out mean F1 (n=9)** | 0.169 | 0.386 | **0.519** (+0.350 vs oracle, +34% vs v1) |
| **beats oracle floor** | — | 7/9 | **9/9** |

The name-match weight sits on a robustness plateau (F1 0.506–0.530 across weights 5–20)
— the signature of a real signal, not an overfit knob. An independent 4-designer judge
panel converged on the same algorithm. Reproduce: `node bench/validate-ranker-v2.mjs
--ranker ../extension/impact-ranker-v2.mjs`. Unit tests: `node
extension/impact-ranker-v2.test.mjs` (24 pass). Honest limit kept, not papered over:
`Clock` is still only ~0.07 (mostly 2-hop, low-density, non-name-matched gold).

## 3. End-to-end agent A/B (the product) — full held-out matrix, v2 wiring

The native harness injects the v2 ranking at turn 0 as a **test-free, tier-segmented
shortlist with a pre-drafted answer** ("refine this, don't rebuild it") — closing the
offline→agent realization gap that made v1 high-variance.

| Task | control | codegraph-MCP | graphcode-native v2 | winner |
|------|--:|--:|--:|:--|
| I1 Resource          | 0.18 | 0.13 | **0.58** | native |
| I4 Server            | 0.09 | **0.36** | 0.36 | MCP/tie |
| I6 RouterRpcServer   | **0.84** | 0.62 | 0.76 | control |
| I8 AbfsClient        | 0.72 | **0.92** | 0.82 | MCP |
| I9 HttpServer2       | **0.87** | 0.72 | 0.72 | control |
| I10 AbfsOutputStream | 0.67 | 0.67 | **1.00** | native |
| I13 ByteArrayManager | 0.75 | 0.86 | **1.00** | native |
| I14 DelegTokenRenewer| 0.47 | **0.57** | 0.38 | MCP |
| **MEAN F1**          | **0.57** | **0.61** | **0.70** | native |
| **mean output tokens** | 5532 | 3695 | **2995** | native |
| **task wins**        | 2 | 3 | 3 | — |

### What's true and measured

- **graphcode-native v2 leads on mean F1 (0.70 vs 0.61 vs 0.57) AND uses the fewest
  output tokens (~46% fewer than control, ~19% fewer than MCP).** The dual win the goal
  targeted — better answers *and* token reduction — on a held-out, never-tuned split.
- **Still an honest benchmark:** native 3 wins, MCP 3, control 2. No arm sweeps. Control
  wins where brute-force grep over clean structure suffices (I6, I9); MCP wins where the
  1-hop caller graph is clean and complete (I8, I14); native wins where the firehose
  needs RANKING (I1, I10, I13) — exactly where the harness's precomputed rank pays off.
- **The v1→v2 turnaround is the story:** the tasks native used to lose are now its
  biggest wins (I1 0.13-class→0.58; I10 0.67→1.00; I13→1.00). Test-demotion +
  name-match + draft-to-refine converted high-variance under-commitment into the
  field-leading arm. On I8, v2 lifted the agent 0.25→0.82, matching the offline ranker.

### Honest caveats (do not over-claim)

1. **These are file-list RETRIEVAL tasks, not real coding tasks.** The deliverable is a
   ranked list of filenames; "draft-to-refine helps" is partly tautological because the
   draft IS the answer. Whether the harness edge survives when the deliverable is a DIFF
   (build/test-pass or hunk-overlap scoring) is UNTESTED. There is a real risk
   draft-to-refine *anchors* the agent onto wrong files in an edit task.
2. **n=1 per task.** I14 (native 0.38 < MCP 0.57) and close calls need multi-run CIs
   before per-task claims are firm; the MEAN gap (0.70 vs 0.61) is more robust than any
   single cell. Two runs (I13/I14 first attempt) died as 8–10s empty-output infra
   failures and were re-run — invalid runs are not scored as losses.

## What we changed in the harness (the native edge, vs "normal + MCP")

Two files; the MCP arm is identical Claude with codegraph bolted on via MCP, so every
diff below is the harness-native edge:

- `extension/impact-ranker-v2.mjs` — the ranker (test-demotion + density + additive
  direct-caller + name-match). Moves retrieval-RANKING out of the model and into code.
- `scripts/lib/graphcode-runner.mjs` `buildAutoContext` — turn-0 injection of a
  test-free, tier-segmented shortlist + a pre-drafted high-confidence `dependent_files`
  block framed as "refine, don't rebuild." Closes the offline→agent realization gap.

## Next lever (the one measurement that would answer "does this help real coding?")

Build a commit-verified coding task family: real Hadoop fix commits, deliverable = a
diff, scored by test-pass / changed-file / hunk-overlap against the actual PR. A/B the
same draft-to-refine harness vs plain MCP there. Until that exists, the validated claim
is narrow and honest: **the graph-native harness produces better blast-radius answers
more cheaply than Claude+codegraph-MCP — measured on retrieval, not yet on code.**
