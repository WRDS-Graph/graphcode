# Graph-native coding-harness evaluation — Graph-Query-Engine

A rigorous, multi-benchmark evaluation of a **graph-native coding-agent harness** against (a) a
**plain** agent (Read/Grep/Bash) and (b) the same agent with a code graph attached over **MCP**
(graph-as-a-tool), run on a real production codebase: `Graph-Query-Engine` (~24k LOC React/Vite +
Python Flask). All three harnesses run on `claude -p` (Claude subscription, no API key).

This complements the Hadoop evaluation in [`../bench/`](../bench/) (Java) by testing the same thesis
on a TypeScript/Python SaaS codebase, and adds an **LLM-as-judge** quality track.

## Headline

| | plain | graph-MCP | **graph-native** |
|---|--:|--:|--:|
| Hardcore mean quality (LLM-judge, n=6) | 8.35 | 8.70 | **8.97** |
| Quality per dollar | 6.7 | 7.3 | **8.2** |
| Retrieval-oracle mean F1 (n=8) | 0.314 | 0.702 | **0.768** |

**graph-native wins on average and is the most cost-efficient — but no harness dominates every
task.** Graph-as-a-tool (MCP) wins open-ended/search-shaped work (diagnosis, audit); graph-native
wins structured-traversal work (data-flow, migration); plain stays competitive only on thorough-sweep
tasks. *Which graph integration wins is predictable from task structure.* The win mechanism is the
**relocation of retrieval + ranking out of the model's context into the harness**, not a better tool.

## Layout

```
eval-graph-query-engine/
├── report/                 the report (start here)
│   ├── report.pdf          7-page LaTeX report with figures + literal agent traces
│   ├── report.tex          source
│   ├── make_figs.py        regenerates figs/ from the benchmark numbers
│   └── figs/               vector figures (quality, heatmap, cost, retrieval, q/$)
├── results/                the written findings
│   ├── PRODUCTION-RELIABILITY-RESULTS.md   4-task-family reliability scorecard
│   ├── BENCHMARK-3HARNESS-{DESIGN,RESULTS}.md  retrieval oracle + live A/B
│   ├── BENCHMARK-HARDCORE-{DESIGN,RESULTS}.md  6 hardcore tasks, LLM-judged
│   ├── GRAPH-NATIVE-INTEGRATION-PLAN.md     how the harness plugs into the repo's SOP
│   ├── CODE_GRAPH.md / BUILD.md             the target repo's graph + build notes
├── scripts/                the evaluation harness (all Node, pure)
│   ├── impact-ranker.mjs(.test)  v2 structural ranker (test-demotion + density + name-match)
│   ├── cg.mjs                    codegraph JSON wrapper
│   ├── rank-impact.mjs           turn-0 ranked-injection preamble (Lever A)
│   ├── build-syntactic.mjs       export codegraph -> syntactic graph JSON
│   ├── freshness-check.mjs       CI-able drift check vs the hand-written graph
│   ├── score-localization.mjs    raw-vs-ranked file-localization F1
│   ├── oracle-3harness.mjs       deterministic 3-harness retrieval oracle (+ tasks-3harness.json)
│   ├── agent-ab.mjs              live plain-vs-native agent A/B (validates the oracle)
│   ├── run-hardcore.mjs          3 arms x 6 hardcore tasks, blind LLM-judged (+ tasks-hardcore.json)
│   ├── judge.mjs                 blind claude -p LLM-as-judge (system-prompt pinned, fenced data)
│   ├── capture-trace.mjs         full streaming tool-trace capture
│   └── task-demos.mjs            reconstruction / dead-code / security demos
└── runs/                   the evidence
    ├── *.txt                     every arm's answer on every hardcore task (18 files)
    ├── summary.json              judged scores
    └── traces/                   literal captured tool-by-tool agent traces
```

## Reproduce

```bash
# in a checkout of the target repo (Graph-Query-Engine), with codegraph installed:
codegraph init . && node scripts/build-syntactic.mjs
node scripts/oracle-3harness.mjs --budget 15           # 3-harness retrieval oracle
node scripts/agent-ab.mjs PaperGraph --gold production-dependents   # live A/B
node scripts/run-hardcore.mjs                          # 6 hardcore tasks, LLM-judged
npx vitest --run --config scripts/vitest.config.mjs    # ranker unit tests
# rebuild the report:
python3 report/make_figs.py && (cd report && pdflatex report.tex && pdflatex report.tex)
```

## Method integrity (disclosed)

- **Blind LLM-judge** — fresh `claude -p`, no tools/repo, answers fenced as data and labeled A/B/C.
- **A judge bug we caught + fixed** — long code-bearing answers triggered judge refusals (false 0.0);
  fixed via system-prompt role-pinning + fenced data + robust JSON extraction.
- **Honest negatives kept in** — graph-MCP beats native on H2/H5; plain ties on H3/H5. A benchmark
  where the graph always wins would be rigged.
- **Small n** (6 hardcore, 8 oracle tasks, 1 repo, 1 run/arm) — directional, not a population estimate.
- All evaluation was **additive**; no production code in the target repo was modified.
