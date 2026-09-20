/**
 * regression.js — Baseline diffing.
 *
 * `mapd baseline` snapshots the scored graph into .mapd/baseline.json.
 * `mapd check` re-maps and diffs. Findings are deterministic facts about the
 * graph delta; severity is rule-derived. The optional LLM layer may *explain*
 * a finding or *propose* a fix, but it may not create, suppress, or rescore one.
 *
 * Approval flow: findings are written to .mapd/findings.json with
 * status "awaiting-approval". Nothing is ever auto-fixed.
 */

import fs from "node:fs";
import path from "node:path";

const MAPD_DIR = ".mapd";

/** Bump when the graph shape changes in a way that invalidates old baselines. */
export const BASELINE_SCHEMA = 3; // 3 = honest testPresence (real/shallow test credit, not basename match) — scores shift, old baselines aren't comparable

export function baselinePath(rootDir) {
  return path.join(rootDir, MAPD_DIR, "baseline.json");
}

export function saveBaseline(rootDir, graph) {
  const dir = path.join(rootDir, MAPD_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(baselinePath(rootDir), JSON.stringify({ ...graph, mapdSchema: BASELINE_SCHEMA }, null, 2));
  return baselinePath(rootDir);
}

/** Returns { graph, schemaMismatch } — a mismatch means re-baseline, not silent diffing. */
export function loadBaseline(rootDir) {
  try {
    const graph = JSON.parse(fs.readFileSync(baselinePath(rootDir), "utf8"));
    return { graph, schemaMismatch: graph.mapdSchema !== BASELINE_SCHEMA ? { found: graph.mapdSchema ?? 1, expected: BASELINE_SCHEMA } : null };
  } catch {
    return null;
  }
}

const fnKey = (f) => f; // "file#name" ids already unique

export function diffGraphs(baseline, current) {
  const findings = [];
  const add = (severity, kind, detail, evidence) =>
    findings.push({ severity, kind, detail, evidence, status: "awaiting-approval" });

  const baseWf = new Map(baseline.workflows.map((w) => [w.id, w]));
  const curWf = new Map(current.workflows.map((w) => [w.id, w]));

  // 1. Removed / added workflows
  for (const [id, w] of baseWf) {
    if (!curWf.has(id)) add("high", "workflow-removed",
      `Workflow ${id} (entry: ${w.entry.file}) no longer exists.`,
      { baselineFiles: w.files.length });
  }
  for (const [id, w] of curWf) {
    if (!baseWf.has(id)) add("info", "workflow-added",
      `New workflow ${id} detected (entry: ${w.entry.file}).`,
      { files: w.files.length });
  }

  // 2. Confidence regressions (derived score dropped materially)
  for (const [id, cw] of curWf) {
    const bw = baseWf.get(id);
    if (!bw?.confidence || !cw.confidence) continue;
    const drop = bw.confidence.score - cw.confidence.score;
    if (drop >= 0.1) {
      // find which signals degraded — evidence, not narrative
      const degraded = Object.entries(cw.confidence.signals)
        .filter(([k, s]) => {
          const b = bw.confidence.signals[k];
          return b && s.value !== null && b.value !== null && b.value - s.value >= 0.05;
        })
        .map(([k, s]) => ({ signal: k, from: bw.confidence.signals[k].value, to: s.value }));
      add(drop >= 0.25 ? "high" : "medium", "confidence-regression",
        `Workflow ${id} confidence dropped ${bw.confidence.score} → ${cw.confidence.score}.`,
        { degradedSignals: degraded });
    }
  }

  // 3. Exported-surface breaks (removed exports = potential breaking change)
  for (const [id, cw] of curWf) {
    const bw = baseWf.get(id);
    if (!bw) continue;
    const removed = bw.exportedSurface.filter((e) => !cw.exportedSurface.includes(e));
    if (removed.length) add("high", "export-removed",
      `Workflow ${id} removed exported symbols: ${removed.join(", ")}.`,
      { removed });
  }

  // 4. Call-resolution degradation (new dangling call edges)
  const baseUnresolved = baseline.stats.totalCalls - baseline.stats.resolvedCalls;
  const curUnresolved = current.stats.totalCalls - current.stats.resolvedCalls;
  if (curUnresolved > baseUnresolved + 5 &&
      current.stats.callResolutionRate < baseline.stats.callResolutionRate - 0.03) {
    add("medium", "resolution-degradation",
      `Unresolved call edges grew ${baseUnresolved} → ${curUnresolved}; resolution rate ` +
      `${baseline.stats.callResolutionRate.toFixed(3)} → ${current.stats.callResolutionRate.toFixed(3)}.`,
      { baseUnresolved, curUnresolved });
  }

  // 5. New orphans (files that fell out of every workflow)
  const newOrphans = current.orphans.filter((f) => !baseline.orphans.includes(f));
  if (newOrphans.length) add("low", "new-orphans",
    `${newOrphans.length} file(s) are no longer reachable from any entry point.`,
    { files: newOrphans });

  // 6. New parse failures
  const baseUnparsed = new Set(baseline.files.filter((f) => !f.parsed).map((f) => f.file));
  const newUnparsed = current.files.filter((f) => !f.parsed && !baseUnparsed.has(f.file)).map((f) => f.file);
  if (newUnparsed.length) add("high", "parse-failure",
    `File(s) newly failing to parse: ${newUnparsed.join(", ")}.`, { files: newUnparsed });

  return findings;
}

/**
 * Merge a fresh scan's findings against a previous report's so the finding
 * lifecycle closes itself instead of silently forgetting. Shared by `mapd
 * check` (findings.json, kind+detail identity) and `mapd modernize`
 * (modernize-<mode>.json, rule+detail identity):
 *
 * - a previously open (awaiting-approval/approved) finding that no longer
 *   reproduces is carried forward as status "resolved" with the re-scan as
 *   evidence — never just dropped;
 * - a finding that still reproduces and was already dismissed KEEPS its
 *   dismissal (Map'd does not re-nag a human decision) — same for an existing
 *   resolved/applied record;
 * - already-terminal entries (resolved/dismissed) are carried as audit trail.
 *
 * `key` is the content-identity function (must match what review.js hashes
 * into queue IDs for that report type). Returns { findings, resolvedNow }.
 */
export function mergeFindingLifecycle(newFindings, prevFindings, key, resolvedBy) {
  const prevByKey = new Map((prevFindings ?? []).map((f) => [key(f), f]));
  const newKeys = new Set(newFindings.map(key));

  const merged = newFindings.map((f) => {
    const old = prevByKey.get(key(f));
    if (old && old.status && old.status !== "awaiting-approval") {
      // still reproduces, but a human (or an applied fix) already decided —
      // preserve that decision and its stamp instead of resurrecting the item
      const carried = { ...f, status: old.status };
      for (const k of ["dismissed", "approved", "resolved", "applied"]) if (old[k]) carried[k] = old[k];
      return carried;
    }
    return f;
  });

  let resolvedNow = 0;
  for (const old of prevFindings ?? []) {
    if (key(old) && newKeys.has(key(old))) continue;
    if (old.status === "awaiting-approval" || old.status === "approved") {
      merged.push({
        ...old,
        status: "resolved",
        resolved: { at: new Date().toISOString(), by: resolvedBy, reason: "not reproduced by re-scan against the current tree" },
      });
      resolvedNow++;
    } else if (old.status === "resolved" || old.status === "dismissed") {
      merged.push(old); // terminal states stay visible as audit trail
    }
  }
  return { findings: merged, resolvedNow };
}

/** Content identity for a check finding — the same kind+detail key review.js hashes into queue IDs. */
const findingKey = (f) => `${f.kind}:${f.detail}`;

/**
 * Persist a check run's findings through mergeFindingLifecycle (see above).
 * Returns { path, resolvedNow } — resolvedNow is how many open findings this
 * run auto-resolved, for callers to disclose.
 */
export function saveFindings(rootDir, findings) {
  const p = path.join(rootDir, MAPD_DIR, "findings.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });

  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(p, "utf8")); } catch { /* first run */ }

  const { findings: merged, resolvedNow } = mergeFindingLifecycle(findings, prev?.findings, findingKey, "mapd check");
  fs.writeFileSync(p, JSON.stringify({ generatedAt: new Date().toISOString(), findings: merged }, null, 2));
  return { path: p, resolvedNow };
}
