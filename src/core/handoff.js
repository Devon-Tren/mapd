/**
 * handoff.js — `mapd handoff`: package the highest-priority open findings
 * into a structured prompt for an external coding agent (Claude Code, Codex)
 * to execute. Mapd never edits code itself — chat is a project-understanding
 * and verification layer, not a general agent (see chat/repl.js) — so this
 * automates the manual step of turning findings into an agent-ready prompt,
 * instead of a human hand-writing one from the review queue each time.
 *
 * Every section is built ONLY from real, already-computed data (the review
 * queue, the workflow graph, the baseline diff) — never an invented file
 * grouping, task description, or priority beyond what the underlying
 * finding/scoring already produced.
 */

import path from "node:path";
import { buildScoredGraph, detectStack } from "./intelligence.js";
import { loadPkg } from "./graph.js";
import { loadBaseline, diffGraphs } from "./regression.js";
import { pending, loadQueue } from "./review.js";
import { loadFinding } from "./fix.js";
import { priorityOf, filesOf } from "./findingScoring.js";
import { checkReportFreshness } from "./staleness.js";

/**
 * Top-N open (check + modernize) findings, ranked by severity/priority across
 * both sources. Findings sourced from a STALE report (one that predates a
 * more recent source change — see staleness.js) are excluded from the ranked
 * list entirely, not just annotated: a banner next to a fully-formed action
 * plan is easy to skip past, and acting on a stale finding means fixing
 * something that may already be fixed. The exclusion itself is disclosed
 * (count + which reports), never silent. `staleReports` is
 * checkReportFreshness's `staleReports` (report basenames).
 */
export function collectTopFindings(rootDir, { top = 5, staleReports = [] } = {}) {
  const abs = path.resolve(rootDir);
  const staleSet = new Set(staleReports);
  const items = pending(loadQueue(abs)).filter((i) => i.source === "check" || i.source.startsWith("modernize-"));
  const fresh = items.filter((i) => !staleSet.has(path.basename(i.file)));
  const excludedStaleCount = items.length - fresh.length;
  const findings = fresh
    .map((item) => {
      const loaded = loadFinding(abs, item.id);
      if (!loaded) return null;
      return { item, finding: loaded.finding, priority: priorityOf(loaded.finding, item) };
    })
    .filter(Boolean)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, top);
  return { findings, excludedStaleCount };
}

/** Workflows newly added since the last baseline — files an external agent should treat as fragile. */
function newWorkflowsSinceBaseline(rootDir, graph) {
  const abs = path.resolve(rootDir);
  const loaded = loadBaseline(abs);
  if (!loaded || loaded.schemaMismatch) return [];
  const diff = diffGraphs(loaded.graph, graph);
  const ids = diff.filter((f) => f.kind === "workflow-added").map((f) => /^New workflow (\S+) detected/.exec(f.detail)?.[1]).filter(Boolean);
  return graph.workflows.filter((w) => ids.includes(w.id)).map((w) => ({ id: w.id, entry: w.entry.file, fileCount: w.files.length }));
}

/** Builds the structured handoff data — pure data, no formatting decisions. */
export function buildHandoff(rootDir, { top = 5 } = {}) {
  const abs = path.resolve(rootDir);
  const graph = buildScoredGraph(abs);
  const pkg = loadPkg(abs);
  const stack = detectStack(pkg, graph);
  const freshness = checkReportFreshness(abs);
  const { findings: topFindings, excludedStaleCount } = collectTopFindings(abs, { top, staleReports: freshness.staleReports });

  return {
    root: abs,
    project: pkg?.name ?? path.basename(abs),
    stack,
    fileCount: graph.stats.fileCount,
    workflowCount: graph.workflows.length,
    repoConfidence: graph.repoConfidence,
    callResolutionRate: graph.stats.callResolutionRate,
    freshness,
    excludedStaleCount,
    newWorkflows: newWorkflowsSinceBaseline(abs, graph),
    tasks: topFindings.map(({ item, finding, priority }, i) => ({
      order: i + 1,
      id: item.id,
      source: item.source,
      kind: finding.kind ?? finding.rule,
      severity: finding.severity ?? null,
      priority: Number(priority.toFixed(3)),
      detail: finding.detail,
      files: filesOf(finding),
      suggestion: finding.suggestion ?? null,
    })),
  };
}

/** Renders `buildHandoff`'s data as a plain-text prompt, ready to paste into an external agent. */
export function renderHandoffPrompt(data) {
  const lines = [];
  const stackLabel = [...data.stack.languages, ...data.stack.frameworks].join(" + ") || "JavaScript";

  if (data.freshness?.stale && data.excludedStaleCount > 0) {
    lines.push(`⚠ STALE REPORTS EXCLUDED: ${data.freshness.staleReports.join(", ")} predate a more recent source change. ` +
      `${data.excludedStaleCount} finding(s) sourced from them were EXCLUDED from the tasks below (not just flagged) — ` +
      "every task shown is backed by a report that is current with the working tree. " +
      "Re-run `mapd check`/`mapd modernize` to refresh the stale report(s) and include their findings.");
    lines.push("");
  } else if (data.freshness?.stale) {
    // stale report(s) exist but contributed no open findings — one quiet line,
    // not a warning banner about zero exclusions
    lines.push(`note: ${data.freshness.staleReports.join(", ")} predate a more recent source change but contributed no open findings; re-run \`mapd check\`/\`mapd modernize\` to refresh.`);
    lines.push("");
  }

  lines.push("CONTEXT");
  lines.push("=======");
  lines.push(`${data.fileCount}-file ${stackLabel} project (${data.project}).`);
  lines.push(`repo confidence: ${data.repoConfidence}  call resolution: ${(data.callResolutionRate * 100).toFixed(1)}%`);
  if (data.tasks.length) {
    lines.push(`Map'd identified ${data.tasks.length} priority finding(s) below, highest first. Work through them in order.`);
    lines.push("Do not refactor beyond the stated scope for each task.");
  }
  lines.push("");

  if (data.newWorkflows.length) {
    lines.push("REGRESSION GUARD");
    lines.push("================");
    lines.push("These workflows were newly detected since the last baseline — treat their files as fragile;");
    lines.push("preserve existing import/export surface unless a task below explicitly targets them.");
    for (const wf of data.newWorkflows) lines.push(`  - ${wf.id}  (entry: ${wf.entry}, ${wf.fileCount} files)`);
    lines.push("");
  }

  if (!data.tasks.length) {
    lines.push(data.excludedStaleCount > 0
      ? `All ${data.excludedStaleCount} open finding(s) come from stale report(s) — nothing current to hand off. Re-run \`mapd check\`/\`mapd modernize\` first.`
      : "No open findings — nothing to hand off. Run `mapd check` / `mapd modernize` first.");
    return lines.join("\n");
  }

  lines.push("━".repeat(70));
  for (const task of data.tasks) {
    const header = `TASK ${task.order} — ${String(task.kind).toUpperCase()}`;
    lines.push("");
    lines.push(header);
    lines.push("=".repeat(header.length));
    lines.push(`Finding ID: ${task.id}  |  source: ${task.source}  |  priority: ${task.priority}` +
      (task.severity ? `  |  severity: ${task.severity}` : ""));
    lines.push(`Problem: ${task.detail}`);
    if (task.files.length) lines.push(`Files: ${task.files.join(", ")}`);
    if (task.suggestion) lines.push(`Suggested direction: ${task.suggestion}`);
    lines.push("After this task: run `mapd check` and re-verify no new regressions before moving to the next task.");
  }
  lines.push("");
  lines.push("━".repeat(70));
  lines.push(`EXECUTION ORDER: Task 1 → Task ${data.tasks.length}, in order. One commit per task. Do not batch.`);
  return lines.join("\n");
}
