# Graph-native coding system on Graph-Query-Engine — production-reliability benchmark

**Question.** We built a graph-native coding-agent system (codegraph index + a structural ranker
+ harness-level turn-0 injection), benchmarked on Apache Hadoop. **Is it reliable enough to put in
front of a real enterprise SaaS codebase** — does it deliver measurable, trustworthy value across
reconstruction, bug-fix, AI-slop cleanup, and security, *with its failure modes disclosed*?

This is the honest scorecard. Every number below was produced live on this repo (commands in §6).
We report ties and negatives, not just wins — a system you can't trust to tell you when it has *no*
signal is not production-ready.

---

## TL;DR verdict

| Capability | Reliable here? | Evidence |
|---|:--:|---|
| **Index any codebase fast** | ✅ **yes** | 96 files / 1,267 nodes / 5,622 edges in **1.1 s**, TS+TSX+Py+JS, one local binary, no API key |
| **Reconstruction (find hubs)** | ✅ **yes** | in-degree ranking instantly orders god-objects (`lruCache` 468, `paper.ts` 399) — a grep can't |
| **Impact ranking on hubs** | ✅ **yes** | `PaperGraph` firehose (59 files, 52 test): ranker delivers **15/15 production files** in top-15 vs raw **8/15** |
| **Impact ranking on small fan** | ⚠️ **neutral** | issue-localization mean F1 **0.334 raw == 0.334 ranked** (8 ties): no firehose to clean, ranker is a no-op |
| **Bug-fix localization (F1 vs human gold)** | ⚠️ **capped** | 0.33 mean — limited by *syntactic reachability*, not ranking (cross-language gold unreachable by call/import edges) |
| **AI-slop / dead-code** | ⚠️ **needs 2nd filter** | naive call-graph flagged 50, **~26% false positives** from dispatch (React closures, Flask routes); name-ref filter cut to 37 |
| **Security reachability** | ✅ **found a real bug** | traced an untrusted entry to **`pickle.load` (loader.py:112)** — a verified RCE sink — automatically |
| **Knows when it has no signal** | ✅ **yes** | returns "No syntactic impact" on closures instead of hallucinating; security demo prints "no path found" honestly |

**Bottom line for SaaS deployment.** The system is **production-reliable as an *assistive retrieval +
ranking layer*, not as an autonomous oracle.** Its strongest, most dependable wins are exactly the
firehose-shaped tasks (hub refactors, test-noise suppression, blast-radius triage) and
reachability audits (security sink-tracing). Its honest limits are dispatch-heavy code (React
`useCallback`/`@app.route` are invisible to a pure call graph) and small, well-factored modules
(where there's nothing to rank). **The reliability that matters most is met: it does not fabricate —
it reports "no signal" instead of guessing**, which is the property an enterprise can build a
workflow on.

---

## 1. The substrate (honest context)

Graph-Query-Engine: ~24k LOC TS/TSX (79 files) + ~2.7k LOC Python Flask backend, React + Vite +
Cytoscape, a hybrid BM25/vector/graph-PPR retrieval backend. It already practices graph-native
debugging (a hand-written `CODE_GRAPH.md` + a 5-stage SOP) but had **no syntactic graph** (the
documented builder pointed at an absent Windows host). **The repo also ships with 18 pre-existing
failing tests** (its own open issues #5/#6/etc.) — relevant baseline: this is a real, mid-flight
codebase, not a clean lab fixture.

## 2. What "reliable" means here, and where it holds

### 2a. Reconstruction — ✅ dependable
In-degree ranking over the graph orders the coupling hot-spots a refactor must attack first:
```
  1   468   src/data/lruCache.ts
  2   399   src/types/paper.ts
  3   310   src/renderer/graphRenderer.ts
  ...
  8   106   src/state/appState.tsx
```
A purely textual approach can't compute "most depended-on." This is deterministic and re-runs in ms.

### 2b. Impact ranking — ✅ on firehoses, ⚠️ neutral otherwise (the key nuance)
The Hadoop win was **firehose-shaped**: convert a huge, test-polluted blast radius into a clean
shortlist. That win **reproduces on TypeScript** where a firehose exists:

| Anchor | raw blast radius | of which tests | production files in top-15: raw → **ranked** |
|---|--:|--:|---|
| `PaperGraph` | 59 | 52 | 8 → **15** |
| `dataLayer` | 20 | 9 | 11 → 11 (already clean) |
| **mean (firehose hubs)** | | | **9.5 → 13.0** |

But on the **issue-localization** benchmark (8 issues, gold = the maintainers' own `CODE_GRAPH §7`
file index), most anchors have a **1–5 file** blast radius — there is no firehose, so ranking is a
no-op: **mean F1 0.334 raw == 0.334 ranked, 8 ties, 0 regressions.** This is the disclosed truth:
*our ranker's value is proportional to blast-radius size and test-pollution; a well-factored module
gives it nothing to do.* It never *hurt* (0 regressions after the subject-file-seeding fix).

### 2c. Bug-fix localization — ⚠️ capped by syntactic reachability, not by ranking
Mean F1 ≈ 0.33 against human gold. The ceiling is **reachability**: the gold for issue #4 spans
`bm25_path.py` + `vector_path.py` (backend siblings) and a frontend classifier — files no `calls`/
`imports` edge connects to the anchor. **Syntactic graphs cannot see cross-language, sibling-module,
or intent-level coupling** — which is exactly what the hand-written *semantic* `CODE_GRAPH.md`
encodes. The reliable design is **both graphs**: semantic for intent, syntactic for ranked
mechanical enumeration. (We wired the SOP to use them in that order.)

### 2d. AI-slop / dead code — ⚠️ reliable only with a second filter (disclosed false-positive rate)
A naive "no incoming call edge" query flagged **50** symbols. **~26% were false positives** caused by
dynamic dispatch the call graph can't trace:
- `matchAndRank` / `computeOverlay` / `analyzeQuery` have **3 / 7 / 6** real uses but **zero** `calls`
  edges (invoked through React `useCallback` closures + prop-passing).
- Flask `health` / `get_papers` handlers are reached by `@app.route` decorator dispatch.

Adding a **name-reference second filter** (don't flag a symbol whose name appears as any reference)
cut the list to **37** and removed the Flask-handler class of error. The honest rule for production:
**dead-code detection on dispatch-heavy code requires a reference cross-check; the raw call graph
alone is not safe to act on.** The demo prints a "review before deleting" caveat for this reason.

### 2e. Security — ✅ found and verified a real sink
Tracing forward (calls ∪ file-imports) from untrusted backend entry points to risky sinks surfaced:
```
⚠️  SearchIndex (backend/loader.py) reaches: import pickle
```
**Verified:** `backend/loader.py:112` does `state = pickle.load(f)` on a cache file — a classic
**arbitrary-code-execution-on-deserialization** sink if the cache path is attacker-writable. The
graph found it automatically from the entry surface; a manual audit would have to read every
handler. (Pure call-reachability initially found *nothing* because the backend reaches sinks via
*imports*, not direct calls — we had to union in import edges. Disclosed limitation, then fixed.)

## 3. The reliability property that matters most: it doesn't fabricate
- On `handleConfirmCanonical` / `handleSelectComparison` (React `useCallback` closures), the indexer
  has no top-level symbol. The tool **says "No syntactic impact — fall back to the semantic graph"**
  rather than inventing a blast radius. (We used resolvable proxy anchors for those two issues and
  *documented the substitution* in `issue-gold.json`.)
- The security demo prints "no entry→sink path found" honestly when the union graph has none.
- The freshness check exits non-zero on drift and lists exactly what no longer resolves.

An enterprise can wrap a workflow around a tool that reliably reports its own blind spots. It cannot
wrap one that guesses.

## 4. Disclosed negatives / threats to validity
- **n is small** (8 localization issues, 5 hub anchors, 1 repo). Directional, not a population estimate.
- **Gold is the maintainers' file index**, not a commit-verified fix diff — a localization proxy.
- **Issue-localization ranker delta is 0.000** — honestly a no-op on this well-factored codebase's
  small fans; the ranker's win is firehose-conditional and we do not claim otherwise.
- **Dead-code list still contains the React-closure false positives** (`matchAndRank` et al.) — the
  second filter mitigates but does not eliminate dispatch blindness.
- **Security demo is reachability, not taint** — it enumerates reachable sinks; it does not prove the
  untrusted data actually flows to them. It scopes a human taint review, it doesn't replace it.

## 5. Recommendation for SaaS productization
1. **Ship it as the ranked-retrieval layer under the existing SOP**, not as an autonomous fixer. The
   reliable wins (hub triage, test-noise suppression, sink-tracing) are assistive and verifiable.
2. **Always pair syntactic with semantic/grep cross-checks** for dead-code and cross-language tasks —
   the dispatch blind spot is real and must be a hard guardrail, not a footnote.
3. **Gate on the freshness check** in CI so the graph can't silently rot.
4. **Best-fit customers:** large, coupled, monolithic codebases (where firehoses are common) — the
   same structural condition under which the Hadoop win was largest. Greenfield/well-factored repos
   get index speed + reconstruction + security, but little ranking lift.

## 6. Reproduce
```bash
codegraph init .                                              # 1.1s index
node scripts/graph/build-syntactic.mjs                        # syntactic graph (closes BUILD.md gap)
node scripts/graph/freshness-check.mjs                        # drift gate
node scripts/graph/score-localization.mjs --compare --budget 20   # raw vs ranked localization
node scripts/graph/task-demos.mjs                             # reconstruction + ai-slop + security
npx vitest --run --config scripts/graph/vitest.config.mjs     # 11/11 ranker unit tests
```
Artifacts: `scripts/graph/*`, `.claude/graph/syntactic/*.json`. SOP wiring: `.claude/agents/{graph-traverser,impact-checker}.md`.
