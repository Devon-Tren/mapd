/**
 * resolution.js — `mapd resolution`. Call resolution is 25% of the confidence
 * score, but the raw rate doesn't tell you WHERE to act. This ranks the call
 * sites dragging it down by real blast radius, names the anonymous functions
 * that hide edges, and — crucially — does NOT treat calls into external
 * packages as your problem to fix.
 *
 * All deterministic: it reads the call edges the graph already classified
 * (external / cross-file / dynamic / unresolved / local / global) plus the
 * parsed function list. No guessing which call "should" resolve.
 */

const fileOf = (ref) => String(ref).split("#")[0];
const ANON = /^<anon[:>]/;

export function analyzeResolution(graph, { top = 10 } = {}) {
  const edges = graph.callEdges ?? [];
  const byType = {};
  for (const e of edges) byType[e.resolution] = (byType[e.resolution] ?? 0) + 1;

  const wfByFile = new Map();
  for (const w of graph.workflows) for (const f of w.files) {
    if (!wfByFile.has(f)) wfByFile.set(f, []);
    wfByFile.get(f).push(w.id);
  }

  // Hotspots: files with the most fixable (dynamic + unresolved) call sites,
  // ranked by count × workflow blast radius. External/local/global are excluded —
  // external is not yours to fix, local/global already resolve.
  const fixable = edges.filter((e) => e.resolution === "dynamic" || e.resolution === "unresolved");
  const perFile = new Map();
  for (const e of fixable) {
    const f = fileOf(e.from);
    const rec = perFile.get(f) ?? { file: f, dynamic: 0, unresolved: 0, receivers: new Set() };
    if (e.resolution === "dynamic") { rec.dynamic++; if (e.dynamicReceiver) rec.receivers.add(e.dynamicReceiver); }
    else rec.unresolved++;
    perFile.set(f, rec);
  }
  const hotspots = [...perFile.values()].map((r) => {
    const workflows = wfByFile.get(r.file) ?? [];
    const count = r.dynamic + r.unresolved;
    return {
      file: r.file, dynamic: r.dynamic, unresolved: r.unresolved, count,
      workflows, blastRadius: workflows.length,
      receivers: [...r.receivers].slice(0, 6),
      score: count * Math.max(1, workflows.length), // rank: volume × reach
    };
  }).sort((a, b) => b.score - a.score).slice(0, top);

  // Anonymous functions hide call edges (an unnamed callee can't be resolved).
  const anon = graph.files.map((f) => ({
    file: f.file,
    count: (f.functions ?? []).filter((fn) => !fn.name || ANON.test(fn.name)).length,
  })).filter((x) => x.count > 0).sort((a, b) => b.count - a.count).slice(0, top);

  const totalCalls = graph.stats.totalCalls ?? edges.length;
  const external = byType.external ?? 0;

  return {
    summary: {
      totalCalls,
      resolutionRate: graph.stats.callResolutionRate ?? null,
      byType,
      fixable: fixable.length,
      externalExcused: external,
    },
    hotspots,
    anonymous: anon,
    anonymousTotal: graph.files.reduce((a, f) => a + (f.functions ?? []).filter((fn) => !fn.name || ANON.test(fn.name)).length, 0),
  };
}

export function renderResolution(data, theme) {
  const { bold, dim, red, green, yellow, cyan } = theme;
  const s = data.summary;
  const lines = [`\n${bold("Call resolution")} — rate ${s.resolutionRate != null ? cyan(s.resolutionRate.toFixed(3)) : "n/a"} over ${s.totalCalls} call(s)`];
  const order = ["cross-file", "local", "global", "dynamic", "unresolved", "external"];
  lines.push("  by type: " + order.filter((t) => s.byType[t]).map((t) => `${t} ${s.byType[t]}`).join(" · "));
  lines.push(dim(`  ${s.externalExcused} external call(s) into packages are NOT counted against you — Map'd can't resolve into node_modules and doesn't pretend to.`));

  lines.push(`\n${bold("  Resolution hotspots")} ${dim("(fixable call sites × workflow blast radius)")}`);
  if (!data.hotspots.length) lines.push(green("    None — every fixable call already resolves."));
  for (const h of data.hotspots) {
    lines.push(`    ${bold(h.file)}  ${yellow(`${h.count} fixable`)} ${dim(`(${h.dynamic} dynamic, ${h.unresolved} unresolved; reaches ${h.blastRadius} workflow(s))`)}`);
    if (h.receivers.length) lines.push(dim(`        dynamic receivers: ${h.receivers.join(", ")} — if a receiver resolves to a constant path it can be made static; if it's computed at runtime, keep it lazy and consider annotating dynamically-loaded.`));
  }

  lines.push(`\n${bold("  Anonymous functions")} ${dim(`(${data.anonymousTotal} total — naming them lets callers resolve)`)}`);
  if (!data.anonymous.length) lines.push(green("    None."));
  for (const a of data.anonymous) lines.push(`    ${a.file}  ${dim(`${a.count} anonymous`)}`);
  return lines.join("\n");
}
