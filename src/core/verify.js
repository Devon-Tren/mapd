/**
 * verify.js — one command to prove the project is in a known-good state.
 *
 * `mapd verify` runs the gates a human or CI would otherwise run by hand —
 * config validate, build the scored map, doctor, baseline regression compare,
 * score delta, report freshness — and collapses them into a single verdict with
 * a CI-friendly exit code and a PR-ready one-liner.
 *
 * It is pure orchestration: every gate calls the existing engine, so verify can
 * never disagree with the individual commands. The CI contract is the wishlist's
 * rule — FAIL on MEANINGFUL regressions (invalid config, new parse failures,
 * high-severity workflow regressions), not on low-value modernization noise or a
 * schema bump.
 */

import { buildScoredGraph } from "./intelligence.js";
import { loadConfig, validateConfig } from "../config/index.js";
import { runDoctor } from "./doctor.js";
import { loadBaseline, diffGraphs } from "./regression.js";
import { checkReportFreshness } from "./staleness.js";
import { deltaScore, ceilingScore } from "./score.js";
import { bold, dim, red, green, yellow, cyan, confidenceColor } from "./theme.js";

const HIGH_MEANING = new Set(["workflow-removed", "export-removed", "parse-failure"]);

export function runVerify(rootDir, { strict = false } = {}) {
  const abs = rootDir;
  const gates = [];
  const gate = (name, status, detail) => gates.push({ name, status, detail });

  // 1. config
  const cfg = validateConfig(loadConfig(abs));
  gate("config", cfg.ok ? "pass" : "fail", cfg.ok ? "resolved configuration is valid" : cfg.errors.join("; "));

  // 2. map (building the scored graph is itself the check that the tree parses into a model)
  const current = buildScoredGraph(abs);
  gate("map", "pass", `${current.stats.fileCount} files, ${current.workflows.length} workflow(s), repo confidence ${current.repoConfidence}`);

  // 3. doctor — environment/readiness. Its failures are informational (stale reports,
  //    node version), not code regressions, so a failure is a WARN here.
  const doc = runDoctor(abs);
  const failedChecks = doc.checks.filter((c) => !c.ok).map((c) => c.name);
  gate("doctor", doc.ok ? "pass" : "warn", doc.ok ? "all readiness checks passed" : `failing: ${failedChecks.join(", ")}`);

  // 4. baseline regression compare + score delta
  let findings = null, delta = null, baselineState;
  const loaded = loadBaseline(abs);
  if (!loaded) {
    baselineState = "none";
    gate("baseline", "warn", "no baseline — run `mapd baseline` to enable regression checks");
  } else if (loaded.schemaMismatch) {
    baselineState = "schema-mismatch";
    gate("baseline", "warn", `baseline schema v${loaded.schemaMismatch.found} != v${loaded.schemaMismatch.expected}; re-baseline to compare (not a regression)`);
  } else {
    baselineState = "present";
    findings = diffGraphs(loaded.graph, current);
    delta = deltaScore(loaded.graph, current);
    const high = findings.filter((f) => f.severity === "high");
    const meaningful = high.filter((f) => HIGH_MEANING.has(f.kind) || f.kind === "confidence-regression");
    if (meaningful.length) {
      gate("regression", "fail", `${meaningful.length} high-severity regression(s): ${meaningful.map((f) => f.kind).join(", ")}`);
    } else if (findings.length) {
      gate("regression", "warn", `${findings.length} non-blocking finding(s) (${findings.map((f) => f.severity).join(", ")})`);
    } else {
      gate("regression", "pass", `no regressions; confidence ${delta.from} → ${delta.to} (${delta.delta >= 0 ? "+" : ""}${delta.delta})`);
    }
  }

  // 5. report freshness
  const fresh = checkReportFreshness(abs);
  gate("freshness", fresh.stale ? "warn" : "pass",
    fresh.stale ? `stale report(s): ${fresh.staleReports.join(", ")} — re-run mapd check/modernize` : "reports current");

  const ceiling = ceilingScore(abs, current);

  const hasFail = gates.some((g) => g.status === "fail");
  const hasWarn = gates.some((g) => g.status === "warn");
  const verdict = hasFail ? "fail" : hasWarn ? "warn" : "pass";
  const exitCode = hasFail ? 2 : (strict && hasWarn) ? 1 : 0;

  const prSummary = delta
    ? `Map'd: confidence ${delta.from} → ${delta.to} (${delta.delta >= 0 ? "+" : ""}${delta.delta})` +
      (delta.signals.length ? `, mainly ${delta.signals.slice(0, 2).map((s) => `${s.delta >= 0 ? "+" : ""}${s.delta} ${s.signal}`).join(", ")}` : "") +
      `. Verdict: ${verdict.toUpperCase()}.`
    : `Map'd: repo confidence ${current.repoConfidence} (no comparable baseline). Verdict: ${verdict.toUpperCase()}.`;

  return {
    verdict, ok: !hasFail, exitCode, strict,
    gates,
    summary: {
      repoConfidence: current.repoConfidence,
      baseline: baselineState,
      delta,
      findings: findings ? {
        total: findings.length,
        high: findings.filter((f) => f.severity === "high").length,
        medium: findings.filter((f) => f.severity === "medium").length,
        low: findings.filter((f) => f.severity === "low").length,
      } : null,
      ceiling: { value: ceiling.ceiling, signalCoverage: ceiling.ceilingSignalCoverage },
      stale: { stale: fresh.stale, reports: fresh.staleReports ?? [] },
      heuristicFiles: current.stats.heuristicFileCount ?? 0,
    },
    prSummary,
  };
}

export function renderVerify(v) {
  const glyph = { pass: green("✓"), warn: yellow("⚠"), fail: red("✗") };
  const lines = [`\n${bold("Map'd verify")}`];
  for (const g of v.gates) lines.push(`  ${glyph[g.status]} ${bold(g.name.padEnd(11))} ${dim(g.detail)}`);

  const s = v.summary;
  lines.push("");
  lines.push(`  repo confidence: ${confidenceColor(s.repoConfidence)(s.repoConfidence)}  ${dim(`ceiling ${s.ceiling.value} (signalCoverage ${s.ceiling.signalCoverage})`)}`);
  if (s.delta) lines.push(`  since baseline:  ${s.delta.from} → ${s.delta.to}  ${s.delta.delta >= 0 ? green(`+${s.delta.delta}`) : red(String(s.delta.delta))}`);

  const vColor = v.verdict === "pass" ? green : v.verdict === "warn" ? yellow : red;
  lines.push("");
  lines.push(`  ${bold("verdict:")} ${vColor(v.verdict.toUpperCase())}  ${dim(`(exit ${v.exitCode}${v.strict ? ", strict" : ""})`)}`);
  lines.push(dim(`  PR: ${v.prSummary}`));
  return lines.join("\n");
}
