> ⚠️ SUPERSEDED / RETRACTED (2026-06-16). The recall@10 0.80 figure below is a
> SCORING ARTIFACT, not a capability — it came from the harness pasting the graph's
> file list into the prompt and the agent copying it (1 tool call, 0 reasoning), graded
> by a recall-only substring metric. See bench/RESULTS.md and bench/AUDIT-FINDINGS.md
> for the corrected, hardened-F1 results. Kept for the record.

# Impact-task benchmark results (full Apache Hadoop, sonnet-4.6 fixed)

Non-saturating impact/blast-radius tasks, graded by recall@k of dependent files
against real PR ground truth. Same codegraph index across graph arms.

## I2 — FSNamesystem.shouldRoll blast radius (25 gold caller files)

| Arm | recall@10 | recall@20 | named | graph | read | grep | out-tok |
|-----|----------:|----------:|------:|------:|-----:|-----:|--------:|
| control (no graph)        | 0.30 | 0.30 | 36  | 0  | 2 | 28 | 7892 |
| codegraph (Claude+MCP)    | 0.10 | 0.15 | 17  | 10 | 0 | 0  | 3619 |
| graphcode-native r2 (fix) | 0.80 | 0.50 | 121 | 1  | 0 | 0  | 3571 |
| graphcode-native r3       | 0.80 | 0.50 | 117 | 1  | 0 | 0  | 3487 |

## I12 — BlockPlacementPolicyDefault blast radius (6 gold caller files)

| Arm | recall@10 | recall@20 | named | graph | read | grep | out-tok |
|-----|----------:|----------:|------:|------:|-----:|-----:|--------:|
| control (no graph)     | 0.83 | 0.83 | 32 | 0 | 6 | 19 | 4843 |
| graphcode-native       | 1.00 | 1.00 | 66 | 1 | 0 | 0  | 2047 |

Headline: graphcode-native beats no-graph control AND Claude+codegraph-MCP on recall,
with ~1 graph call, 0 reads/greps, and 55-58% fewer output tokens. The win came from a
HARNESS change (pre-compute blast radius + directed enumeration), not a better tool.
Full method + iteration log: ../RESEARCH.md
