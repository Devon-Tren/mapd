/**
 * fixApply.js — shared selection and post-apply safety for verified fix
 * proposals. `review.transition` still performs the actual approved write;
 * this layer adds the "prove the real tree stayed healthy, otherwise roll
 * back the recorded backup" behavior used by CLI/chat/MCP.
 */

import fs from "node:fs";
import path from "node:path";
import { buildScoredGraph } from "./intelligence.js";
import { loadPkg } from "./graph.js";
import { runProjectCorrectnessGate } from "./gates.js";
import { transition } from "./review.js";
import { rollbackChange } from "./changes.js";

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function isFixableFinding(item) {
  return item?.status === "awaiting-approval" &&
    (item.source === "check" || item.source?.startsWith("modernize-"));
}

function itemPriority(item) {
  const severity = SEVERITY_RANK[item.severity] ?? 0;
  const priority = Number(item.priority);
  return severity * 1000 + (Number.isFinite(priority) ? priority : 0);
}

/** Pick the strongest open finding when the user intentionally omits an ID. */
export function chooseFixTarget(items = []) {
  return items
    .filter(isFixableFinding)
    .slice()
    .sort((a, b) =>
      itemPriority(b) - itemPriority(a) ||
      (a.source ?? "").localeCompare(b.source ?? "") ||
      (a.id ?? "").localeCompare(b.id ?? ""),
    )[0] ?? null;
}

export function comparePostApplyHealth(preGraph, postGraph) {
  const preConfidence = Number(preGraph?.repoConfidence ?? 0);
  const postConfidence = Number(postGraph?.repoConfidence ?? 0);
  const preWorkflows = preGraph?.workflows ?? [];
  const postWorkflows = postGraph?.workflows ?? [];
  const postIds = new Set(postWorkflows.map((w) => w.id));
  const missingWorkflowIds = preWorkflows.map((w) => w.id).filter((id) => !postIds.has(id));
  const issues = [];

  if (postConfidence < preConfidence) {
    issues.push(`repo confidence dropped from ${preConfidence} to ${postConfidence}`);
  }
  if (postWorkflows.length < preWorkflows.length) {
    issues.push(`workflow count dropped from ${preWorkflows.length} to ${postWorkflows.length}`);
  }
  if (missingWorkflowIds.length) {
    issues.push(`workflow(s) disappeared after apply: ${missingWorkflowIds.join(", ")}`);
  }

  return {
    ok: issues.length === 0,
    issues,
    preConfidence,
    postConfidence,
    preWorkflowCount: preWorkflows.length,
    postWorkflowCount: postWorkflows.length,
    missingWorkflowIds,
  };
}

function firstUsefulLine(...texts) {
  for (const text of texts) {
    const line = String(text ?? "").split(/\r?\n/).find((l) => l.trim());
    if (line) return line.trim();
  }
  return "";
}

function correctnessIssues(gate) {
  if (gate.passed) return [];
  return (gate.checks ?? [])
    .filter((c) => !c.passed)
    .map((c) => {
      const detail = firstUsefulLine(c.stderr, c.stdout);
      return `${c.script} failed${c.exitCode != null ? ` (exit ${c.exitCode})` : ""}${detail ? `: ${detail}` : ""}`;
    });
}

export function runPostApplyVerification(rootDir, preGraph, config = {}) {
  const abs = path.resolve(rootDir);
  const postGraph = buildScoredGraph(abs);
  const health = comparePostApplyHealth(preGraph, postGraph);
  const correctness = runProjectCorrectnessGate({
    cwd: abs,
    pkg: loadPkg(abs),
    runTests: config.fix?.runTests,
    runLint: config.fix?.runLint,
    runTypecheck: config.fix?.runTypecheck,
  });
  const issues = [...health.issues, ...correctnessIssues(correctness)];
  return { ok: issues.length === 0, issues, health, correctness };
}

function recordProposalPostApply(item, status, postApplyVerification, rollbackResults = []) {
  if (!item?.file) return;
  const prop = readJson(item.file);
  if (!prop) return;
  if (status) prop.status = status;
  prop.postApplyVerification = {
    ok: postApplyVerification.ok,
    at: new Date().toISOString(),
    issues: postApplyVerification.issues,
    health: postApplyVerification.health,
    correctness: postApplyVerification.correctness,
    rollbackResults,
  };
  fs.writeFileSync(item.file, JSON.stringify(prop, null, 2));
}

/**
 * Approve a saved fix proposal, then verify the real tree. If tests/lint/
 * typecheck fail, repo confidence drops, or workflows disappear, immediately
 * roll back the recorded change IDs from changes.js.
 */
export function approveFixWithPostApplyVerification(rootDir, item, config = {}) {
  const abs = path.resolve(rootDir);
  if (item?.source !== "fix") {
    return { ok: false, action: "approve", detail: "post-apply verification only applies to fix proposals" };
  }

  const preGraph = buildScoredGraph(abs);
  let applied;
  try {
    applied = transition(abs, item, "approve");
  } catch (e) {
    return { ok: false, action: "approve", detail: e.message };
  }
  if (!applied.ok) return applied;

  const changeIds = applied.changeIds ?? [];
  const postApplyVerification = runPostApplyVerification(abs, preGraph, config);
  if (postApplyVerification.ok) {
    recordProposalPostApply(item, null, postApplyVerification);
    return { ...applied, changeIds, postApplyVerification };
  }

  const rollbackResults = [];
  for (const changeId of changeIds.slice().reverse()) {
    try {
      rollbackResults.push({ changeId, ...rollbackChange(abs, changeId) });
    } catch (e) {
      rollbackResults.push({ changeId, ok: false, detail: e.message });
    }
  }
  const rolledBack = rollbackResults.every((r) => r.ok);
  const status = rolledBack ? "rolled-back-after-apply" : "post-apply-failed-rollback-incomplete";
  recordProposalPostApply(item, status, postApplyVerification, rollbackResults);

  return {
    ok: false,
    action: "approve",
    detail: `post-apply verification failed; ${rolledBack ? "rolled back" : "rollback incomplete"} (${postApplyVerification.issues.join("; ")})`,
    originalDetail: applied.detail,
    changeIds,
    rollbackResults,
    postApplyVerification,
  };
}
