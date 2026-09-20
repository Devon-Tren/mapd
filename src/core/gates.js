/**
 * gates.js — the general-purpose deterministic verification gate runner.
 *
 * G1-G3 originally lived only inside integrate.js's merge-conflict pipeline.
 * This module is the single implementation; integrate.js now calls into it
 * so the merge-resolution and fix-engine pipelines can never drift apart.
 *
 * DESIGN RULE (unchanged from integrate.js): a gate failure never gets
 * silently dropped — every gate result is returned, and the caller decides
 * status ("rejected-by-gate" etc.) from the full list.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseJsFile } from "./parser.js";
import { sanitizeRelPath, isProtectedPath } from "./security.js";
import { diffWorkspace } from "./workspace.js";
import { buildScoredGraph } from "./intelligence.js";
import { diffGraphs } from "./regression.js";
import { detectPackageManager } from "./graph.js";

/** Parse source held in memory by round-tripping through a temp file. */
export function parseSource(source, label) {
  const tmp = path.join(os.tmpdir(), `mapd-src-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(tmp, source);
  try { return parseJsFile(tmp, label); }
  finally { fs.rmSync(tmp, { force: true }); }
}

/**
 * G1: the source parses cleanly (zero Babel recovery errors).
 * G2: exports are a superset of `requiredExports` (when supplied).
 * G3: top-level function names are a superset of `requiredFunctions` (when supplied),
 *     ignoring anonymous functions.
 * G4 (optional, best-effort): a resolvable test command passes in `cwd`. Skipped
 *     (never faked) when no test command can be resolved.
 *
 * Returns the same `[{gate, passed, missing?}]` shape integrate.js's
 * verifyProposal has always returned, so existing gate-name strings and
 * consumers (review queue, CLI output) are unaffected by this refactor.
 */
export function runStandardGates({ source, label, requiredExports, requiredFunctions, cwd, testCommand } = {}) {
  const gates = [];
  const p = parseSource(source, label);

  gates.push({ gate: "G1-parses-cleanly", passed: p.parsed && p.parseErrors === 0 });

  if (requiredExports) {
    const got = new Set(p.exports);
    const missing = requiredExports.filter((e) => !got.has(e));
    gates.push({ gate: "G2-export-union-preserved", passed: missing.length === 0, missing });
  }
  if (requiredFunctions) {
    const got = new Set(p.functions.map((f) => f.name));
    const missing = requiredFunctions.filter((f) => !got.has(f) && !f.startsWith("<anon"));
    gates.push({ gate: "G3-function-union-preserved", passed: missing.length === 0, missing });
  }
  if (testCommand && cwd) {
    gates.push(runTestGate(testCommand, cwd));
  }
  return gates;
}

/** G4: best-effort — run a resolvable test command in an isolated cwd. Never fabricates a result. */
function runTestGate(testCommand, cwd) {
  try {
    execFileSync(testCommand[0], testCommand.slice(1), {
      cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
    });
    return { gate: "G4-tests-pass", passed: true };
  } catch (e) {
    return {
      gate: "G4-tests-pass", passed: false,
      exitCode: e.status ?? null,
      stderr: (e.stderr ?? "").toString().slice(0, 4000),
      stdout: (e.stdout ?? "").toString().slice(0, 4000),
    };
  }
}

/**
 * Registry seam: additional gates (e.g. a project-specific policy gate) can be
 * added here without touching integrate.js or fix.js call sites.
 */
export const GATES = {
  G1: "G1-parses-cleanly",
  G2: "G2-export-union-preserved",
  G3: "G3-function-union-preserved",
  G4: "G4-tests-pass",
};

/* ------------------------------------------------------------------------ *
 * General verification pipeline gates (fix.js / mcp / chat).
 *
 * These are NAMED DIFFERENTLY from integrate.js's merge-specific G1/G2/G3
 * above (which stay untouched for backward compatibility with
 * tests/integrate.test.js). These three implement the spec's general
 * definitions:
 *   FIX-G1  patch & structural safety
 *   FIX-G2  project correctness (available project scripts: test/lint/typecheck)
 *   FIX-G3  Map'd regression verification (remap, compare confidence/orphans)
 * ------------------------------------------------------------------------ */

/** FIX-G1: every proposed file is safe to write, parses, and nothing unexpected changed. */
export function runPatchSafetyGate({ ws, patch, forbiddenPaths = [], maxFileSizeBytes = 1_000_000 }) {
  const issues = [];
  for (const [relFile, newSource] of Object.entries(patch)) {
    try {
      sanitizeRelPath(ws.dir, relFile);
    } catch (e) {
      issues.push(`${relFile}: ${e.message}`);
      continue;
    }
    if (isProtectedPath(relFile, forbiddenPaths)) {
      issues.push(`${relFile}: protected path, refusing to modify`);
      continue;
    }
    if (Buffer.byteLength(newSource, "utf8") > maxFileSizeBytes) {
      issues.push(`${relFile}: exceeds maxFileSizeBytes (${maxFileSizeBytes})`);
    }
    const parsed = parseSource(newSource, relFile);
    if (!parsed.parsed || parsed.parseErrors > 0) {
      issues.push(`${relFile}: does not parse cleanly`);
    }
  }
  const changed = diffWorkspace(ws);
  const allowed = new Set(Object.keys(patch));
  const unexpected = changed.filter((f) => !allowed.has(f));
  if (unexpected.length) issues.push(`unexpected files changed: ${unexpected.join(", ")}`);

  return { gate: "FIX-G1-patch-safety", passed: issues.length === 0, issues };
}

function runPackageManagerScript(cwd, manager, args, timeoutMs) {
  try {
    execFileSync(manager, args, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
    return { script: `${manager} ${args.join(" ")}`, passed: true };
  } catch (e) {
    return {
      script: `${manager} ${args.join(" ")}`, passed: false,
      exitCode: e.status ?? null,
      stderr: (e.stderr ?? "").toString().slice(0, 4000),
      stdout: (e.stdout ?? "").toString().slice(0, 4000),
    };
  }
}

/**
 * FIX-G2: run whichever of test/lint/typecheck scripts the project actually
 * defines in package.json. Never assumes a script exists — detects it. Also
 * never assumes npm: detects the actual package manager from the project's
 * lockfile (pnpm-lock.yaml / yarn.lock / package-lock.json / bun.lockb),
 * falling back to npm only when no lockfile is present at all.
 */
export function runProjectCorrectnessGate({ cwd, pkg, runTests = true, runLint = true, runTypecheck = true, timeoutMs = 120_000 }) {
  const scripts = pkg?.scripts ?? {};
  const { manager } = detectPackageManager(cwd);
  const checks = [];
  if (runTests && scripts.test) checks.push(runPackageManagerScript(cwd, manager, ["test"], timeoutMs));
  if (runLint && scripts.lint) checks.push(runPackageManagerScript(cwd, manager, ["run", "lint"], timeoutMs));
  const typecheckScript = scripts.typecheck ? "typecheck" : scripts["type-check"] ? "type-check" : null;
  if (runTypecheck && typecheckScript) checks.push(runPackageManagerScript(cwd, manager, ["run", typecheckScript], timeoutMs));

  if (!checks.length) return { gate: "FIX-G2-project-correctness", passed: true, skipped: true, checks: [] };
  return { gate: "FIX-G2-project-correctness", passed: checks.every((c) => c.passed), checks };
}

/**
 * FIX-G3: remap the isolated workspace and compare against the pre-fix graph
 * (and baseline, when available) — confidence must not newly regress, no new
 * high-severity findings, AND — when a target finding and a usable baseline
 * are both available — the finding's exact condition (same kind + detail)
 * must no longer reproduce when diffed against the baseline. A patch that
 * leaves the original problem in place fails this gate; the model's own
 * claim of success is never taken as evidence.
 */
export function runRegressionGate({ ws, preFixGraph, baseline, targetFinding, confidenceTolerance = 0.02 }) {
  const postGraph = buildScoredGraph(ws.dir);
  const deltaConfidence = Number((postGraph.repoConfidence - preFixGraph.repoConfidence).toFixed(3));
  const newOrphans = postGraph.orphans.filter((o) => !preFixGraph.orphans.includes(o));
  const introduced = diffGraphs(preFixGraph, postGraph).filter((f) => f.kind !== "workflow-added");
  const newHighSeverity = introduced.filter((f) => f.severity === "high");

  let targetResolved = null;
  let targetStillFailing = false;
  if (baseline && targetFinding?.kind && targetFinding?.detail) {
    const vsBaseline = diffGraphs(baseline, postGraph);
    targetStillFailing = vsBaseline.some((f) => f.kind === targetFinding.kind && f.detail === targetFinding.detail);
    targetResolved = { resolved: !targetStillFailing, remainingFindings: vsBaseline.length };
  }

  const passed = deltaConfidence >= -confidenceTolerance && newHighSeverity.length === 0 && !targetStillFailing;
  return {
    gate: "FIX-G3-mapd-regression", passed,
    deltaConfidence, newOrphans, newHighSeverity, targetResolved,
  };
}

/** Convenience: run all three general-pipeline gates for one fix attempt. */
export function runFixGates({ ws, patch, forbiddenPaths, maxFileSizeBytes, pkg, cwd, runTests, runLint, runTypecheck, preFixGraph, baseline, targetFinding }) {
  const g1 = runPatchSafetyGate({ ws, patch, forbiddenPaths, maxFileSizeBytes });
  if (!g1.passed) return [g1]; // no point running tests/regression on an unsafe patch
  const g2 = runProjectCorrectnessGate({ cwd: cwd ?? ws.dir, pkg, runTests, runLint, runTypecheck });
  const g3 = runRegressionGate({ ws, preFixGraph, baseline, targetFinding });
  return [g1, g2, g3];
}
