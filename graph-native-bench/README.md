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
