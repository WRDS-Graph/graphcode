# Robustness of the graph-native harness — 4-arm comparison

**Question.** Is a *graph-native* coding-agent harness more robust than (a) a plain agent, (b) the
same agent with a code graph attached over MCP, and (c) potpie — a separate code-graph product?
And *why/how* does graph-native win when it wins?

**One-line answer.** On a single clean gateway (Claude subscription) with n=3 + 95% CIs, the
**graph-native harness wins all three impact tasks** (aggregate mean F1 **0.79** vs **0.56** plain vs
**0.50** graph-MCP) **and is the cheapest arm on every task** (0 read/grep). The advantage is real
but *budget- and structure-shaped*: a blowout on hub anchors where ranking a huge blast radius is the
bottleneck (I1: 0.56 vs MCP's collapse to 0.07), a narrow edge on clean caller trees (I8: 0.82 vs
0.77). It comes from **harness-level moves** (query + rank the graph *before* the agent's first
token), not a better tool — all arms reach the same index. potpie's *graph* is competitive on raw
recall (0.383 > codegraph's raw 0.169) but its *agent* can't run without an API key, and codegraph's
*ranker* (0.519) beats both raw graphs — the ranking layer, not the raw graph, is the win.

---

## 1. Systems under test

| Arm | What it is | Gateway | Runs here? |
|---|---|---|---|
| **plain** (`control`) | agent, Read/Grep/Bash only, no graph | `claude -p` (subscription) | ✅ |
| **graph-MCP** (`codegraph`) | same agent + codegraph MCP server (graph-as-a-tool) | `claude -p` | ✅ |
| **graph-native** (`graphcode-native-claude`) | harness: **turn-0 v2-ranked auto-context injection** + **graph-first system prompt** + codegraph MCP to verify with | `claude -p` | ✅ (re-homed this work) |
| **potpie** | separate product: Neo4j CALLS/IMPORTS graph + LLM agents | graph layer: Cypher (no LLM); agents: need API key | ⚠️ graph-layer only |

**The graph engine under all of arms 2–4's codegraph usage is the same** (`codegraph`,
tree-sitter→SQLite, indexed once over Hadoop's 14,574 files / 472k nodes / 647k edges). potpie uses
its *own* Neo4j graph — so the potpie comparison is graph-engine-vs-graph-engine on identical gold.

### Methodological upgrade over the prior results

The original RESULTS.md ran the native arm on the **pi/`civitas`** gateway while control/codegraph
ran on the **Claude subscription** — a confound (different harness *and* different model gateway).
This work **re-homes the graph-native harness onto the same `claude -p` invocation** the other arms
use (`scripts/lib/graphcode-claude-runner.mjs`), so the four arms differ *only* in harness wiring —
the actual independent variable. It also runs on the user's **Claude subscription, no API key**
(`claude` OAuth), confirmed end-to-end.

---

## 2. The two harness levers (what makes it "native", quoted from source)

**Lever A — turn-0 auto-context injection.** Before the agent's first token, the harness runs
`codegraph impact <anchor>` + `codegraph callers <anchor>`, ranks the union with the **v2 structural
ranker**, drops test files, and injects a tier-segmented *draft-to-refine* preamble. Measured live:
for FSNamesystem the harness produced 387 ranked candidates → 84 non-test → 53 high-confidence,
top-ranked `NameNodeRpcServer (147 refs)`, `BlockManager (49)`, `NameNode (48)` — the genuine
production dependents — in ~5 s, as an 8.3 KB preamble.

**Lever B — graph-first surface.** The arm attaches the codegraph MCP server (so the agent has
`codegraph_*` tools to *verify* with) plus a system prompt making the graph the primary retrieval
surface ("treat returned source as already-read; don't grep to reconstruct").

Neither lever changes the model or the tool; both relocate *retrieval + ranking* out of the model's
context and into deterministic harness code.

---

## 3. The structural ranker — the unfakeable core (reproduced)

The graph-native edge that survives adversarial scrutiny is the ranker, validated **offline,
held-out, gold-blind** (no agent, no LLM — so nothing to game):

| | raw-codegraph-impact oracle | ranker v1 | **ranker v2** |
|---|--:|--:|--:|
| held-out mean F1 (n=9, never tuned) | 0.169 | 0.386 | **0.519** |
| beats oracle floor | — | 7/9 | **9/9** |

Reproduced from cache this session, both versions. **v2 (0.519, 9/9) is a real improvement over the
v1 (0.386) that RESEARCH.md still headlines** — the ranker converts codegraph's high-recall/
low-precision blast radius (recall 1.0, precision 0.06 — 407 files for a 25-file change) into a
budget-bounded shortlist that beats the raw-graph floor on *every* held-out task. The win is a
**harness/ranking** win, not a tool win: the MCP arm calls the same `codegraph_impact` and does not
get this, because it must rank the firehose in-context.

### Tested-and-rejected: a co-change signal (honest negative result)

The top backlog item — a git-history **co-change** signal ("what grep and static-impact both lack")
— was built (`mine-cochange.mjs`, `impact-ranker-v3.mjs`) and validated. It is a *real* signal
(diag: it promotes true low-static-edge gold like `dfsoutputstream`, `datastreamer`,
`namenoderpcserver` into the top-20) but at the headline budget (top-20) it is **neutral-to-negative**
— a weight sweep never beats v2's 0.519 (best case ties; higher weights hurt). v2's static top-20 is
already saturated with correct dense dependents, so co-change's unique finds get crowded out rather
than replacing wrong picks. **Shipped as a documented opt-in at neutral weight, not a win** (see
`COCHANGE-FINDING.md`). This is the same discipline that retracted the earlier "0.80" artifact.

---

## 4. Why/how graph-native wins — three concrete case studies (real transcripts)

(Full evidence + committed file lists in `CONCRETE-EXAMPLES.md`.)

- **I2 FSNamesystem (native wins a deep hub):** plain grep-stormed (28 greps, 35 files,
  over-enumerated noise); graph-MCP was terse (10 calls, 16 files, *under*-enumerated, missed
  `FSImage`/`BackupImage`/`SecondaryNameNode`); native used 0 read / 0 grep and committed 24 files —
  found what MCP missed, excluded what plain over-included. **Fresh subscription run (this work):
  native F1 0.62, 0 read, 0 grep, $0.51 — vs raw-impact oracle 0.27 (2.3× the floor).**
- **I8 AbfsClient (clean caller tree — the close case):** `appendSASTokenToQuery` has a shallow,
  clean caller graph; in the *n=1 pi-gateway* transcripts graph-MCP won (0.92) with native a close
  0.82 and the arms near-tied. **Under the n=3 confound-free redo (§5) this flips to a narrow native
  win (0.82 vs 0.77)** — the arms genuinely cluster here, which is the honest "no blowout on clean
  structure" finding (and why per-task winners need CIs, not n=1).
- **F1/F3 flow tasks (efficiency story):** graph-MCP reached the same answer as plain with 41–44%
  fewer output tokens and 35% fewer cached tokens (3 explore calls vs 11 reads).

**Pattern (confirmed under CIs in §5):** native's advantage is *largest* where the difficulty is
*ranking a large blast radius* (hub anchors — I1, where MCP collapses); *smallest* where the 1-hop
caller graph is *clean and complete* (I8, arms cluster); plain is competitive only where brute-force
grep over small clean structure suffices (and always over-enumerates + costs most).

---

## 5. Robustness: multi-run CIs (this work's core experiment)

Closes the original n=1 threat. Arms × tasks × **n=3**, hardened F1 @ top-20, mean ± 95% CI, single
`claude -p` gateway.

All arms on the same `claude -p` gateway. F1 @ top-20, mean ± 95% CI (Student-t), n=3.

**I1 — Resource (YARN-11964, gold=25; a hub anchor, 982-file raw blast radius):**

| Arm | mean F1 ± 95% CI | per-run | prec | rec | out-tok | cost | g/r/grep |
|---|---|---|--:|--:|--:|--:|---|
| **graph-native** | **0.56 ± 0.06** | [0.58,0.53,0.58] | 0.63 | 0.51 | 4,352 | **$0.273** | 7/0/0 |
| plain (control) | 0.27 ± 0.11 | [0.27,0.22,0.31] | 0.30 | 0.24 | 7,524 | $0.526 | 0/4/13 |
| graph-MCP (codegraph) | 0.07 ± 0.06 | [0.09,0.09,0.04] | 0.08 | 0.07 | 3,487 | $0.384 | 7/0/1 |
| raw-impact oracle | 0.00 | — | — | — | — | — | (982-file firehose) |

**Robust, non-overlapping-CI win for graph-native on I1.** Native (0.56±0.06) vs control (0.27±0.11)
vs MCP (0.07±0.06) — CIs don't overlap, so this is a real separation, not run-to-run noise. Native
is ~2× control, ~8× MCP, beats the raw oracle (0.00 capped), is the **cheapest** arm ($0.27), and
does **0 read / 0 grep**. It reproduces tightly ([0.58,0.53,0.58]), confirming the n=1 RESULTS.md
value (0.58). **The MCP arm collapses (0.07)** — the canonical "under-enumerate the hub" failure: it
made 7 graph calls but committed too few/wrong files, because it must rank a 982-file firehose
in-context. Graph-native, handed the same graph pre-ranked as a draft, avoids that. This is the
sharpest single demonstration of *why graph-native > graph-MCP*.

**I8 — AbfsClient (HADOOP-19917, gold=19; a CLEAN, shallow caller tree):**

| Arm | mean F1 ± 95% CI | per-run | prec | rec | out-tok | cost | g/r/grep |
|---|---|---|--:|--:|--:|--:|---|
| **graph-native** | **0.82 ± 0.00** | [0.82,0.82,0.82] | 0.80 | 0.84 | **2,370** | **$0.281** | 6/0/0 |
| graph-MCP (codegraph) | 0.77 ± 0.00 | [0.77,0.77,0.77] | 0.75 | 0.79 | 3,345 | $0.384 | 5/0/0 |
| plain (control) | 0.74 ± 0.29 | [0.67,0.67,0.87] | 0.72 | 0.75 | 5,405 | $0.567 | 0/2/28 |
| raw-impact oracle | 0.36 | — | — | — | — | — | (143-file firehose) |

**On clean structure all three arms cluster tightly (0.74–0.82); graph-native still edges ahead.**
Three robustness points: (1) **the n=1 RESULTS.md had MCP winning I8 (0.92 vs native 0.82); at n=3
on the confound-free gateway the order flips to native 0.82 ≥ MCP 0.77** — removing the pi/civitas
confound changed the winner, which is exactly why the multi-run + single-gateway redo matters.
(2) **Native and MCP have ZERO run-to-run variance here (±0.00)** while **plain is high-variance
(±0.29)** — grep-storming is luck-dependent; the graph arms are stable. (3) Native is again the
**cheapest** ($0.28) and leanest (2,370 out-tok) with 0 read/grep. The graph *margin* is small on a
clean caller tree (vs the blowout on I1's hub) — a coherent, honest pattern, not a sweep.

**I10 — AbfsOutputStream (HADOOP-19902, gold=10):**

| Arm | mean F1 ± 95% CI | per-run | prec | rec | out-tok | cost | g/r/grep |
|---|---|---|--:|--:|--:|--:|---|
| **graph-native** | **1.00 ± 0.00** | [1.00,1.00,1.00] | 1.00 | 1.00 | **2,195** | **$0.306** | 8/0/0 |
| graph-MCP (codegraph) | 0.67 ± 0.00 | [0.67,0.67,0.67] | 0.50 | 1.00 | 3,478 | $0.389 | 6/0/0 |
| plain (control) | 0.67 ± 0.00 | [0.67,0.67,0.67] | 0.50 | 1.00 | 6,330 | $0.709 | 0/2/29 |
| raw-impact oracle | 0.47 | — | — | — | — | — | (37-file firehose) |

**Clean native sweep (1.00 ± 0.00, perfect across 3 runs).** Plain and MCP both tie at 0.67 — both
hit recall 1.0 (found all 10 gold) but **precision 0.50** (padded with false positives); only the
native arm's pre-ranked draft delivered precision 1.0 *and* recall 1.0. Non-overlapping CIs.

## 5.1 Aggregate — the complete robustness picture (n=3, single gateway)

| Arm | I1 (hub) | I8 (clean) | I10 | **mean-of-means** | always cheapest? |
|---|--:|--:|--:|--:|:--|
| **graph-native** | **0.56±.06** | **0.82±.00** | **1.00±.00** | **0.79** | ✅ ($0.27–0.31) |
| plain (control) | 0.27±.11 | 0.74±.29 | 0.67±.00 | 0.56 | — ($0.53–0.71) |
| graph-MCP (codegraph) | 0.07±.06 | 0.77±.00 | 0.67±.00 | 0.50 | — ($0.38–0.39) |
| raw-impact oracle | 0.00 | 0.36 | 0.47 | 0.28 | n/a |

**Findings (all hold under multi-run CIs):**

1. **Graph-native wins all three tasks on mean F1** — non-overlapping CIs vs the runner-up on I1 and
   I10, a tight edge on I8. Aggregate **0.79 vs 0.56 (plain) vs 0.50 (MCP)**. It beats the raw-impact
   oracle on every task (the floor any graph arm must clear).
2. **Cheapest arm everywhere** ($0.27–0.31 vs plain's $0.53–0.71) with **0 read / 0 grep** on all
   three tasks — the "better *and* cheaper" dual win survives CIs.
3. **The margin is predictable from task structure** — the benchmark is discriminative, not a sweep
   of a rigged metric: *huge* native margin on the hub (I1: 0.56 vs MCP 0.07, where ranking a
   982-file firehose is the whole problem and **MCP collapses by under-enumerating**); *small* margin
   on a clean caller tree (I8: 0.82 vs 0.77, where every arm does well).
4. **Consistency is itself a robustness axis.** The graph arms are near-deterministic (±0.00 on I8/
   I10); **plain is high-variance** (I8 ±0.29 — grep-storm luck). Lower variance at higher mean is
   the practically valuable combination.
5. **The confound-free redo *strengthened* the native case.** vs the original pi/civitas-gateway,
   n=1 RESULTS.md (native 0.70 vs MCP 0.61): on a single `claude` gateway with n=3, the aggregate gap
   widened to **0.79 vs 0.50**, and I8 — an MCP win in the original — flipped to a narrow native win.
   Removing the gateway confound did not erode the result; it sharpened it.

### Why graph-native > graph-MCP (the mechanism, now measured under CIs)

Both arms reach the *same* codegraph index and both call `codegraph_impact`. The difference is
**when and how the blast radius gets ranked**. The MCP arm must rank a firehose *in-context, mid-
reasoning*, and on a hub it stops early and under-commits (I1: 0.07). The native harness ranks the
firehose *in deterministic code before turn 0* (v2 ranker: test-demotion + density + additive
direct-caller + name-match → held-out F1 0.519) and hands the agent a clean draft to refine — so the
agent realizes the ranker's precision instead of re-deriving it. **The win is the relocation of
ranking from the model's context into the harness, not a better tool or model.**

---

## 6. The potpie arm

### Operability finding (the first robustness result about potpie)

potpie's **agent layer requires a real LLM API key** (OpenAI/Anthropic) — it **cannot run on a
Claude subscription**. Its **full stack** is also heavy (Docker: Postgres + Neo4j + Redis + Celery +
a parse pass). By contrast codegraph is a single zero-dependency local binary that runs the whole
graph-native arm on the subscription. So at the **deployment** level, in this environment, the
graph-native/codegraph arms are runnable end-to-end and potpie's agent is not — a real robustness
gap, honestly the most decision-relevant potpie result.

### Graph-engine comparison (what IS runnable): potpie's graph vs codegraph's `impact`

We stood up potpie's graph layer LLM-free (standalone Neo4j + potpie's own tree-sitter Java parser
run directly — "rung 2" of a documented fallback ladder): **10,900 Java files parsed in 18 s**,
13,861 class defs, 146k referenced names. For each anchor we took potpie's blast radius (files that
**reference the anchor class name** — potpie's undirected REFERENCES view) and scored it against the
same PR gold with the same hardened F1 @ top-20:

| | held-out mean F1 @ top-20 (n=9) |
|---|--:|
| codegraph raw `impact` (directed reverse-reachability) oracle | 0.169 |
| **potpie graph (undirected name-reference) oracle** | **0.383** |
| **codegraph + v2 RANKER (the graph-native arm's retrieval)** | **0.519** |

**Three honest takeaways:**
1. **potpie's raw graph (0.383) beats codegraph's raw `impact` oracle (0.169)** at top-20 — a real,
   creditable result for potpie's graph *recall* (it wins 7/12 anchors head-to-head: I2, I3, I6, I8,
   I10, I13, I14).
2. **But codegraph's v2 ranker (0.519) beats BOTH raw oracles.** The graph-native win is the
   **ranking/harness layer**, not the raw graph. potpie ships no ranker over its graph — that job is
   delegated to its LLM agents, which need the API key we don't have. The clearest case is **Resource
   (I1): potpie's 603-file unranked set scores F1 0.00 at top-20, while codegraph's v2-ranked
   graph-native agent scores 0.56** — same class of graph data, but ranking is decisive.
3. **Methodology caveat (disclosed, not hidden):** potpie's number is favorable to it here — its
   "any file mentioning the name" is *undirected* (higher recall, lower precision than a directed
   who-calls-me query), and we capped its unranked, alphabetically-sorted set at top-20. On anchors
   where its set is huge and unranked (Resource 603, Clock 97, HttpServer2 76) the top-20 misses
   (F1 0.00). A directed or relevance-ranked potpie query would trade recall for precision; we did
   not build one (that is potpie's agents' job). So "potpie graph 0.383 > codegraph impact 0.169" is
   a statement about *raw recall at a cap*, while "codegraph ranker 0.519 > both" is the statement
   about *delivered retrieval quality* — which is what the agent actually consumes.

Reproduce: `node bench/score-potpie-graph.mjs --budget 20`. potpie blast-radius cache:
`bench/.potpie-cache/<Anchor>.json`.

---

## 7. Threats to validity (honest)

- **Construct: retrieval, not synthesis.** Deliverable is a ranked dependent-file list, not a diff.
  The draft-to-refine mechanism is partly self-fulfilling. (The clear next step — a commit-verified
  coding-task family scored by test-pass/hunk-overlap — remains future work.)
- **External:** one Java repo (Hadoop). Structural signals (density, caller adjacency, type-name
  inheritance, package locality) reflect general dependency-graph + JVM conventions; cross-language
  generalization unmeasured.
- **potpie:** compared at the graph layer only (agent layer blocked by the API-key constraint), and
  on whatever scope its parser ingested — not necessarily full Hadoop.

---

## 8. Artifacts produced this session

- `scripts/lib/graphcode-claude-runner.mjs` — graph-native harness on the Claude subscription (removes pi confound).
- `bench/BENCHMARK-4ARM-DESIGN.md` — design + discovered constraints.
- `bench/CONCRETE-EXAMPLES.md` — quote-heavy case studies from real transcripts.
- `bench/mine-cochange.mjs`, `extension/impact-ranker-v3.mjs`, `bench/validate-ranker-v3.mjs`, `bench/COCHANGE-FINDING.md` — co-change signal (honest negative).
- `bench/score-matrix-ci.mjs` — multi-run CI scorer.
- `bench/run-4arm-matrix.sh` — the matrix runner.
- `bench/.cochange-cache/`, `.potpie-cache/` — mined signals / potpie graph output.
