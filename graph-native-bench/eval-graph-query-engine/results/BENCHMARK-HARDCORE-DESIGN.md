# Hardcore multi-task benchmark with LLM-as-judge — design

**Goal.** Escalate from retrieval-F1 to **hard, diverse tasks where the deliverable is reasoning/
work**, and score **quality with an independent `claude -p` judge** (rubric-based, blind), not set
overlap. Compare the three harnesses (plain / graph-MCP / graph-native) on real cognitive load.

## Why this is harder than the prior benchmark
The 3-harness oracle scored *file-list F1* — a retrieval proxy. These tasks require the agent to
**produce a correct artifact** (a plan, a diagnosis, a safety judgement, an explanation, a migration)
where correctness is multi-dimensional and not a set. Only an LLM judge (or a human) can grade them.

## The hardcore task set (6 tasks, 6 different *kinds* of work)

| # | Task kind | Prompt deliverable | What makes it hard | Graph that should help |
|---|---|---|---|---|
| **H1** | **Refactor plan** | a step-by-step plan to split a god-object, with blast radius + ordering + risk | must know *all* dependents and pick a safe seam | ref-graph in-degree + ranked impact |
| **H2** | **Bug root-cause + fix** | root cause of a real open issue (#9 zoom-reset) + the minimal fix + the consumers to re-test | must trace state→render→viewport across files | call graph + state edges |
| **H3** | **Dead-code safety call** | for 5 "uncalled" symbols, decide DELETE vs KEEP with justification (dispatch traps!) | the syntactic-dead-code false positives (React closures, Flask routes) | ref graph + name-ref cross-check |
| **H4** | **Data-flow explanation** | trace how an `/api/search` request flows to a ranked result, naming every hop | deep cross-module + frontend↔backend path | call+import forward closure |
| **H5** | **Security audit** | find the most dangerous sink reachable from untrusted input + the exploit precondition | the `pickle.load` sink is 2 hops deep, import-mediated | call∪import reachability |
| **H6** | **API-change migration** | "we're changing `loadPaperGraph`'s signature — list every call site + the exact edit each needs" | must find all callers incl. indirect, and reason per-site | call graph reverse + read |

Each task is run by all 3 arms. Same model, same budget.

## LLM-as-judge protocol (bias-controlled)

1. **Blind.** The judge sees the task + rubric + an answer labeled only `A`/`B`/`C` — never which
   harness produced it.
2. **Rubric per task.** 4 weighted criteria, 0–10 each, defined up front (in tasks-hardcore.json).
   Judge returns strict JSON `{scores:{...}, total, reason}`.
3. **Panel + swap to reduce position/verbosity bias.** Score each answer (a) independently with an
   absolute rubric, and (b) cross-check with a pairwise pass where answer order is swapped. Use the
   absolute rubric score as the headline; report pairwise as a robustness check.
4. **Judge ≠ competitor.** The judge is a fresh `claude -p` with no tools and no repo access — it
   grades the *text*, so it can't favor a harness it doesn't know about.
5. **Disclose judge limits.** LLM judges have length/confidence bias; we mitigate (blind, rubric,
   swap) but report it as a threat to validity, not a solved problem.

## Metrics
- **Quality:** mean rubric total (0–10) per arm per task, + per-criterion breakdown.
- **Cost:** USD, output tokens, turns (from `claude -p` usage).
- **Quality-per-dollar:** the production-relevant ratio.
- **Agreement:** absolute-rubric vs pairwise-swap winner (judge self-consistency).

## Honesty rails
- Tasks where the graph *shouldn't* help (H2 if the bug is single-file) are kept in — a benchmark
  where the graph always wins is rigged.
- n is small (1 run/arm/task here; judge panel adds replicates). Directional.
- The graph-MCP arm is run live this time (not modeled), closing the prior oracle's gap.
