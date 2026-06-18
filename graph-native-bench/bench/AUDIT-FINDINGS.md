# Benchmark validity audit — forensic findings (hard evidence)

Date: 2026-06-16. Auditor: direct transcript + metric forensics (not assertion).

## TL;DR — the prior "0.80 vs 0.30" win is a transcription artifact

The graph-native I2 "win" (recall@10 0.80) is produced by the harness **pasting the
graph's blast-radius file list into the prompt** and the agent **copying it into JSON
with zero retrieval work**. It is not engineering ability. Evidence below.

## Evidence 1 — the same task, two harness modes, opposite outcomes

| native I2 run | real tool calls | dependent_files emitted | recall@10 | what happened |
|---------------|----------------:|------------------------:|----------:|---------------|
| r1 (no autocontext) | 17 graph calls | 10 | **0.10** | agent genuinely explored the graph |
| r2 (autocontext paste) | **1** (the injected call) | 61 | **0.80** | agent copied the pasted 60-file list |
| r3 (autocontext paste) | **1** | 61 | **0.80** | identical copy (byte-identical score) |

`outputs/agent-runs/sonnet-4.6/I2/graphcode-native/{r1,r2,r3}.jsonl`.
r2/r3 have a single `stream_event` — `mcp_codegraph_impact` (the synthetic injected one).
The agent made **no** real retrieval calls; it transcribed the pasted list.

Control I2: 28 greps + 2 reads (genuine search) → recall@10 0.30.

**So the headline "native 0.80 vs control 0.30" compares a paste-transcription against
genuine search.** The RESEARCH.md "0.80" does NOT reproduce from the committed r1
(which is 0.10) — it only appears in the paste runs.

## Evidence 2 — the metric only rewards recall, never punishes the firehose

Raw `codegraph impact <anchor> --depth 2` vs gold (no agent in the loop):

| task | anchor | gold files | raw impact files | gold covered | RECALL | PRECISION |
|------|--------|-----------:|-----------------:|-------------:|-------:|----------:|
| I2 | FSNamesystem | 25 | 407 | 25 | **1.00** | **0.061** |
| I3 | DatanodeID | 25 | 365 | 25 | 1.00 | 0.068 |
| I12 | BlockPlacementPolicyDefault | 6 | 34 | 6 | 1.00 | 0.176 |

The graph **contains** every gold dependent (recall 1.0) but emits 6–16× too many
files (precision 6–18%). The current metric (`recallAt` = substring scan over the
whole prose answer) gives full credit for pasting the firehose and **never penalizes
the 94% false-positive rate**. Precision is computed only over the JSON block, and
recall only over prose — they don't read the same text, so dumping 60 files in prose
maximizes recall while a tidy JSON keeps "precision" looking fine.

## The three structural fixes (industry-grade)

1. **Single-field scoring + F1.** Precision and recall must read the SAME bounded
   structured answer; report F1. Then pasting 407 files tanks precision and F1 — the
   firehose is punished, exactly as a real engineer would be.
2. **Graph-oracle ablation.** Score raw `codegraph impact` (no agent) for
   precision/recall/F1 per task. This is the honest upper bound on recall and the
   honest floor on precision; it makes "did the agent add value over the raw query"
   measurable.
3. **Anti-paste / capped answers.** The real graph task is RANKING the 25 true
   dependents above the 380 false positives within a budget (e.g. "name at most 20").
   That tests a genuine graph capability the firehose-paste cannot fake.
