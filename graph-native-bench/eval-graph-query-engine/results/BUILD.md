# How the Code Graph Is Built

This project uses **two complementary graphs**:

## 1. Semantic graph (primary) — `.claude/graph/CODE_GRAPH.md`

Produced by dual-agent exploration of the repo (two `Explore` agents: one mapped the search pipeline, one mapped state + UI). It captures semantic call-trees, state flow, and issue-to-file localization. **Agents traverse this first.**

To regenerate:
```
Launch 2 Explore agents in parallel:
  Agent A — "Map query/search/matching flow"
  Agent B — "Map state, data, and UI flow"
Consolidate their reports into .claude/graph/CODE_GRAPH.md
```

## 2. Syntactic graph (supplementary) — `.claude/graph/syntactic/`

Captures file/class/function/method/interface nodes with parent_child, calls, imports, inherits,
and references edges over the whole repo (TS/TSX + Python backend).

**Built locally from `codegraph` in ~1s** (no Windows host, no Azure key, no network):

```bash
codegraph init .                          # build the index -> .codegraph/codegraph.db (once)
node scripts/graph/build-syntactic.mjs    # export -> .claude/graph/syntactic/*.json
```

Output:
- `graph-query-engine-graph.json` — nodes[] + edges[] (programmatic access; ~1,267 nodes / 5,622 edges)
- `graph-query-engine-stats.json` — node/edge kind histograms

> The original build path pointed `Logical_inference/graph-code-indexing` at a Windows machine
> that is not on this host, so this graph never actually existed even though the Impact Checker
> is told to "use both graphs." `build-syntactic.mjs` closes that gap using codegraph
> (tree-sitter -> SQLite), which covers TS/TSX/JS/Python. Re-run after code changes (or
> `codegraph sync .` for an incremental update), then `node scripts/graph/freshness-check.mjs`
> to confirm CODE_GRAPH.md hasn't drifted from the live code.

Impact Checker / Graph Traverser agents use both graphs: **semantic first** (intent: string-keyed
reducer actions, cross-language backend siblings, React `useCallback` closures the indexer skips),
**syntactic for ranked consumer enumeration** via `node scripts/graph/rank-impact.mjs <Symbol>`
(test-demoted, tier-segmented blast radius).
