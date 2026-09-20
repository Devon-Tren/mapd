/**
 * trace.js — `mapd trace <file>` and `mapd trace <from> <to>`.
 *
 * One command answers both reachability questions the wishlist asked for:
 *   trace <file>         why this file is in / out of a workflow — its workflow
 *                        membership, the shortest import/call chain from an entry
 *                        point that reaches it, or the exact reason it's uncovered
 *                        (orphan, generated, dynamically-loaded, annotated dormant,
 *                        heuristic-unverified, or excluded).
 *   trace <from> <to>    the concrete import/call chain connecting two files.
 *
 * Deterministic: it walks the real import and cross-file call edges the graph
 * already computed. If two files are connected only dynamically, it says so
 * rather than inventing a path.
 */

import path from "node:path";

/** Resolve a user-typed path to a real graph file: exact, else unique suffix match. */
export function resolveFile(graph, arg) {
  const norm = arg.replace(/^\.\//, "");
  if (graph.files.some((f) => f.file === norm)) return { file: norm };
  const suffix = graph.files.filter((f) => f.file === norm || f.file.endsWith(`/${norm}`) || path.posix.basename(f.file) === norm);
  if (suffix.length === 1) return { file: suffix[0].file };
  if (suffix.length > 1) return { ambiguous: suffix.map((f) => f.file) };
  return { notFound: true };
}

/** file→[{to, via}] adjacency over internal import edges and cross-file call edges. */
function buildAdjacency(graph) {
  const adj = new Map();
  const push = (from, to, via) => {
    if (from === to) return;
    if (!adj.has(from)) adj.set(from, []);
    const list = adj.get(from);
    if (!list.some((e) => e.to === to && e.via === via)) list.push({ to, via });
  };
  for (const e of graph.importEdges ?? []) if (e.to) push(e.from, e.to, "import");
  for (const e of graph.callEdges ?? []) {
    if (e.resolution === "cross-file" && e.to) {
      const toFile = String(e.to).split("#")[0];
      const fromFile = String(e.from).split("#")[0];
      push(fromFile, toFile, "call");
    }
  }
  return adj;
}

/** Shortest edge path from `start` to `goal` (BFS). Returns [{from,to,via}] or null. */
function shortestPath(adj, start, goal) {
  if (start === goal) return [];
  const prev = new Map([[start, null]]);
  const q = [start];
  while (q.length) {
    const cur = q.shift();
    for (const e of adj.get(cur) ?? []) {
      if (prev.has(e.to)) continue;
      prev.set(e.to, { from: cur, via: e.via });
      if (e.to === goal) {
        const chain = [];
        let node = goal;
        while (prev.get(node)) { const p = prev.get(node); chain.unshift({ from: p.from, to: node, via: p.via }); node = p.from; }
        return chain;
      }
      q.push(e.to);
    }
  }
  return null;
}

const REACH_LABELS = {
  generatedArtifacts: "a generated/build artifact",
  dynamicallyLoaded: "loaded dynamically (detected)",
  intentionalDormant: "annotated intentional-dormant",
  heuristicUnverified: "heuristic-parsed and unverifiable by import tracing",
  trulyOrphaned: "an orphan — reached by no entry point",
};

/** Why is <file> in / out of a workflow? */
export function traceFile(graph, file) {
  const adj = buildAdjacency(graph);
  const workflows = graph.workflows.filter((w) => w.files.includes(file));
  const importers = (graph.importEdges ?? []).filter((e) => e.to === file).map((e) => e.from);

  const result = { file, inWorkflow: workflows.length > 0, workflows: workflows.map((w) => w.id), importers };

  if (workflows.length) {
    // shortest chain from the containing workflow's entry to this file
    for (const w of workflows) {
      const p = shortestPath(adj, w.entry.file, file);
      if (p) { result.reachedFrom = { entry: w.entry.file, workflow: w.id, chain: p }; break; }
    }
    if (!result.reachedFrom) result.reachedNote = "in the workflow's file set but not via a static import/call chain from the entry (likely wired by a detected dynamic edge or annotation).";
    return result;
  }

  // uncovered — find the exact reason
  const r = graph.reachability ?? {};
  const has = (bucket) => (r[bucket] ?? []).some((x) => (typeof x === "string" ? x : x.file) === file);
  for (const bucket of Object.keys(REACH_LABELS)) if (has(bucket)) { result.classification = bucket; result.reason = REACH_LABELS[bucket]; return result; }
  if ((graph.orphans ?? []).includes(file)) { result.classification = "trulyOrphaned"; result.reason = REACH_LABELS.trulyOrphaned; return result; }
  if ((graph.generatedFiles ?? []).some((g) => (g.file ?? g) === file)) { result.classification = "generatedArtifacts"; result.reason = REACH_LABELS.generatedArtifacts; return result; }
  result.classification = "uncovered";
  result.reason = "not in any workflow and not classified — it may be imported only by uncovered files, or reachable only dynamically.";
  return result;
}

/** The import/call chain from <from> to <to> (or the reverse if that's the real direction). */
export function tracePath(graph, from, to) {
  const adj = buildAdjacency(graph);
  const forward = shortestPath(adj, from, to);
  if (forward) return { from, to, direction: "forward", chain: forward };
  const backward = shortestPath(adj, to, from);
  if (backward) return { from, to, direction: "reverse", chain: backward, note: `${to} reaches ${from}, not the other way around.` };
  return { from, to, chain: null, note: "no static import/call chain connects these files — they may be linked only through a dynamic edge, or not at all." };
}

// ── renderers ────────────────────────────────────────────────────────────────

export function renderTraceFile(data, theme) {
  const { bold, dim, green, yellow, red, cyan } = theme;
  const lines = [`\n${bold("trace")} ${cyan(data.file)}`];
  if (data.inWorkflow) {
    lines.push(`  ${green("in workflow(s):")} ${data.workflows.join(", ")}`);
    if (data.reachedFrom) {
      lines.push(`  reached from ${bold(data.reachedFrom.entry)} ${dim(`(${data.reachedFrom.workflow})`)}:`);
      lines.push(`      ${data.reachedFrom.entry}`);
      for (const step of data.reachedFrom.chain) lines.push(`        ${dim(step.via === "call" ? "──calls──▶" : "──imports──▶")} ${step.to}`);
    } else if (data.reachedNote) {
      lines.push(dim(`  ${data.reachedNote}`));
    }
  } else {
    lines.push(`  ${yellow("not in any workflow")} — ${data.reason}`);
    lines.push(dim(`  classification: ${data.classification}`));
  }
  if (data.importers.length) lines.push(dim(`  imported by: ${data.importers.slice(0, 8).join(", ")}${data.importers.length > 8 ? " …" : ""}`));
  else if (!data.inWorkflow) lines.push(dim("  imported by: (nothing static)"));
  return lines.join("\n");
}

export function renderTracePath(data, theme) {
  const { bold, dim, green, red, cyan } = theme;
  const lines = [`\n${bold("trace")} ${cyan(data.from)} ${dim("→")} ${cyan(data.to)}`];
  if (!data.chain) { lines.push(`  ${red("no path")} — ${data.note}`); return lines.join("\n"); }
  if (data.note) lines.push(dim(`  ${data.note}`));
  const start = data.direction === "reverse" ? data.to : data.from;
  lines.push(`  ${green("path")} (${data.chain.length} hop(s)):`);
  lines.push(`      ${start}`);
  for (const step of data.chain) lines.push(`        ${dim(step.via === "call" ? "──calls──▶" : "──imports──▶")} ${step.to}`);
  return lines.join("\n");
}
