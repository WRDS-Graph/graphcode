/**
 * graphcode — graph-native coding agent extension for the pi harness.
 *
 * Registers a family of graph-query tools backed by the codegraph code-intelligence
 * index (tree-sitter + SQLite knowledge graph) and steers the agent to answer
 * structural/flow questions from the graph instead of falling back to read/grep.
 *
 * Each tool shells out to the built `codegraph` CLI (no library/wasm coupling).
 * The binary is located via GRAPHCODE_CODEGRAPH_BIN (set by the graphcode launcher),
 * falling back to a `codegraph` on PATH.
 *
 * The graph is the primary retrieval surface: explore connects a flow across a bag
 * of named symbols, node returns full bodies + the caller/callee trail, and
 * callers/callees/impact answer reachability — all without opening files.
 */

import { spawnSync } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };

const CODEGRAPH_BIN = process.env.GRAPHCODE_CODEGRAPH_BIN?.trim() || "codegraph";

/**
 * The graph index lives under <repoRoot>/.codegraph. codegraph resolves it by
 * walking up from --path, so passing ctx.cwd is sufficient. The launcher exports
 * GRAPHCODE_REPO_ROOT for an explicit override (e.g. when cwd is a subdir).
 */
function repoRoot(ctx: ExtensionContext): string {
	return process.env.GRAPHCODE_REPO_ROOT?.trim() || ctx.cwd;
}

/** Run the codegraph CLI. Resolves with stdout on success; throws on hard failure. */
async function runCodegraph(
	pi: ExtensionAPI,
	args: string[],
	signal: AbortSignal | undefined,
): Promise<ExecResult> {
	// A .js/.mjs binary is run via node (portable; doesn't depend on the shebang,
	// which Windows ignores). A resolved PATH command is invoked directly.
	const isJs = CODEGRAPH_BIN.endsWith(".js") || CODEGRAPH_BIN.endsWith(".mjs");
	const cmd = isJs ? process.execPath : CODEGRAPH_BIN;
	const cmdArgs = isJs ? [CODEGRAPH_BIN, ...args] : args;
	return pi.exec(cmd, cmdArgs, { signal, timeout: 60_000 });
}

/** Format a codegraph CLI result for the agent. Empty output is steered, never an error. */
function present(label: string, query: string, result: ExecResult): string {
	const out = result.stdout.trim();
	if (result.code !== 0) {
		const err = result.stderr.trim() || out || `${label} exited ${result.code}`;
		// Recoverable: keep the agent on the graph, do not hard-error (errors teach abandonment).
		return `graph ${label} could not answer for "${query}":\n${err}\n\nTry codegraph_explore with a precise bag of symbol names, or another graph_* tool. Treat any source returned by these tools as already read.`;
	}
	if (!out) {
		return `graph ${label} found nothing for "${query}". Re-query with codegraph_explore using exact symbol names (include qualified Class.method names) that span the flow you want.`;
	}
	return out;
}

export default function graphcodeExtension(pi: ExtensionAPI) {
	// ── graph_explore: PRIMARY flow tool ────────────────────────────────────────
	// Takes a bag of symbol names and connects the call path among them, leading
	// with the flow and inlining source. This is the tool to reach for first.
	pi.registerTool({
		name: "graph_explore",
		label: "Graph Explore",
		description:
			"PRIMARY graph tool. Given a bag of symbol names (functions, methods, classes — " +
			"include qualified names like Class.method), connect and return the call flow among " +
			"them with inlined source. Use this FIRST for any 'how does X reach Y', trace, data-flow, " +
			"or 'where is this wired' question. The returned source is authoritative — do not re-read it.",
		promptSnippet:
			"graph_explore: connect a call flow across named symbols and return inlined source (use first for structural/flow questions)",
		promptGuidelines: [
			"Use graph_explore as the first step for any structural, flow, trace, or reachability question instead of read/grep.",
			"Pass graph_explore a precise bag of symbol names spanning the flow (qualified Class.method names help disambiguate overloads).",
			"Treat source returned by graph_explore as already read — do not open those files again.",
		],
		parameters: Type.Object({
			symbols: Type.String({
				description:
					"Space-separated bag of symbol names spanning the flow (e.g. 'AuthService loginUser SessionStore.create'). Include qualified Class.method names to disambiguate.",
			}),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const root = repoRoot(ctx);
			const result = await runCodegraph(pi, ["explore", params.symbols, "--path", root], signal);
			return {
				content: [{ type: "text", text: present("explore", params.symbols, result) }],
				details: { tool: "graph_explore", symbols: params.symbols },
			};
		},
	});

	// ── graph_node: full body + caller/callee trail (the read-killer) ───────────
	// Returns a symbol's complete source plus its caller/callee trail (every
	// overload's body for an ambiguous name) — the SECONDARY depth tool. This is
	// what replaces a Read: never open a file to inspect a symbol the graph knows.
	pi.registerTool({
		name: "graph_node",
		label: "Graph Node",
		description:
			"Return a symbol's FULL source body plus its caller/callee trail, straight from the graph " +
			"(every overload's body for an ambiguous name, in one call). Use this INSTEAD OF read when you " +
			"need to see a function/class/method's implementation — it returns the same source the Read tool " +
			"would, already line-numbered. Never Read a file to inspect a symbol; call graph_node.",
		promptSnippet:
			"graph_node: a symbol's full body + caller/callee trail (use INSTEAD OF read to inspect an implementation)",
		promptGuidelines: [
			"Use graph_node instead of read whenever you need to see a symbol's implementation — its output is authoritative source.",
		],
		parameters: Type.Object({
			symbol: Type.String({ description: "Symbol name (or a file path) to fetch the full body + trail for." }),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const root = repoRoot(ctx);
			const result = await runCodegraph(pi, ["node", params.symbol, "--path", root], signal);
			return {
				content: [{ type: "text", text: present("node", params.symbol, result) }],
				details: { tool: "graph_node", symbol: params.symbol },
			};
		},
	});

	// ── graph_search: locate symbols by name/text ───────────────────────────────
	pi.registerTool({
		name: "graph_search",
		label: "Graph Search",
		description:
			"Full-text search over the code knowledge graph. Returns matching symbols (with file, " +
			"line, kind, signature, docstring) ranked by relevance. Use to LOCATE the exact symbol " +
			"names you then feed to graph_explore. Faster and more precise than grep for finding definitions.",
		promptSnippet: "graph_search: find symbols by name/text in the code graph (use to locate names for graph_explore)",
		promptGuidelines: [
			"Use graph_search instead of grep to find where a symbol is defined.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search terms (symbol name or text)." }),
			kind: Type.Optional(
				Type.String({
					description:
						"Optional node-kind filter: function, method, class, interface, type_alias, route, component, etc.",
				}),
			),
			limit: Type.Optional(Type.Number({ description: "Max results (default 15)." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const root = repoRoot(ctx);
			const args = ["query", params.query, "--path", root, "--limit", String(params.limit ?? 15)];
			if (params.kind) args.push("--kind", params.kind);
			const result = await runCodegraph(pi, args, signal);
			return {
				content: [{ type: "text", text: present("search", params.query, result) }],
				details: { tool: "graph_search", query: params.query },
			};
		},
	});

	// ── graph_callers / graph_callees: reachability ─────────────────────────────
	for (const dir of ["callers", "callees"] as const) {
		const blurb =
			dir === "callers"
				? "List every symbol that CALLS the given symbol (its incoming call sites)"
				: "List every symbol the given symbol CALLS (its outgoing calls)";
		pi.registerTool({
			name: `graph_${dir}`,
			label: `Graph ${dir[0].toUpperCase()}${dir.slice(1)}`,
			description: `${blurb}, straight from the call graph. Use instead of grepping for call sites. Answers reachability in one call.`,
			promptSnippet: `graph_${dir}: list ${dir} of a symbol from the call graph (use instead of grep for call sites)`,
			parameters: Type.Object({
				symbol: Type.String({ description: "Symbol name (qualified Class.method to disambiguate)." }),
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				const root = repoRoot(ctx);
				const result = await runCodegraph(pi, [dir, params.symbol, "--path", root], signal);
				return {
					content: [{ type: "text", text: present(dir, params.symbol, result) }],
					details: { tool: `graph_${dir}`, symbol: params.symbol },
				};
			},
		});
	}

	// ── graph_impact: blast radius ──────────────────────────────────────────────
	pi.registerTool({
		name: "graph_impact",
		label: "Graph Impact",
		description:
			"Compute the impact radius (blast radius) of a symbol — the transitive set of code affected " +
			"if it changes. Use before refactors and to scope reviews, instead of manually tracing references.",
		promptSnippet: "graph_impact: transitive blast radius of a symbol (use to scope refactors/reviews)",
		parameters: Type.Object({
			symbol: Type.String({ description: "Symbol name to compute impact for." }),
			depth: Type.Optional(Type.Number({ description: "Traversal depth (default 2)." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const root = repoRoot(ctx);
			const result = await runCodegraph(
				pi,
				["impact", params.symbol, "--path", root, "--depth", String(params.depth ?? 2)],
				signal,
			);
			return {
				content: [{ type: "text", text: present("impact", params.symbol, result) }],
				details: { tool: "graph_impact", symbol: params.symbol },
			};
		},
	});

	// ── graph-first steering: appended to the system prompt every turn ──────────
	pi.on("before_agent_start", async (event, ctx) => {
		let indexed = false;
		try {
			// Array args, no shell — no quoting/injection risk even if the path has spaces.
			const isJs = CODEGRAPH_BIN.endsWith(".js") || CODEGRAPH_BIN.endsWith(".mjs");
			const cmd = isJs ? process.execPath : CODEGRAPH_BIN;
			const cmdArgs = isJs ? [CODEGRAPH_BIN, "status", "--json"] : ["status", "--json"];
			const r = spawnSync(cmd, cmdArgs, {
				cwd: repoRoot(ctx),
				encoding: "utf8",
				timeout: 15_000,
				stdio: ["ignore", "pipe", "ignore"],
			});
			indexed = r.status === 0 && JSON.parse(r.stdout || "{}")?.initialized === true;
		} catch {
			indexed = false;
		}
		if (!indexed) return undefined;

		return {
			systemPrompt:
				(event.systemPrompt ?? "") +
				`

## Graph-native retrieval (graphcode)

This repository is indexed as a code knowledge graph. The graph_* tools are your PRIMARY and
DEFAULT retrieval surface — not a fallback. Lead with them.

THE LOOP (follow it in order):
1. START with graph_explore. Your FIRST tool call should be graph_explore with a bag of the
   symbol names the task mentions (and the obvious entry points). graph_explore returns the
   call flow among them AND their inlined source in one shot. Do NOT graph_search first to
   "find names" — explore already resolves names; searching first wastes a turn. Refine by
   calling graph_explore again with a better/expanded symbol bag.
2. To inspect ONE symbol's full implementation, call graph_node — NOT read. graph_node returns
   the same line-numbered source the Read tool would, plus the caller/callee trail. There is no
   reason to read a file for a symbol the graph knows.
3. Only use graph_search when you genuinely don't know a symbol's name yet (a concept, not a
   name). Use graph_callers / graph_callees for explicit call-site / callee questions, and
   graph_impact for blast radius.

NEVER do these:
- Do NOT open files with read or scan with grep to reconstruct a flow or inspect a symbol.
  graph_explore + graph_node already give you authoritative, line-numbered source.
- Do NOT treat graph source as a hint to then go read the "real" file — it IS the real file,
  re-read from disk on each call. Re-reading is wasted work.

Only fall back to read/grep when the graph truly cannot answer: local data-flow with no edges,
or free text that is not a symbol (log strings, comments). Default to the graph. The graph
exists so you can stop reading — a clean run is a few graph calls and ZERO reads.`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.notify("graphcode: graph-native tools active", "info");
	});
}
