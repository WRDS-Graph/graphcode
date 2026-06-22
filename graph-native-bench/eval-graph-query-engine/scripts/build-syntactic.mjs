#!/usr/bin/env node
/**
 * build-syntactic.mjs — close the BUILD.md gap.
 *
 * BUILD.md §2 documents a syntactic graph "produced by Logical_inference/graph-code-indexing"
 * pointed at a Windows machine that isn't on this host, so the second graph never existed —
 * even though the Impact Checker is told to "use both graphs". This script builds it locally
 * from codegraph's index (.codegraph/codegraph.db) in ~1s, emitting the node/edge JSON shape
 * BUILD.md describes (file/class/function nodes; parent_child/calls/imports/inherits edges).
 *
 * Run:
 *   codegraph init .                              # once, builds .codegraph/codegraph.db
 *   node scripts/graph/build-syntactic.mjs        # emits .claude/graph/syntactic/*.json
 *
 * Output (under .claude/graph/syntactic/):
 *   graph-query-engine-graph.json   nodes[] + edges[] (programmatic access)
 *   graph-query-engine-stats.json   node/edge kind histograms
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DB = path.join(REPO_ROOT, '.codegraph', 'codegraph.db')
const OUT_DIR = path.join(REPO_ROOT, '.claude', 'graph', 'syntactic')

// codegraph edge kind -> BUILD.md documented edge type
const EDGE_MAP = {
  contains: 'parent_child',
  calls: 'calls',
  imports: 'imports',
  implements: 'inherits',
  instantiates: 'inherits',
  references: 'references',
}

let db
try {
  db = new DatabaseSync(DB, { readOnly: true })
} catch (e) {
  console.error(`Cannot open ${DB}. Run \`codegraph init .\` in the repo root first.`)
  console.error(e.message)
  process.exit(1)
}

const nodeRows = db
  .prepare(
    `SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line, is_exported
     FROM nodes`
  )
  .all()

const nodes = nodeRows.map((n) => ({
  id: n.id,
  kind: n.kind, // file | class | function | method | interface | type_alias | ...
  name: n.name,
  qualifiedName: n.qualified_name,
  file: n.file_path,
  language: n.language,
  startLine: n.start_line,
  endLine: n.end_line,
  isExported: !!n.is_exported,
}))

const edgeRows = db.prepare(`SELECT source, target, kind, line FROM edges`).all()
const edges = edgeRows.map((e) => ({
  source: e.source,
  target: e.target,
  type: EDGE_MAP[e.kind] ?? e.kind,
  rawKind: e.kind,
  line: e.line ?? null,
}))

const nodeKinds = {}
for (const n of nodes) nodeKinds[n.kind] = (nodeKinds[n.kind] || 0) + 1
const edgeTypes = {}
for (const e of edges) edgeTypes[e.type] = (edgeTypes[e.type] || 0) + 1

mkdirSync(OUT_DIR, { recursive: true })
const graph = {
  name: 'graph-query-engine',
  source: 'codegraph (tree-sitter -> SQLite), exported by scripts/graph/build-syntactic.mjs',
  nodeCount: nodes.length,
  edgeCount: edges.length,
  nodes,
  edges,
}
writeFileSync(path.join(OUT_DIR, 'graph-query-engine-graph.json'), JSON.stringify(graph, null, 2))
writeFileSync(
  path.join(OUT_DIR, 'graph-query-engine-stats.json'),
  JSON.stringify({ nodeCount: nodes.length, edgeCount: edges.length, nodeKinds, edgeTypes }, null, 2)
)

console.log(`Syntactic graph written to ${path.relative(REPO_ROOT, OUT_DIR)}/`)
console.log(`  nodes: ${nodes.length}  edges: ${edges.length}`)
console.log(`  node kinds: ${Object.entries(nodeKinds).map(([k, v]) => `${k}=${v}`).join(' ')}`)
console.log(`  edge types: ${Object.entries(edgeTypes).map(([k, v]) => `${k}=${v}`).join(' ')}`)
