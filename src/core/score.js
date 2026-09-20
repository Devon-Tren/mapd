/**
 * score.js — Score Intelligence. Turns the derived confidence number into an
 * auditable account of WHY it is what it is, what it would become under a
 * hypothetical, its honest maximum, and how it moved since the baseline.
 *
 * THE RULE: this file never invents a formula. It reads the signal values +
 * weights that confidence.js already stores next to every score, and for
 * what-if math it re-runs confidence.js's OWN scorer through the optional `sim`
 * hook. If a signal is unavailable (e.g. no git → stability), that shows up as
 * reduced signalCoverage, never as a faked value — including at the ceiling.
 */

import { buildScoredGraph } from "./intelligence.js";
import { scoreWorkflow } from "./confidence.js";
import { loadBaseline } from "./regression.js";
import { bold, dim, red, green, yellow, cyan, confidenceColor } from "./theme.js";

const r3 = (x) => Number(x.toFixed(3));

/** Signal weights are fixed in confidence.js; mirror their intent for prose. */
const SIGNAL_BLURB = {
  parseIntegrity: "workflow files parsed cleanly (heuristic-parsed files earn half credit)",
  resolutionRate: "call edges resolved to a definition",
  testPresence: "workflow files with a matching test file",
  stability: "inverse code churn (needs git history)",
  coverageOfRepo: "repo files reached by any workflow",
};

/**
 * Decompose a scored graph into per-signal contributions. For each available
 * signal in a workflow: effectiveWeight = weight / (sum of available weights),
 * contribution = value × effectiveWeight (these sum to the workflow score),
 * cost = (1 − value) × effectiveWeight (what this weak signal costs the score).
 * Repo-wide figures weight each workflow by its file share — the same size
 * weighting scoreGraph uses for repoConfidence — so repo contributions sum
 * back to repoConfidence.
 */
export function explainScore(graph) {
  const totalFiles = graph.workflows.reduce((a, w) => a + w.files.length, 0) || 1;

  const workflows = graph.workflows.map((w) => {
    const c = w.confidence;
    const availWeight = Object.values(c.signals)
      .filter((s) => !s.unavailable && s.value !== null)
      .reduce((a, s) => a + s.weight, 0) || 1;
    const fileShare = r3(w.files.length / totalFiles);

    const signals = Object.entries(c.signals).map(([signal, s]) => {
      if (s.unavailable || s.value === null) {
        return { signal, value: null, weight: s.weight, unavailable: true, effectiveWeight: 0, contribution: 0, cost: 0 };
      }
      const eff = s.weight / availWeight;
      return {
        signal, value: s.value, weight: s.weight,
        effectiveWeight: r3(eff),
        contribution: r3(s.value * eff),
        cost: r3((1 - s.value) * eff),
      };
    });
    return { id: w.id, score: c.score, signalCoverage: c.signalCoverage, files: w.files.length, fileShare, signals };
  });

  const repoSignals = {};
  for (const w of workflows) {
    for (const s of w.signals) {
      const acc = (repoSignals[s.signal] ??= { signal: s.signal, weight: s.weight, contribution: 0, cost: 0, availableShare: 0, unavailableIn: 0 });
      if (s.unavailable) { acc.unavailableIn++; continue; }
      acc.contribution += s.contribution * w.fileShare;
      acc.cost += s.cost * w.fileShare;
      acc.availableShare += w.fileShare;
    }
  }
  for (const acc of Object.values(repoSignals)) {
    acc.contribution = r3(acc.contribution);
    acc.cost = r3(acc.cost);
    acc.availableShare = r3(acc.availableShare);
  }

  return {
    repoConfidence: graph.repoConfidence,
    method: graph.workflows[0]?.confidence.method ?? null,
    workflows,
    repoSignals: Object.values(repoSignals).sort((a, b) => b.cost - a.cost),
  };
}

/**
 * Rescore under a `sim` hook WITHOUT mutating or cloning the graph. scoreWorkflow
 * is pure over the graph (it reads, returns a fresh confidence, and the honest-
 * test set is WeakMap-cached on the real graph so it's computed once), so we just
 * call it per workflow and re-aggregate exactly as scoreGraph does — turning each
 * what-if from a full deep-clone (~1s on a mid repo) into a few milliseconds,
 * which is what makes `mapd improve` (dozens of sims) fast enough for chat.
 */
function simScores(rootDir, graph, sim) {
  const workflows = graph.workflows.map((wf) => ({
    id: wf.id,
    files: wf.files,
    confidence: scoreWorkflow(rootDir, graph, wf, sim),
  }));
  const total = workflows.reduce((a, w) => a + w.files.length, 0) || 1;
  const repoConfidence = Number(workflows.reduce((a, w) => a + w.confidence.score * (w.files.length / total), 0).toFixed(3));
  return { repoConfidence, workflows };
}

/**
 * The honest maximum reachable by in-repo verification work — writing tests,
 * fixing parse errors on AST files, resolving calls, wiring uncovered files —
 * while HOLDING git-derived stability at its currently observed value (you
 * can't fabricate churn history) and leaving heuristic-parsed files at their
 * structural half credit (regex-tier extraction genuinely knows less than an
 * AST). Anything the ceiling can't close is reported as a structural cap, not
 * hidden.
 */
export function ceilingScore(rootDir, graph) {
  const astFiles = new Set(graph.files.filter((f) => f.parserKind !== "heuristic").map((f) => f.file));
  const wfFiles = new Set(graph.workflows.flatMap((w) => w.files));
  const heuristicWfFiles = [...wfFiles].filter((f) => !astFiles.has(f));

  const sim = {
    addTests: wfFiles,                    // every workflow file could get a test
    fixParse: astFiles,                   // AST parse errors are fixable; heuristic files are not
    resolutionRate: 1,                    // assumes every call is resolvable (see caveat)
    coverageOfRepo: 1,                    // assumes every repo file is intentionally covered (see caveat)
  };
  const ceiling = simScores(rootDir, graph, sim);

  const noGit = graph.workflows.some((w) =>
    Object.values(w.confidence.signals).some((s) => s.unavailable));

  const caps = [];
  if (heuristicWfFiles.length) {
    caps.push({
      cap: "heuristic-parse",
      structural: true,
      detail: `${heuristicWfFiles.length} workflow file(s) are parsed by heuristic language adapters and cap parseIntegrity at half credit — only switching to a full parser (or the language gaining one) lifts this.`,
    });
  }
  if (noGit) {
    caps.push({
      cap: "no-git-stability",
      structural: true,
      detail: "No git history → the stability signal stays unavailable; even at the ceiling, signalCoverage is below 1.0 (the score is honest, but backed by less evidence).",
    });
  }

  return {
    current: graph.repoConfidence,
    ceiling: ceiling.repoConfidence,
    headroom: r3(ceiling.repoConfidence - graph.repoConfidence),
    ceilingSignalCoverage: r3(
      ceiling.workflows.reduce((a, w) => a + w.confidence.signalCoverage * w.files.length, 0) /
      (ceiling.workflows.reduce((a, w) => a + w.files.length, 0) || 1)
    ),
    assumptions: [
      "all workflow files gain a test",
      "all AST parse errors are fixed",
      "resolutionRate reaches 1.0 (optimistic: some calls into external packages or dynamic dispatch may never resolve)",
      "coverageOfRepo reaches 1.0 (optimistic: intentionally-dormant files should be annotated, not wired in)",
      "stability held at its current observed value",
    ],
    caps,
    workflows: ceiling.workflows.map((w) => ({ id: w.id, current: graph.workflows.find((g) => g.id === w.id)?.confidence.score, ceiling: w.confidence.score })),
  };
}

/**
 * What-if. Applies a hypothetical change and re-runs confidence.js's own scorer.
 * mutations: { addTests?: string[], fixParse?: string[], resolutionRate?: number, coverageOfRepo?: number }
 * Returns before/after with per-workflow deltas and a note for any named file
 * that matches no workflow file (so a typo can't masquerade as "no effect").
 */
export function simulateScore(rootDir, graph, mutations = {}) {
  const wfFiles = new Set(graph.workflows.flatMap((w) => w.files));
  const norm = (arr) => (arr ?? []).map((f) => f.replace(/^\.\//, ""));

  const addTests = norm(mutations.addTests);
  const fixParse = norm(mutations.fixParse);
  const unmatched = [...addTests, ...fixParse].filter((f) => !wfFiles.has(f));

  const sim = {};
  if (addTests.length) sim.addTests = new Set(addTests);
  if (fixParse.length) sim.fixParse = new Set(fixParse);
  if (mutations.resolutionRate != null) sim.resolutionRate = mutations.resolutionRate;
  if (mutations.coverageOfRepo != null) sim.coverageOfRepo = mutations.coverageOfRepo;

  const after = simScores(rootDir, graph, sim);

  return {
    before: graph.repoConfidence,
    after: after.repoConfidence,
    delta: r3(after.repoConfidence - graph.repoConfidence),
    mutations: {
      addTests, fixParse,
      ...(mutations.resolutionRate != null ? { resolutionRate: mutations.resolutionRate } : {}),
      ...(mutations.coverageOfRepo != null ? { coverageOfRepo: mutations.coverageOfRepo } : {}),
    },
    unmatched,
    workflows: after.workflows.map((w) => {
      const b = graph.workflows.find((g) => g.id === w.id)?.confidence.score ?? null;
      return { id: w.id, before: b, after: w.confidence.score, delta: b == null ? null : r3(w.confidence.score - b) };
    }).filter((w) => w.delta == null || w.delta !== 0),
  };
}

/**
 * Why confidence changed since the baseline snapshot (no git required — the
 * baseline graph is a stored snapshot). Attributes the repoConfidence move to
 * per-signal contribution changes (which fold in both value moves and file-share
 * moves), plus workflows that appeared or disappeared.
 */
export function deltaScore(baselineGraph, currentGraph) {
  const be = explainScore(baselineGraph);
  const ce = explainScore(currentGraph);
  const bySignal = new Map(be.repoSignals.map((s) => [s.signal, s]));

  const signals = ce.repoSignals.map((s) => {
    const b = bySignal.get(s.signal);
    return { signal: s.signal, from: b?.contribution ?? 0, to: s.contribution, delta: r3(s.contribution - (b?.contribution ?? 0)) };
  }).filter((s) => s.delta !== 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const baseWf = new Map(baselineGraph.workflows.map((w) => [w.id, w]));
  const curWf = new Map(currentGraph.workflows.map((w) => [w.id, w]));
  const added = [...curWf.keys()].filter((id) => !baseWf.has(id));
  const removed = [...baseWf.keys()].filter((id) => !curWf.has(id));

  return {
    from: baselineGraph.repoConfidence,
    to: currentGraph.repoConfidence,
    delta: r3(currentGraph.repoConfidence - baselineGraph.repoConfidence),
    signals,
    workflowsAdded: added,
    workflowsRemoved: removed,
  };
}

// ── renderers ────────────────────────────────────────────────────────────────

const pct = (x) => (x >= 0 ? "+" : "") + x.toFixed(3);
const signed = (x) => (x > 0 ? green(pct(x)) : x < 0 ? red(pct(x)) : dim(pct(x)));

export function renderExplain(data, { workflow } = {}) {
  const lines = [`\n${bold("Score explain")} — repo confidence ${confidenceColor(data.repoConfidence)(data.repoConfidence)}`];
  lines.push(dim(`  ${data.method ?? ""}`));
  lines.push("");
  lines.push(bold("  Repo-wide — what each signal contributes / costs"));
  for (const s of data.repoSignals) {
    const tail = s.unavailableIn ? dim(`  (unavailable in ${s.unavailableIn} workflow(s))`) : "";
    lines.push(`    ${cyan(s.signal.padEnd(16))} contributes ${green(s.contribution.toFixed(3))}  costs ${s.cost > 0 ? yellow(s.cost.toFixed(3)) : dim("0.000")}${tail}`);
    lines.push(dim(`        ${SIGNAL_BLURB[s.signal] ?? ""}`));
  }
  const shown = workflow ? data.workflows.filter((w) => w.id === workflow) : data.workflows;
  for (const w of shown) {
    lines.push("");
    lines.push(`  ${confidenceColor(w.score)(`[${w.score}]`)} ${bold(w.id)}  ${dim(`${w.files} files · share ${w.fileShare} · signalCoverage ${w.signalCoverage}`)}`);
    for (const s of w.signals) {
      if (s.unavailable) { lines.push(`      ${dim(s.signal.padEnd(16))} ${dim("unavailable — weight redistributed")}`); continue; }
      lines.push(`      ${s.signal.padEnd(16)} value ${s.value.toFixed(3)}  →  contributes ${s.contribution.toFixed(3)}  ${s.cost > 0 ? yellow(`(costs ${s.cost.toFixed(3)})`) : dim("(maxed)")}`);
    }
  }
  return lines.join("\n");
}

export function renderCeiling(data) {
  const lines = [`\n${bold("Score ceiling")} — honest maximum under current constraints`];
  lines.push(`  current ${confidenceColor(data.current)(data.current)}  →  ceiling ${confidenceColor(data.ceiling)(data.ceiling)}  ${dim(`(headroom ${signed(data.headroom)})`)}`);
  lines.push(`  ceiling signalCoverage: ${data.ceilingSignalCoverage < 1 ? yellow(data.ceilingSignalCoverage) : green(data.ceilingSignalCoverage)}${data.ceilingSignalCoverage < 1 ? dim("  (below 1.0 — even maxed, some evidence is missing)") : ""}`);
  lines.push("");
  lines.push(bold("  Assumes:"));
  for (const a of data.assumptions) lines.push(`    ${dim("·")} ${a}`);
  if (data.caps.length) {
    lines.push("");
    lines.push(bold("  Structural caps (cannot be closed by in-repo work):"));
    for (const c of data.caps) lines.push(`    ${yellow("▪")} ${c.detail}`);
  } else {
    lines.push("");
    lines.push(green("  No structural caps — 1.0 is honestly reachable with the work above."));
  }
  return lines.join("\n");
}

export function renderSimulate(data) {
  const lines = [`\n${bold("Score simulate")} — what-if`];
  const m = data.mutations;
  const desc = [];
  if (m.addTests.length) desc.push(`add tests for ${m.addTests.length} file(s)`);
  if (m.fixParse.length) desc.push(`fix parse on ${m.fixParse.length} file(s)`);
  if (m.resolutionRate != null) desc.push(`resolutionRate → ${m.resolutionRate}`);
  if (m.coverageOfRepo != null) desc.push(`coverageOfRepo → ${m.coverageOfRepo}`);
  lines.push(dim(`  hypothesis: ${desc.join("; ") || "(none)"}`));
  lines.push(`  repo confidence ${confidenceColor(data.before)(data.before)}  →  ${confidenceColor(data.after)(data.after)}  ${bold(signed(data.delta))}`);
  if (data.unmatched.length) {
    lines.push(yellow(`  ⚠ ${data.unmatched.length} named file(s) match no workflow file (no effect): ${data.unmatched.join(", ")}`));
  }
  if (data.workflows.length) {
    lines.push("");
    lines.push(bold("  Affected workflows"));
    for (const w of data.workflows) lines.push(`    ${w.id}  ${w.before ?? "—"} → ${w.after}  ${signed(w.delta ?? 0)}`);
  }
  return lines.join("\n");
}

export function renderDelta(data) {
  const lines = [`\n${bold("Score delta")} — since baseline`];
  lines.push(`  repo confidence ${confidenceColor(data.from)(data.from)}  →  ${confidenceColor(data.to)(data.to)}  ${bold(signed(data.delta))}`);
  if (data.signals.length) {
    lines.push("");
    lines.push(bold("  Attributed to signal contribution changes"));
    for (const s of data.signals) lines.push(`    ${signed(s.delta)} from ${cyan(s.signal)}  ${dim(`(${s.from.toFixed(3)} → ${s.to.toFixed(3)})`)}`);
  } else {
    lines.push(dim("  no signal-level change"));
  }
  if (data.workflowsAdded.length) lines.push(`  ${green("added:")} ${data.workflowsAdded.join(", ")}`);
  if (data.workflowsRemoved.length) lines.push(`  ${red("removed:")} ${data.workflowsRemoved.join(", ")}`);
  return lines.join("\n");
}
