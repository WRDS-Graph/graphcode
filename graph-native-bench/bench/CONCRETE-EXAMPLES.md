# Concrete examples — why & how graph-native beats agent+graph-MCP

Evidence mined from real agent-run transcripts at
`~/Documents/codegraph/hadoop-mcp-eval/outputs/agent-runs/sonnet-4.6/<task>/<arm>/r<N>.jsonl`.
All `.final.txt` answers cited exist. **Caveat:** the prior `graphcode-native` runs used the
pi/civitas gateway (`costUsd: null`); fresh subscription-based native runs (arm
`graphcode-native-claude`, this work) remove that gateway confound. These three cases are the
*illustrative* mechanism; the headline numbers come from the hardened F1 matrix + fresh runs.

## The mechanism in one sentence

All three arms can reach the same codegraph index, but **only the harness decides _before_ the
agent's first token** — so the plain arm grep-storms, the MCP arm calls a tool *if it chooses to*
and must rank the firehose *in-context*, and the graph-native arm starts from a **pre-ranked,
test-free shortlist** it only has to refine.

---

## CASE 1 — I2 (FSNamesystem.shouldRoll, HDFS-17924): native wins on a deep multi-hop blast radius

| arm | Read | Grep | Shell | graph calls | out tok | cost | #files committed |
|---|---:|---:|---:|---:|---:|---:|---:|
| plain (control) | 2 | **28** | 0 | 0 | 7,892 | $0.717 | 35 (over-enumerated) |
| graph-MCP (codegraph) | 0 | 1 | 0 | 10 | 3,619 | $0.635 | 16 (under-enumerated) |
| graph-native (r7) | **0** | **0** | 0 | 20 | **3,473** | n/a (pi) | 24 (best balance) |

- **plain** grep-stormed (28 greps) and committed 35 files — captured real dependents but drowned
  them in lock/manager field-holders (`FSNamesystemLock`, `CacheManager`, `EncryptionZoneManager`)
  + 5 test files. Highest cost, lowest precision.
- **graph-MCP** dropped to 10 graph calls / 3.6k tokens but committed only **16** — missed
  `NameNodeRpcServer`, `FSImage`, `BackupImage`, `SecondaryNameNode`, `Checkpointer` and 4 tests.
  Its `explore`-heavy path found direct callers of `rollEditLog` but didn't walk the deeper surface.
- **graph-native** opened with `impact(FSNamesystem, autocontext=true)`, then verified with
  `node`/`callers`/`search` — **0 grep, 0 read, fewest tokens**, and committed **24** files: it
  found what MCP missed (`BackupImage`, `SecondaryNameNode`, `Checkpointer`, `FSImageFormat`, the
  extra tests) while excluding the noise control over-included. The pre-ranked shortlist is why.

**Takeaway:** on a hub anchor where the blast radius is large and the difficulty is *ranking*, the
harness's precomputed-and-ranked shortlist beats both "grep everything" and "call a tool and hope."

---

## CASE 2 — I8 (AbfsClient.appendSASTokenToQuery, HADOOP-19917): MCP wins — the benchmark is honest

| arm | Read | Grep | Shell | graph calls | out tok | cost | #files committed |
|---|---:|---:|---:|---:|---:|---:|---:|
| plain (control) | 2 | **37** | 0 | 0 | 7,870 | $0.662 | 36 (over-enumerated) |
| graph-MCP (codegraph) | 0 | 0 | 0 | **6** | 3,680 | **$0.386** | 28 |
| graph-native (r7) | 0 | 0 | 0 | 14 | 2,917 | n/a (pi) | 26 |

- `appendSASTokenToQuery` has a **clean, shallow caller tree** (AbfsBlobClient/AbfsDfsClient →
  AbfsClientHandler → AzureBlobFileSystemStore → AzureBlobFileSystem). The MCP arm nailed it in
  **6 calls** (`explore`×2, `callers`×2, `impact`×2) — the cheapest run in the whole study.
- graph-native used **14** calls to reach a near-identical answer (26 files) — its turn-0 impact +
  per-symbol resolution was *overhead* here, not edge, because the graph was already compact.

**Takeaway:** when the 1-hop caller graph is clean and complete, plain MCP tool-calling is the
right tool and the harness's extra machinery doesn't help. **No arm dominates** — that's the mark
of a discriminative benchmark, not a rigged one.

---

## CASE 3 — F1 (DataStreamer/ByteArrayManager flow, HDFS-17916): the flow-task efficiency story

| arm | Read | Grep | Shell | graph calls | out tok | cache-read tok |
|---|---:|---:|---:|---:|---:|---:|
| plain (control) | **11** | 6 | 0 | 0 | 4,272 | 762,993 |
| graph-MCP (codegraph) | **1** | 6 | 0 | 3 | 3,761 | 496,064 (−35%) |

- **plain** glob→grep→**read 11 files**→synthesize: 17 file/pattern tool calls to find the
  `processDatanodeOrExternalError` early-return that skips `releaseBuffer`.
- **graph-MCP** issued **3 targeted `explore` calls** + 6 verification greps + 1 read = 10 calls
  (41% fewer), loading **267K fewer cached tokens**, same correct answer + same 4 key files.

**F3 corroborates** (PureJavaCrc32C→CRC32C): graph-MCP used `explore`×4 + `search`×2 = 6 graph
calls / **0 greps** / 2 reads / 2,576 out-tok, vs control's 11 greps + 8 reads / 4,579 out-tok
(−44% output). (No native arm was run for flow tasks in the existing eval — a gap this work's
`graphcode-native-claude` runner can now fill, since it supports flow auto-context too.)

**Takeaway:** on flow/"how does X reach Y" tasks the win is *efficiency* (fewer reads, fewer cached
tokens, same answer) rather than the *ranking* win seen on impact tasks. Both arms tend to be
correct; the graph just gets there with less context churn.

---

## Cross-case pattern

- **Grep-storm signature (plain):** 28 / 37 / (11 reads) tool calls — always the most churn, most
  cached tokens, highest cost, and *not* the most accurate (it over-enumerates).
- **graph-MCP:** efficient and often best on shallow/clean structure (I8); under-enumerates on deep
  multi-hop (I2) because it ranks the firehose in-context and stops early.
- **graph-native:** 0 read / 0 grep on impact tasks; wins where ranking is the bottleneck; carries
  per-call overhead where the graph is already compact.
- **Graph arms consumed 35–57% fewer cache-read tokens than plain on equivalent tasks.**

## Honest run-hygiene notes (from the same mining pass)

- I2/graphcode-native r2,r3 are **shallow** (1 tool call, ~34–37s) — excluded; r7 is the valid run.
- I2/graphcode-native r4 is **missing**. I8/graphcode-native r5 is shallow (4 calls) — excluded; r7 used.
- All control/codegraph runs cited are single, healthy runs (status finished, normal durations).
