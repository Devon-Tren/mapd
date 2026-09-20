/**
 * evidence.js — one deterministic evidence view per review-queue item
 * (`mapd evidence <id>`, chat /evidence, MCP get_finding_evidence).
 *
 * The master prompt requires that for every meaningful claim Map'd can show
 * the file paths, workflows, gate results, and config facts that support it.
 * Findings already CARRY that data scattered across reports, proposals, the
 * graph, and .mapdrc annotations — this module assembles it into a single
 * view. Everything here is read straight from those deterministic sources;
 * nothing is inferred, and anything unknown is reported as absent, not
 * guessed at.
 */

import fs from "node:fs";
import path from "node:path";
import { loadQueue, stateOf } from "./review.js";
import { checkReportFreshness } from "./staleness.js";
import { buildScoredGraph } from "./intelligence.js";
import { priorityOf, filesOf } from "./findingScoring.js";
import { loadConfig } from "../config/index.js";
import { applyAnnotations } from "./reachability.js";

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

/** How the graph classifies one file's reachability — verified data only. */
function classifyFile(graph, relFile) {
  const node = graph.files.find((f) => f.file === relFile) ?? null;
  const workflows = graph.workflows.filter((w) => w.files.includes(relFile)).map((w) => w.id);
  const generated = graph.generatedFiles?.find((g) => g.file === relFile) ?? null;
  const dynamic = graph.reachability?.dynamicallyLoaded?.find((d) => d.file === relFile) ?? null;
  const dormant = graph.reachability?.intentionalDormant?.find((d) => d.file === relFile) ?? null;
  const heuristic = graph.reachability?.heuristicUnverified?.find((h) => h.file === relFile) ?? null;
  const classification =
    generated ? "generated"
    : dormant ? "intentional-dormant"
    : dynamic ? "dynamically-loaded"
    : workflows.length ? "reachable"
    : heuristic ? "heuristic-unverified"
    : graph.orphans?.includes(relFile) ? "orphan"
    : "unclassified";
  return {
    file: relFile,
    inMap: !!node,
    parsed: node?.parsed ?? false,
    parserKind: node?.parserKind ?? (node ? "ast" : null),
    loc: node?.loc ?? null,
    exports: node?.exports ?? [],
    workflows,
    classification,
    classificationReason: generated?.reason ?? dormant?.evidence ?? dynamic?.evidence ?? heuristic?.reason ?? null,
  };
}

/** Gate summary for one saved fix proposal — real recorded results, no re-run. */
function summarizeProposal(prop) {
  if (!prop) return null;
  return {
    status: prop.status,
    stopReason: prop.stopReason ?? null,
    files: Object.keys(prop.filesPatch ?? {}),
    attempts: (prop.attempts ?? []).map((a) => ({
      attempt: a.attempt,
      passed: a.passed,
      failedGates: (a.gates ?? []).filter((g) => !g.passed).map((g) => g.gate),
    })),
    changeIds: prop.changeIds ?? [],
    postApplyVerification: prop.postApplyVerification
      ? { ok: prop.postApplyVerification.ok, issues: prop.postApplyVerification.issues }
      : null,
  };
}

/**
 * Assemble the full evidence view for one review-queue item. Returns null if
 * the ID isn't in the queue. `graph` may be passed in to reuse an
 * already-built scored graph (chat/MCP); otherwise one is built.
 */
export function buildFindingEvidence(rootDir, id, { graph } = {}) {
  const abs = path.resolve(rootDir);
  const item = loadQueue(abs).find((i) => i.id === id);
  if (!item) return null;

  const freshness = checkReportFreshness(abs);
  const report = readJson(item.file);
  const base = {
    id: item.id,
    source: item.source,
    kind: item.kind,
    severity: item.severity ?? null,
    status: item.status,
    state: stateOf(item, freshness.staleReports),
    detail: item.detail,
    report: {
      path: item.file,
      generatedAt: report?.generatedAt ?? null,
      stale: freshness.staleReports.includes(path.basename(item.file)),
    },
  };

  // fix proposal: the report file IS the proposal record with its gate history
  if (item.source === "fix") {
    return { ...base, evidenceType: "fix-proposal", proposal: summarizeProposal(report) };
  }

  // integration conflict: the report carries per-conflict AST evidence
  if (item.source.startsWith("integrate:")) {
    const conflict = report?.conflicts?.[item.index] ?? null;
    return {
      ...base,
      evidenceType: "integration-conflict",
      conflict: conflict && {
        file: conflict.file,
        classification: conflict.classification,
        evidence: conflict.evidence ?? null,
        proposalStatus: conflict.proposal?.status ?? null,
        resolutionScore: conflict.proposal?.resolutionScore?.score ?? null,
      },
    };
  }

  // check / modernize finding: raw evidence + graph-backed file context
  const finding = report?.findings?.[item.index] ?? null;
  if (!finding) return { ...base, evidenceType: "finding", finding: null, files: [] };

  const g = graph ?? buildScoredGraph(abs);
  const config = loadConfig(abs);
  const files = filesOf(finding).map((f) => classifyFile(g, f));
  const annotations = applyAnnotations(new Set(files.map((f) => f.file)), config.project?.annotations ?? {});
  const proposal = readJson(path.join(abs, ".mapd", "proposals", `${item.id}.json`));

  return {
    ...base,
    evidenceType: "finding",
    priority: Number(priorityOf(finding, item).toFixed(3)),
    finding: {
      detail: finding.detail,
      suggestion: finding.suggestion ?? null,
      rawEvidence: finding.evidence ?? null,
    },
    files,
    userAnnotations: annotations, // user assertions from .mapdrc, labeled as such
    proposal: summarizeProposal(proposal),
    repoConfidence: g.repoConfidence,
    callResolutionRate: g.stats.callResolutionRate,
  };
}

/** Renders buildFindingEvidence's data as terminal text — data first, no walls. */
export function renderFindingEvidence(data) {
  const lines = [];
  lines.push(`${data.id}  [${data.source}] ${data.kind}${data.severity ? ` (${data.severity})` : ""}  state: ${data.state}`);
  lines.push(`  ${data.detail}`);
  lines.push(`  report: ${data.report.path}${data.report.generatedAt ? `  generated ${data.report.generatedAt}` : ""}${data.report.stale ? "  ⚠ STALE — predates a newer source change; refresh before acting" : ""}`);

  if (data.evidenceType === "fix-proposal" && data.proposal) {
    lines.push(`  proposal: ${data.proposal.status}${data.proposal.stopReason ? ` (stopped: ${data.proposal.stopReason})` : ""}`);
    lines.push(`  files: ${data.proposal.files.join(", ") || "(none)"}`);
    for (const a of data.proposal.attempts) {
      lines.push(`    attempt ${a.attempt}: ${a.passed ? "PASSED all gates" : `failed (${a.failedGates.join(", ")})`}`);
    }
    if (data.proposal.postApplyVerification) {
      const v = data.proposal.postApplyVerification;
      lines.push(`  post-apply verification: ${v.ok ? "passed" : `FAILED — ${v.issues.join("; ")}`}`);
    }
    return lines.join("\n");
  }

  if (data.evidenceType === "integration-conflict") {
    if (data.conflict) {
      lines.push(`  conflict file: ${data.conflict.file}  classification: ${data.conflict.classification}`);
      if (data.conflict.evidence) lines.push(`  evidence: ${JSON.stringify(data.conflict.evidence)}`);
      if (data.conflict.proposalStatus) lines.push(`  proposal: ${data.conflict.proposalStatus}${data.conflict.resolutionScore != null ? ` (resolution score ${data.conflict.resolutionScore})` : ""}`);
    } else {
      lines.push("  conflict no longer present in the report.");
    }
    return lines.join("\n");
  }

  if (!data.finding) {
    lines.push("  finding no longer present in the report — re-run the source command to refresh.");
    return lines.join("\n");
  }

  if (data.priority != null) lines.push(`  priority: ${data.priority}  repo confidence: ${data.repoConfidence}  call resolution: ${(data.callResolutionRate * 100).toFixed(1)}%`);
  if (data.finding.suggestion) lines.push(`  suggestion: ${data.finding.suggestion}`);
  if (data.finding.rawEvidence) lines.push(`  raw evidence: ${JSON.stringify(data.finding.rawEvidence)}`);

  if (data.files.length) {
    lines.push("  files:");
    for (const f of data.files) {
      const wf = f.workflows.length ? `workflows: ${f.workflows.join(", ")}` : "no workflow membership";
      const reason = typeof f.classificationReason === "string" ? ` (${f.classificationReason})` : "";
      lines.push(`    - ${f.file}  [${f.classification}${reason}]  ${wf}${f.loc != null ? `  ${f.loc} loc` : f.inMap ? "" : "  (not in current map)"}`);
    }
  } else {
    lines.push("  files: none recorded on this finding.");
  }

  if (data.userAnnotations.length) {
    lines.push("  user annotations (asserted in .mapdrc, not auto-detected):");
    for (const a of data.userAnnotations) lines.push(`    - ${a.file} ← "${a.pattern}": "${a.classification}"`);
  }

  if (data.proposal) {
    lines.push(`  fix proposal: ${data.proposal.status}${data.proposal.stopReason ? ` (stopped: ${data.proposal.stopReason})` : ""} — ${data.proposal.attempts.length} attempt(s)`);
  } else {
    lines.push("  fix proposal: none yet — `mapd fix <id> --propose` to generate one.");
  }
  return lines.join("\n");
}
