/**
 * fix.js — the full mapd fix lifecycle: load finding -> validate relevance ->
 * gather context -> propose -> verify (isolated workspace + gates) -> retry
 * with structured feedback -> save a verified proposal awaiting approval.
 *
 * Approval and real-tree application happen in review.js/changes.js — this
 * module never writes to the real working tree.
 */

import fs from "node:fs";
import path from "node:path";
import { loadQueue } from "./review.js";
import { buildScoredGraph } from "./intelligence.js";
import { loadBaseline, diffGraphs } from "./regression.js";
import { loadPkg } from "./graph.js";
import { runFixGates } from "./gates.js";
import { runWithRetry } from "./retry.js";
import { createIsolatedWorkspace, applyPatchInWorkspace } from "./workspace.js";
import { proposeFix } from "../agents/llm.js";
import { getProvider } from "../agents/provider.js";

const MAPD = ".mapd";

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function extractWorkflowIdFromDetail(detail) {
  const m = /Workflow (\S+)/.exec(detail ?? "");
  return m ? m[1] : null;
}

/** Locate a finding (check or modernize sourced) by its review-queue ID. */
export function loadFinding(rootDir, id) {
  const abs = path.resolve(rootDir);
  const item = loadQueue(abs).find((i) => i.id === id);
  if (!item) return null;
  if (item.source === "fix" || item.source.startsWith("integrate:")) return null; // fix targets findings, not existing proposals
  const rep = readJson(item.file);
  const finding = rep?.findings?.[item.index];
  if (!finding) return null;
  return { item, finding, reportPath: item.file };
}

/** Deterministic file candidates for a finding: direct evidence, then workflow lookup. */
export function candidateFilesForFinding(finding, graph) {
  if (Array.isArray(finding.files) && finding.files.length) return finding.files;
  if (Array.isArray(finding.evidence?.files) && finding.evidence.files.length) return finding.evidence.files;
  const wfId = extractWorkflowIdFromDetail(finding.detail);
  if (wfId) {
    const wf = graph.workflows.find((w) => w.id === wfId);
    if (wf) return wf.files.slice(0, 5);
  }
  return [];
}

export function gatherRelevantSources(rootDir, finding, graph, { maxFiles = 3, maxCharsPerFile = 8000 } = {}) {
  const abs = path.resolve(rootDir);
  const files = candidateFilesForFinding(finding, graph).slice(0, maxFiles);
  return files.map((file) => {
    try { return { file, source: fs.readFileSync(path.join(abs, file), "utf8").slice(0, maxCharsPerFile) }; }
    catch { return { file, source: null }; }
  });
}

/**
 * Best-effort relevance check: for check-sourced (regression) findings, does
 * the same kind+detail still appear when diffing the current baseline against
 * a fresh map? Modernize findings are not re-scanned here (would require a
 * full re-run of the scan tier) — assumed still relevant, documented as such.
 */
export function isFindingStillRelevant(rootDir, item, finding, currentGraph) {
  if (item.source === "check") {
    const loaded = loadBaseline(rootDir);
    if (!loaded || loaded.schemaMismatch) {
      return { relevant: true, reason: "no usable baseline to re-verify against — proceeding" };
    }
    const stillThere = diffGraphs(loaded.graph, currentGraph)
      .some((f) => f.kind === finding.kind && f.detail === finding.detail);
    return {
      relevant: stillThere,
      reason: stillThere ? "finding reproduces against the current baseline diff" : "finding no longer reproduces",
    };
  }
  return { relevant: true, reason: "modernize findings are not re-scanned for relevance (best-effort)" };
}

function proposalsDir(rootDir) { return path.join(path.resolve(rootDir), MAPD, "proposals"); }

export function saveProposal(rootDir, proposalRecord) {
  const dir = proposalsDir(rootDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${proposalRecord.findingId}.json`);
  fs.writeFileSync(file, JSON.stringify(proposalRecord, null, 2));
  return file;
}

/**
 * Full lifecycle. Returns `{ ok, reason }` on early stop, or
 * `{ ok: true, proposalRecord, proposalPath, attempts, stopReason }` once a
 * proposal (verified or gate-exhausted) has been saved.
 *
 * Never fabricates a proposal without a configured provider — mirrors the
 * existing `--propose requires ANTHROPIC_API_KEY` behavior used everywhere
 * else in this codebase.
 */
export async function runFixLifecycle(rootDir, id, config = {}, opts = {}) {
  const abs = path.resolve(rootDir);
  const loaded = loadFinding(abs, id);
  if (!loaded) return { ok: false, reason: `no fixable finding with id ${id}` };
  const { item, finding } = loaded;

  const preFixGraph = buildScoredGraph(abs);
  const relevance = isFindingStillRelevant(abs, item, finding, preFixGraph);
  if (!relevance.relevant) {
    return { ok: false, reason: `finding no longer reproducible: ${relevance.reason}` };
  }

  const provider = getProvider(config);
  if (!provider.available()) {
    return {
      ok: false,
      reason: "mapd fix --propose requires a configured LLM provider (ANTHROPIC_API_KEY, OPENAI_API_KEY, or KIMI_API_KEY — in .env or ~/.env); no fix was fabricated.",
    };
  }

  const sources = gatherRelevantSources(abs, finding, preFixGraph);
  const baselineLoaded = loadBaseline(abs);
  const baseline = baselineLoaded && !baselineLoaded.schemaMismatch ? baselineLoaded.graph : null;
  const pkg = loadPkg(abs);
  const maxAttempts = opts.maxAttempts ?? config.fix?.maxAttempts ?? 2;
  const forbiddenPaths = config.fix?.forbiddenPaths ?? [];

  const workspaces = [];
  const retryResult = await runWithRetry({
    maxAttempts,
    attemptFn: async ({ feedback }) => {
      const proposal = await proposeFix(finding, sources, feedback, { provider });
      const ws = createIsolatedWorkspace(abs);
      workspaces.push(ws);

      if (!proposal || !proposal.patch || Object.keys(proposal.patch).length === 0) {
        return {
          gates: [{ gate: "FIX-G1-patch-safety", passed: false, issues: [proposal?.reasoning_summary || "no patch produced"] }],
          proposal, ws,
        };
      }
      for (const [relFile, newSource] of Object.entries(proposal.patch)) {
        applyPatchInWorkspace(ws, relFile, newSource);
      }
      const gates = runFixGates({
        ws, patch: proposal.patch, forbiddenPaths,
        maxFileSizeBytes: config.mapping?.maxFileSizeBytes,
        pkg, cwd: ws.dir,
        runTests: config.fix?.runTests, runLint: config.fix?.runLint, runTypecheck: config.fix?.runTypecheck,
        preFixGraph, baseline, targetFinding: finding,
      });
      return { gates, proposal, ws };
    },
  });

  const winningWs = retryResult.finalAttempt.result.ws;
  const winningProposal = retryResult.finalAttempt.result.proposal;
  for (const ws of workspaces) if (ws !== winningWs) ws.cleanup();

  const proposalRecord = {
    mapdSchema: 1,
    findingId: id,
    findingKind: finding.kind ?? finding.rule,
    findingDetail: finding.detail,
    filesPatch: winningProposal?.patch ?? {},
    summary: winningProposal?.summary ?? "",
    reasoning_summary: winningProposal?.reasoning_summary ?? "",
    expected_effect: winningProposal?.expected_effect ?? "",
    risks: winningProposal?.risks ?? [],
    verification_plan: winningProposal?.verification_plan ?? [],
    attempts: retryResult.attempts.map((a) => ({ attempt: a.attempt, passed: a.passed, gates: a.gates })),
    stopReason: retryResult.stopReason,
    status: retryResult.success ? "awaiting-approval" : "rejected-by-gate",
    generatedBy: winningProposal?.generatedBy ?? null,
    createdAt: new Date().toISOString(),
  };

  winningWs.cleanup();

  if (opts.dryRun) {
    return { ok: true, dryRun: true, proposalRecord, attempts: retryResult.attempts, stopReason: retryResult.stopReason };
  }

  const proposalPath = saveProposal(abs, proposalRecord);
  return { ok: true, proposalRecord, proposalPath, attempts: retryResult.attempts, stopReason: retryResult.stopReason };
}
