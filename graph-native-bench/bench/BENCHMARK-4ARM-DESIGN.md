# 4-Arm Robustness Benchmark — Design

Comparing **graph-native harness** vs **plain harness** vs **harness + graph-MCP** vs **potpie**,
on the Claude subscription (no API key), with gaming-resistant scoring.

## Constraints discovered (these shape the whole design)

1. **Claude subscription only, no API key.** Confirmed: `~/.claude.json` has `oauthAccount`
   (ericnerwala@gmail.com); `ANTHROPIC_API_KEY` is unset. The eval's `claude-runner.mjs`
   spawns `claude -p --output-format stream-json …`, which uses the OAuth subscription. ✅
2. **`pi` is NOT installed** (no `/tmp/graphcode_clone`, no `pi-test.sh` anywhere). The existing
   `graphcode-native` arm (`graphcode-runner.mjs`) spawns pi via `tsx` and the `civitas` provider
   — it **cannot run here**. The prior `graphcode-native` r7 transcripts were produced elsewhere.
3. **The original results mix two gateways** — `control`/`codegraph` ran on `claude` (subscription),
   the native arm ran on `pi`/`civitas`. That's a confound: the native arm differed in *both*
   harness *and* model gateway.
4. **potpie's agent layer needs a real API key** (ANTHROPIC/OpenAI), NOT a subscription. Its parse
   step also needs an LLM (workaroundable with Ollama). Its **graph layer (Neo4j CALLS/IMPORTS)**
   can be queried directly via Cypher with no per-query LLM.
5. **codegraph is built** (`codegraph/dist/bin/codegraph.js`, v1.0.1); **Hadoop is indexed**
   (~12.5k Java files, ~470k nodes); **gold tasks exist** (`hadoop-mcp-eval/tasks/pr-derived-tasks.yaml`
   + `impact-manifest.json`, held-out n=9 after dedup).

## Key methodological improvement: re-home the native arm onto the Claude CLI

To run here AND to remove the gateway confound, the native arm is re-implemented on top of the
**working Claude subscription runner** (`graphcode-claude-runner.mjs`). It reproduces the two
harness levers, model-agnostically:

- **Lever A — turn-0 auto-context injection.** Before the agent's first token, the harness runs
  `codegraph impact <anchor>` + `codegraph callers <anchor>`, ranks the union with the **v2
  structural ranker** (`extension/impact-ranker-v2.mjs`), drops test files, and injects a
  tier-segmented, draft-to-refine preamble. (Identical logic to `graphcode-runner.mjs`'s
  `buildAutoContext`, lifted out of the pi path.)
- **Lever B — graph-first surface.** The arm attaches the **codegraph MCP server** (so the agent
  has `codegraph_*` tools) **plus** a graph-first `--append-system-prompt` ("the graph is your
  primary retrieval surface; treat returned source as already read; don't grep to reconstruct").

Now **all four arms run on the same `claude` CLI**, differing only in harness wiring:

| Arm | MCP server | Turn-0 injection | System-prompt steering | Runs on subscription? |
|---|---|---|---|---|
| **plain** (control) | none | none | "no MCP; use Read/Grep/Bash" | ✅ |
| **graph-MCP** (codegraph) | codegraph | none | "MCP-first with fallback" | ✅ |
| **graph-native** | codegraph | **v2-ranked draft** | **graph-first** | ✅ (re-homed) |
| **potpie** | — (see below) | — | — | ⚠️ graph-layer only |

This is *stronger* than the original 3-arm design: the native edge is now isolated to the
harness moves alone, on an identical gateway.

## The potpie arm — honest, two-track

potpie cannot run end-to-end on a subscription. We report it honestly on the track that *is*
runnable and label it as a graph-engine comparison, not an agent comparison:

- **Track P1 (primary, runnable): graph-engine F1.** Stand up potpie's stack (Docker:
  Postgres+Neo4j+Redis), parse Hadoop (LLM-free tree-sitter pass is enough for CALLS/IMPORTS;
  use Ollama only if the parse insists on the inference pass), then for each impact task run a
  **Cypher blast-radius query** (`MATCH (caller)-[:CALLS*1..2]->(m {name:$anchor}) RETURN
  DISTINCT caller.file_path`) and score the returned file set with the **same hardened F1
  oracle** (budget top-20, basename match) used for codegraph's `impact`. This is the fair
  **codegraph-graph vs potpie-graph** comparison — both are static dependency graphs; we ask
  which one's raw blast radius better matches real PR gold.
- **Track P2 (secondary, if Ollama feasible): potpie agent via Ollama.** Run potpie's
  `code_changes_agent`/`codebase_qna_agent` through a local Ollama model, scored identically.
  Reported **separately** (different model class — not mixed into the Sonnet arms) purely to
  characterize potpie's full product.
- If Docker/Neo4j cannot be stood up in this environment, that blocker is reported as a result
  (it's a real robustness/operability finding: codegraph is a zero-dependency local binary;
  potpie is a multi-service deployment).

## Tasks & gold

- **Impact family (primary):** the held-out I-series from `pr-derived-tasks.yaml`
  (I1, I4, I6, I8, I9, I10, I11, I13, I14 — n=9 after manifest dedup). Gold = real PR
  `expected_caller_files`. This is the non-saturating, gaming-resistant family.
- **Flow family (secondary):** H-series / F-series "how does X reach Y" tasks, scored on
  Read/Grep displacement + DTA. Illustrates the efficiency story (vs the impact ranking story).

## Metrics (all already implemented in `bench/score-impact-hardened.mjs`)

- **Headline: F1 @ budget top-20**, basename set-match, on the agent's committed `dependent_files`
  (single bounded field — pasting the firehose tanks precision).
- **Oracle floor:** raw `codegraph impact` scored identically. No arm may *claim* a graph win on a
  task unless it beats this floor.
- **Cost:** output tokens (summed per-turn), cache-read tokens, wall-clock, tool-call counts
  (Read / Grep / graph).
- **Robustness add-ons (this work):**
  - **n≥3 runs per cell** with mean ± 95% CI (closes threat-to-validity #2: original was n=1).
  - **Token-efficiency frontier:** F1 per 1k output tokens.

## Run plan (subscription budget-aware)

1. Build `graphcode-claude-runner.mjs`; wire `--runner graphcode-claude` into `run-flow-agent.mjs`.
   Unit-check the auto-context preamble offline (no agent) first.
2. Smoke test: 1 task × 4 arms (well, 3 Claude arms + potpie-graph), confirm transcripts parse and
   score. Fix any wiring (e.g. codegraph MCP `command` → node + dist path).
3. Scale: held-out impact tasks × {plain, graph-MCP, graph-native} × n=3. (Potpie-graph is
   LLM-free, so all 9 tasks cheaply.)
4. Score with `score-impact-hardened.mjs --all-runs`; compute CIs; build the frontier.
5. Report: tables + the three concrete case studies + honest per-arm wins + potpie verdict.

## What "robustness" means here (the deliverable)

Not "native always wins" — the existing honest finding is that **no arm dominates**. Robustness =
(a) the native mean-F1 + token edge **survives** multi-run CIs and the gateway-confound removal;
(b) we can **predict which arm wins from task structure** (hub/firehose→native; clean 1-hop→MCP;
small clean→plain); (c) the graph engines are compared head-to-head (codegraph vs potpie) on the
same gold; (d) every blocker (pi, potpie API key, Docker) is disclosed, not hidden.
