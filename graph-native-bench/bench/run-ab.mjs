#!/usr/bin/env node
/**
 * A/B benchmark: graph-native pi (with the graphcode extension) vs vanilla pi.
 *
 * Both arms run the SAME model (civitas/claude-sonnet-4-6, the codegraph floor model),
 * the SAME prompt, on the SAME repo. We measure, per run:
 *   - wall-clock duration
 *   - tool-call counts by name (graph_* vs read/grep/bash/find/ls)
 *
 * Tool counts come from the pi session transcript (.jsonl) the run writes.
 *
 * Usage:
 *   node run-ab.mjs --repo /tmp/gc_target --runs 3 --prompt "..."
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRODUCT_ROOT = resolve(__dirname, "..");
const LAUNCHER = join(PRODUCT_ROOT, "bin", "graphcode.mjs");
const PI_DIR = process.env.GRAPHCODE_PI_DIR || "/tmp/graphcode_clone";
const PI_TSX = join(PI_DIR, "node_modules", ".bin", "tsx");
const PI_CLI = join(PI_DIR, "packages", "coding-agent", "src", "cli.ts");
const PI_TSCONFIG = join(PI_DIR, "tsconfig.json");
const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

const READ_TOOLS = new Set(["read", "grep", "find", "ls", "bash"]);
const GRAPH_TOOLS_PREFIX = "graph_";

function parseArgs(argv) {
	const out = { repo: "/tmp/gc_target", runs: 3, provider: "civitas", model: "claude-sonnet-4-6", prompt: "" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--repo") out.repo = argv[++i];
		else if (a === "--runs") out.runs = Number(argv[++i]);
		else if (a === "--provider") out.provider = argv[++i];
		else if (a === "--model") out.model = argv[++i];
		else if (a === "--prompt") out.prompt = argv[++i];
	}
	return out;
}

function sessionDirForRepo(repo) {
	// pi slugifies the cwd: leading/trailing -- and / -> -.
	const real = repo.startsWith("/tmp/") ? `/private${repo}` : repo;
	const slug = `--${real.replace(/[/]/g, "-").replace(/^-+/, "").replace(/-+$/, "")}--`;
	const dir = join(SESSIONS_DIR, slug);
	return existsSync(dir) ? dir : null;
}

function newestSessionFile(dir, sinceMs) {
	if (!dir || !existsSync(dir)) return null;
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => ({ f: join(dir, f), m: statSync(join(dir, f)).mtimeMs }))
		.filter((x) => x.m >= sinceMs)
		.sort((a, b) => b.m - a.m);
	return files[0]?.f ?? null;
}

function countTools(transcriptFile) {
	const counts = {};
	if (!transcriptFile || !existsSync(transcriptFile)) return counts;
	const text = readFileSync(transcriptFile, "utf8");
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let obj;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		// Tool calls appear as message entries with role assistant containing tool_call content,
		// or as toolName-bearing entries. Count assistant tool_use content blocks.
		const msg = obj.message;
		if (msg?.role === "assistant" && Array.isArray(msg.content)) {
			for (const c of msg.content) {
				if (c?.type === "toolCall" || c?.type === "tool_use" || c?.type === "tool_call") {
					const name = c.name || c.toolName;
					if (name) counts[name] = (counts[name] ?? 0) + 1;
				}
			}
		}
		// Fallback: top-level toolName on tool-result rows (count the call side only via assistant above).
	}
	return counts;
}

function summarize(counts) {
	let graph = 0;
	let reads = 0;
	let total = 0;
	for (const [name, n] of Object.entries(counts)) {
		total += n;
		if (name.startsWith(GRAPH_TOOLS_PREFIX)) graph += n;
		else if (READ_TOOLS.has(name)) reads += n;
	}
	return { total, graph, reads, byTool: counts };
}

function runArm(kind, opts) {
	const sinceMs = Date.now();
	const promptArgs = ["--provider", opts.provider, "--model", opts.model, "-p", opts.prompt];
	let cmd;
	let args;
	if (kind === "graph") {
		cmd = process.execPath;
		args = [LAUNCHER, "--path", opts.repo, "--no-index", ...promptArgs];
	} else {
		cmd = PI_TSX;
		args = ["--tsconfig", PI_TSCONFIG, PI_CLI, "--approve", ...promptArgs];
	}
	const t0 = Date.now();
	const res = spawnSync(cmd, args, {
		cwd: opts.repo,
		encoding: "utf8",
		env: process.env,
		timeout: 300_000,
		maxBuffer: 64 * 1024 * 1024,
	});
	const durationMs = Date.now() - t0;
	const dir = sessionDirForRepo(opts.repo);
	const transcript = newestSessionFile(dir, sinceMs);
	const counts = countTools(transcript);
	const sum = summarize(counts);
	return {
		kind,
		durationMs,
		...sum,
		ok: res.status === 0,
		answerTail: (res.stdout || "").trim().slice(-300),
	};
}

function mean(xs) {
	return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function median(xs) {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (!opts.prompt) {
		process.stderr.write("run-ab: --prompt required\n");
		process.exit(1);
	}
	if (!existsSync(PI_TSX)) {
		process.stderr.write(`run-ab: pi tsx not found at ${PI_TSX}; set GRAPHCODE_PI_DIR\n`);
		process.exit(1);
	}
	const arms = { graph: [], vanilla: [] };
	for (let r = 0; r < opts.runs; r++) {
		for (const kind of ["graph", "vanilla"]) {
			process.stderr.write(`run ${r + 1}/${opts.runs} [${kind}] ...\n`);
			const result = runArm(kind, opts);
			arms[kind].push(result);
			process.stderr.write(
				`  ${kind}: ${(result.durationMs / 1000).toFixed(1)}s  total=${result.total} graph=${result.graph} reads=${result.reads}  byTool=${JSON.stringify(result.byTool)}\n`,
			);
		}
	}

	const report = {};
	for (const kind of ["graph", "vanilla"]) {
		const rs = arms[kind];
		report[kind] = {
			runs: rs.length,
			medianDurationS: +(median(rs.map((r) => r.durationMs)) / 1000).toFixed(1),
			medianTotalTools: median(rs.map((r) => r.total)),
			medianGraphCalls: median(rs.map((r) => r.graph)),
			medianReadGrep: median(rs.map((r) => r.reads)),
			meanReadGrep: +mean(rs.map((r) => r.reads)).toFixed(2),
			raw: rs.map((r) => ({ durationS: +(r.durationMs / 1000).toFixed(1), total: r.total, graph: r.graph, reads: r.reads, byTool: r.byTool })),
		};
	}
	console.log(JSON.stringify({ opts: { repo: opts.repo, model: opts.model, runs: opts.runs, prompt: opts.prompt }, report }, null, 2));
}

main();
