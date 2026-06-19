# Graph-Native Coding Agent — Impact-Analysis Benchmark

A graph-native coding-agent harness for **code-impact analysis** (predicting the blast
radius of a method change) and the benchmark that evaluates it against two baselines:
a tool-free agent and the same model with the code graph attached via MCP.

The full write-up is the paper in [`bench/report/graphcode-report.pdf`](bench/report/graphcode-report.pdf).

## What's here

```
extension/    the graph-native capability
  impact-ranker-v2.mjs        structural ranker (the shipped ranking function)
  impact-ranker-v2.test.mjs   unit tests (24, run with `node`)
  impact-ranker.mjs           earlier ranker (kept for reference)
  codegraph.ts                the pi graphcode extension

harness/
  graphcode-runner.mjs        turn-0 retrieval + ranked-shortlist injection
                              (draft-then-refine); the graph-native arm runner

bench/        evaluation suite
  validate-ranker-v2.mjs      held-out offline validation of the ranker
  score-impact-hardened.mjs   gaming-resistant F1 scorer (budget top-20, oracle floor)
  token-efficiency.mjs        F1-per-output-token frontier
  run-native-v2-matrix.sh     drives the graph-native arm over the held-out tasks
  RESULTS.md                  end-to-end results writeup
  report/graphcode-report.{tex,pdf}   the paper
```

## The approach (one paragraph)

The dependency graph is the agent's **primary retrieval surface**, not an optional tool.
Before the agent's first turn, the harness runs reverse-reachability ("impact") and
one-hop ("callers") queries for the changing symbol, then **ranks** the high-recall /
low-precision blast radius by structural signal — reference density, direct-caller
adjacency, type-name (implementor) match, and package locality — while **demoting test
files** (40–55% of any Java blast radius, never the answer). The agent receives a clean,
test-free, tier-segmented shortlist with a **pre-drafted high-confidence answer to
refine**, not a flat list to reason over from scratch.

## Key results (held-out, never-tuned split; F1 at budget top-20)

| | Control | CodeGraph-MCP | Graph-native |
|---|--:|--:|--:|
| Mean impact F1 | 0.57 | 0.61 | **0.70** |
| Mean output tokens | 5532 | 3695 | **2995** |

Ranking in isolation lifts held-out F1 from **0.169** (raw static blast radius) to
**0.519**, beating the oracle floor on all held-out tasks. No arm dominates every task,
which keeps the benchmark discriminative. These tasks measure **retrieval, not code
synthesis** — see the paper's Threats to Validity.

## Running

```bash
# unit tests for the ranker
node extension/impact-ranker-v2.test.mjs

# held-out offline validation (requires the codegraph CLI + an indexed repo)
node bench/validate-ranker-v2.mjs --ranker ../extension/impact-ranker-v2.mjs
```

## Update — multi-run robustness + 4th arm (potpie)

A follow-up pass hardened the evaluation and added a fourth comparison point. New artifacts:

- **`harness/graphcode-claude-runner.mjs`** — re-homes the graph-native arm onto the **Claude
  subscription** (`claude -p`, no API key). All arms now run on the *same* gateway, removing the
  pi/`civitas` confound in the earlier results.
- **Multi-run CIs** (`bench/score-matrix-ci.mjs`): 3 arms × 3 impact tasks × n=3, hardened F1.
  Aggregate mean F1 **graph-native 0.79 vs plain 0.56 vs graph-MCP 0.50**; graph-native is the
  cheapest arm on every task (0 read / 0 grep). On the `Resource` hub the MCP arm **collapses to
  0.07** (it has the graph but under-ranks a 982-file firehose); graph-native scores 0.56.
- **potpie graph-engine comparison** (`bench/score-potpie-graph.mjs`): potpie's raw name-reference
  blast radius (held-out F1 0.383) out-recalls codegraph's raw `impact` (0.169), but codegraph's
  **v2 ranker (0.519) beats both raw graphs** — the ranking layer is the win. potpie's *agent* layer
  needs a paid API key and a multi-service Docker stack (can't run on a subscription).
- **co-change ranker signal** (`extension/impact-ranker-v3.mjs`, `bench/mine-cochange.mjs`): mines
  git history for files that change together with the anchor. **Honest negative result** — a real
  signal, but neutral-to-negative at top-20; shipped as an opt-in at neutral weight, not a win
  (`bench/COCHANGE-FINDING.md`).

Full write-up: **`bench/ROBUSTNESS-REPORT.md`**. Visual report (figure-driven):
**`bench/report/graphnative-visual.pdf`** (regenerate figures with `bench/report/make-figs.py`).
Benchmark design + discovered environment constraints: `bench/BENCHMARK-4ARM-DESIGN.md`.
Concrete per-arm transcript case studies: `bench/CONCRETE-EXAMPLES.md`.

```bash
# reproduce the multi-run matrix score (after running the matrix)
node bench/score-matrix-ci.mjs --tasks I1,I8,I10 \
  --arms control,codegraph,graphcode-native-claude --runs 101,102,103 --budget 20
# potpie graph vs codegraph impact on the same gold
node bench/score-potpie-graph.mjs --budget 20
# co-change ranker (honest negative): build cache, then validate held-out
node bench/mine-cochange.mjs --all
node bench/validate-ranker-v3.mjs --ranker ../extension/impact-ranker-v3.mjs --diag
```
