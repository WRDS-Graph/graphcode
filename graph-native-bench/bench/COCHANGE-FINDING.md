# Co-change ranking signal — tested, honest negative result

The RESEARCH.md backlog's top "should" item was a **co-change ranking signal** ("mine Hadoop git
history for files that co-change with the anchor — a signal grep AND static-impact both lack").
This documents building and rigorously evaluating it. **Verdict: real signal, no headline gain.**

## What was built

- `bench/mine-cochange.mjs` — gold-blind co-change miner. For an anchor's subject file, finds every
  commit that touched it (most recent ≤400), then tallies how often each OTHER `.java` file changed
  in those same commits. Cached per anchor in `bench/.cochange-cache/`. Keyed only on the anchor's
  own history — never on which files are gold.
- `extension/impact-ranker-v3.mjs` — v2 + an additive, rank-based, history-gated co-change bonus.
  The static half is byte-for-byte v2, so any delta is attributable to co-change alone.
- `bench/validate-ranker-v3.mjs` — feeds the co-change cache into the ranker; same hardened F1,
  same held-out split + dedup as `validate-ranker-v2.mjs`, so numbers compare directly.

## The signal is genuinely real and complementary

Co-change surfaces true dependents that the static graph misses (diag output, held-out tasks):

| Anchor | Co-change promoted into top-20 (gold hits the static signal under-ranked) |
|---|---|
| I13 ByteArrayManager | `dfsoutputstream`, `datastreamer` (both gold) |
| I4 Server | `namenoderpcserver`, `rpcmetrics` (both gold) |
| I11 Clock | `systemclock` (gold; v2 alone scored 0.07 here) |

These are exactly the "no static edge" dependents (a class a human always edits alongside the
anchor) that grep and reverse-reachability both miss.

## But it does NOT move the headline metric (budget top-20)

Held-out mean F1 (n=9, never tuned), co-change weight sweep:

| cochangeMax | 2 | 4 | 6 | 10 | 15 |
|---|--:|--:|--:|--:|--:|
| held-out F1 | **0.519** | 0.514 | 0.514 | 0.494 | 0.494 |

- **v2 baseline (no co-change): 0.519.** No co-change setting beats it; higher weights *hurt*.
- At a tighter budget (top-10): v3 0.496 vs v2 0.490 — a marginal +0.006.

**Why:** v2's static top-20 is already saturated with correct dense dependents. Co-change's unique
finds (low-static-edge files) don't *replace* wrong picks — there are few wrong picks to replace —
they get *crowded out* by the budget cap. The signal would pay off on a task that is NOT
budget-capped, or where the static blast radius is sparse, not on this precision@20 benchmark where
the static ranker is already strong.

## Decision (per this project's honesty bar)

- **Default `cochangeMax = 2`** — exactly neutral vs v2 (0.519). v3 ships as a safe opt-in.
- **v2 remains the production ranker.** No false "v3 wins" claim — the data doesn't support one.
- Kept, not deleted: a documented, reproducible negative result and a building block for future
  non-budget-capped or signal-fusion uses (e.g. a fault-localization task where breadth matters).

This is the same discipline that retracted the earlier "0.80" recall artifact and discloses the
`Clock` failure: a signal that doesn't beat the floor on the headline metric is reported as such,
not shipped as a win.

Reproduce: `node bench/mine-cochange.mjs --all` then
`node bench/validate-ranker-v3.mjs --ranker ../extension/impact-ranker-v3.mjs --diag`.
