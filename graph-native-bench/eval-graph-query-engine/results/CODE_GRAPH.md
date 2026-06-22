# Graph-Query-Engine — Code Graph (Semantic Map)

This file is the **semantic code graph** the debugging agents traverse before touching code. It was produced by dual-agent exploration of the repo (the two agents together acted as our graph builder: one mapped the **search pipeline**, the other mapped **state + UI**).

It is supplemented by a syntactic graph produced by `Logical_inference/graph-code-indexing` (stored in `.claude/graph/syntactic/` when available).

**Edge importance order (traversal priority):**
1. `entry_points → handler` — how user action reaches code
2. `handler → action/dispatch` — state mutation contract
3. `action → reducer → state_field` — data flow into state
4. `state_field → consumer_component` — how state reaches UI
5. `function → helper_function` — intra-module dependencies
6. `file → imports` — cross-module dependencies

---

## 1. Entry Points

| Surface | Component | Event | Handler | File:Line |
|--------|-----------|-------|---------|-----------|
| Search box | `SearchEntryPage` | onSubmit (Enter or Search btn) | `handleSubmit` → `onSearch` prop | `src/components/SearchEntryPage.tsx:155` |
| Related-paper row | `LeftPanel` | onClick | `onSelectComparison(slug)` | `src/components/LeftPanel.tsx:322` |
| Canonical candidate | `LeftPanel` | onClick | `onConfirmCanonical(slug)` | `src/components/LeftPanel.tsx:85+` |
| Graph node | `GraphPanel` | onClick | `onNodeClick` | `src/components/GraphPanel.tsx` |
| "+ more nodes" / expand | `GraphPanel` | onClick | cytoscape expansion in `CytoscapeGraphRenderer` | `src/renderer/graphRenderer.ts:64-66 (MAX_FAN_SIZE=12)` |
| AI toggle | `SearchEntryPage` | onClick | toggles API key panel + localStorage `kova_openai_api_key` | `src/components/SearchEntryPage.tsx:351-397` |

All entry points flow through `App.tsx` which owns the orchestration layer.

---

## 2. Orchestration Layer (`src/App.tsx`)

```
App.handleSearch(query)             line 152
   ↓ setIsSearching(true)
   queryEngine.search(query)         src/query/queryEngine.ts
       ├── classifyInput             src/query/classifier.ts:1-25
       ├── normalize                 src/query/normalizer.ts
       ├── hybridRelatedSearch       src/retrieval/hybrid.ts
       │       ├── bm25Path          src/retrieval/bm25Path.ts
       │       ├── vectorPath        src/retrieval/vectorPath.ts
       │       └── graphPath         src/retrieval/graphPath.ts (uses router.ts)
       └── graphMatchingEngine.matchAndRank  src/matching/graphMatchingEngine.ts:108-151
   dispatch(SET_SEARCH_RESULTS)

App.handleConfirmCanonical(slug)    line 173
   ├── dataLayer.loadPaperGraph(slug)           src/data/dataLayer.ts:184-199
   ├── dispatch(CONFIRM_CANONICAL)
   ├── if isPriorArt:
   │       fetchPriorArtFromBackend(slug)        src/api/backendSearch.ts:70-87
   │       dispatch(SET_PRIOR_ART_PAPERS)
   └── else (list mode):
           queryEngine.search(graph.title)
           dispatch(SET_RELATED_PAPERS)

App.handleSelectComparison(slug)    line 233
   ├── dataLayer.loadPaperGraph(slug) → compGraph
   ├── ensureLinksLoaded (parallel)
   ├── fetchSemanticCompare         src/api/backendSearch.ts:38-53
   ├── graphMatchingEngine.computeOverlay  src/matching/graphMatchingEngine.ts:156-352
   └── dispatch(SET_COMPARISON)
```

---

## 3. State Graph (`src/state/appState.tsx`)

**Fields (edges to consumers):**
| Field | Readers | Writers |
|-------|---------|---------|
| `mode` | `App`, `Workbench` | `SET_MODE` |
| `searchQuery` | `App` | `SET_SEARCH_RESULTS`, `INITIATE_NEXT_ROUND` |
| `searchResults` | `Workbench`, `LeftPanel` | `SET_SEARCH_RESULTS`, `SET_RELATED_PAPERS`, `SET_PRIOR_ART_PAPERS` |
| `canonicalPaper` | `GraphPanel`, `DetailPanel`, `App` | `CONFIRM_CANONICAL`, `INITIATE_NEXT_ROUND` |
| `isCanonicalConfirmed` | All gated actions | `CONFIRM_CANONICAL` |
| `comparisonPaper` | `GraphPanel`, `DetailPanel` | `SET_COMPARISON`, `CLEAR_COMPARISON` |
| `overlayData` | `GraphPanel`, `DetailPanel` | `SET_COMPARISON`, `CLEAR_COMPARISON` |
| `nextRoundQueue` | `DetailPanel` | `ADD_TO_QUEUE`, `REMOVE_FROM_QUEUE`, `INITIATE_NEXT_ROUND` |
| `selectedNodeId` | `DetailPanel` | `SET_SELECTED_NODE` |
| `graphExpandedNodes` | `GraphPanel` | expansion actions |
| `relatedPapersPage` | `LeftPanel` | `SET_PAGE` |
| `recentQueries` | `SearchEntryPage` | persisted to localStorage |

**Gate:** `isCanonicalConfirmed` blocks `SET_COMPARISON`, `ADD_TO_QUEUE`, `SET_SELECTED_NODE`, etc. (appState.tsx:152-198)

**Missing (relevant to feedback):**
- ❌ no `isLoadingComparison` flag (Issue #7)
- ❌ no `matchingComparisonPaper` field for comparing two matching papers (Issue #6)
- ✅ `relatedPapersPage` exists (supports Issue #5 — just needs UI/infinite-scroll)

---

## 4. Search Pipeline (Backend + Frontend)

```
POST /api/search  (backend/server.py:222-330)
   ├── processor.classify             backend/search/processor.py:1-111
   │      intent ∈ {search, explore, prior-art, compare}
   ├── resolve canonical_slug
   │      title match → matched_paper_slug
   │      else → node label index
   ├── parallel (ThreadPoolExecutor, 3 workers):
   │      ├── run_bm25_path          backend/search/bm25_path.py
   │      ├── run_vector_path        backend/search/vector_path.py
   │      └── run_graph_path (PPR)   backend/search/graph_path.py
   ├── rrf_fuse                      backend/search/hybrid.py:1-118 (K=60)
   ├── post-gate filter              hybrid.py:58-66
   │      admit if method_pairs OR citations OR graph_signal OR vector>0.5 OR in_2+_sources
   ├── year filter                   server.py:304-315
   └── return { canonicalCandidates, relatedPapers, queryDecomposition, appliedFilters }

Router seeds (src/retrieval/router.ts:1-51):
   prior-art:  50% canonical + 50% top BM25 (weighted 1/rank)
   compare:    50% canonical + 50% comparison_target
   search/explore: 100% canonical
```

**Scoring weights (`graphMatchingEngine.ts:378-382`):**
```
total = 0.4 × structuralOverlap
      + 0.3 × citationProximity
      + 0.1 × recencyAdjustment
      + 0.2 × componentCoverage
```
Prior-art intent inverts recency (line 505-507).

**Shared-node threshold:** `OVERLAY_MIN_CONFIDENCE = 0.35` (`graphMatchingEngine.ts:62`)

---

## 5. Data Layer

| Source | File | Purpose |
|--------|------|---------|
| `public/data/papers.json` | `dataLayer.ts:67-152` | PaperEntry[] index |
| `public/data/paper_registry.json` | `dataLayer.ts:262-269` | citation_key ↔ slug |
| `public/data/cross_paper_links.json` | `dataLayer.ts` (skipped when backend available) | CrossPaperLink[] |
| `public/data/merged_graphs/{slug}.json` | `dataLayer.loadPaperGraph:184-199` | PaperGraph — fetched lazily, LRU 200 |
| `public/data/node_index.json` | `invertedIndex.ts` | normalized_label → slug[] |

**Note on data location:** When running the dev server, `public/data/` is empty. The checked-in `sample data/` folder contains `paper_registry.json`, `cross_paper_links.json`, and `merged_graphs/`. The app expects data under `public/data/`. Any fix that needs data access must either copy/symlink sample data into public/data, or the backend must serve it.

---

## 6. UI Component Tree

```
App
├── SearchEntryPage                                src/components/SearchEntryPage.tsx
│     ├── TypeaheadDropdown
│     ├── (recent queries, popular papers)
│     └── AI key panel (toggle)
│
└── Workbench                                      src/components/Workbench.tsx
      ├── LeftPanel                                src/components/LeftPanel.tsx
      │     ├── Canonical Confirmation section
      │     ├── Related Papers list (paginated, 50/page)
      │     └── Prior Art list (when mode)
      ├── GraphPanel                               src/components/GraphPanel.tsx
      │     ├── CytoscapeGraphRenderer instance    src/renderer/graphRenderer.ts
      │     ├── Expand All / Collapse All buttons
      │     └── Comparison label badge
      └── DetailPanel                              src/components/DetailPanel.tsx
            ├── Node Details
            ├── Comparison Details
            ├── Next Round Queue
            └── Generate Report
```

---

## 7. Issue-to-Code Localization Index

| # | Issue | Primary files | Supporting files |
|---|-------|---------------|------------------|
| 1 | RabitQ/TurboQuant test | sample data/merged_graphs/*RabitQ*, *TurboQuant* | `src/query/queryEngine.ts`, `src/matching/graphMatchingEngine.ts` |
| 2 | Prior-arts canonical confirmation | `src/App.tsx:173-231` (`handleConfirmCanonical`), `src/components/LeftPanel.tsx` (priorArtMode), `backend/search/processor.py:15-31` (intent), `backend/server.py` (/api/prior-art, /api/title-search) | `src/query/queryEngine.ts`, `src/retrieval/router.ts` |
| 3 | Out-of-DB papers in related list | `backend/search/hybrid.py:73-118` (build_ranked_papers), `src/components/LeftPanel.tsx:276-335` | `src/data/dataLayer.ts`, `src/matching/crossPaperResolver.ts` |
| 4 | "Multi-head attention" concept search | `backend/search/processor.py`, `backend/search/bm25_path.py`, `backend/search/vector_path.py`, `src/query/classifier.ts`, `src/matching/graphMatchingEngine.ts:108-151` | `src/matching/nodeMatcher.ts:18` (Jaccard threshold) |
| 5 | Too many related papers / load-more | `src/components/LeftPanel.tsx:22 (PAGE_SIZE=50)` + 235-274 (controls), `src/state/appState.tsx` (relatedPapersPage) | `backend/search/hybrid.py:58-66` (post-gate) |
| 6 | Compare two matching papers | `src/state/appState.tsx:154-161 (SET_COMPARISON)`, `src/components/LeftPanel.tsx` (candidate rendering), `src/App.tsx:233-332 (handleSelectComparison)` | `src/matching/graphMatchingEngine.ts:156-352 (computeOverlay)` |
| 7 | Loading indicator for paper click | `src/App.tsx:233-332`, `src/components/GraphPanel.tsx` | add `isLoadingComparison` to `appState.tsx` |
| 8 | Comparison summary table | `src/components/DetailPanel.tsx:60-69`, `src/matching/graphMatchingEngine.ts (overlayData)` | `src/renderer/graphRenderer.ts` (bridge rendering) |
| 9 | Zoom-out bug on "+ more nodes" | `src/renderer/graphRenderer.ts:64-66` (expansion, MAX_FAN_SIZE), `src/components/GraphPanel.tsx:40-61` (ResizeObserver `resetView`) | — |

---

## 8. Important Invariants / Landmines

- **Canonical gate:** Any fix touching comparison / queue / node selection must respect `isCanonicalConfirmed`. Don't dispatch those actions before confirmation.
- **Backend optional:** Several paths probe `checkBackendAvailable()`. Fixes must degrade gracefully when backend is down (fallback to local cross_paper_links.json and exact label matching).
- **LRU cache:** `loadPaperGraph` caches by slug. Cache invalidation rarely matters, but note it exists (dataLayer.ts).
- **Cytoscape re-layout:** After any graph mutation (expand, overlay), cytoscape may trigger its layout algorithm, which can reset viewport. Preserve zoom/pan via `cy.zoom()` + `cy.pan()` capture/restore.
- **OPENAI_API_KEY:** If set, enables `analyzeQuery` (frontend) and `semantic_compare.py` (backend). Fixes must not assume it is present.
