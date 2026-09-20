/**
 * tools.js — MCP tool table. Every handler delegates to the exact same core
 * services cli.js and chat/commands.js use — MCP is a presentation layer,
 * never a parallel logic path.
 *
 * Read-only tools run directly. The one true real-tree mutation
 * (apply_approved_fix) requires an explicit `approve: true` argument from
 * the calling agent and still goes through the shared fix-apply safety layer,
 * so it can never bypass proposal gates, change recording, or rollback checks.
 */

import path from "node:path";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { buildScoredGraph, getRepoStatusSummary, getWorkflowSummaries, findFileNode, searchFunctions, buildTaskContext } from "../core/intelligence.js";
import { loadBaseline, diffGraphs } from "../core/regression.js";
import { renderDocs } from "../core/docs.js";
import { runModernizationScan, saveModernizationReport } from "../core/modernize.js";
import { loadPkg } from "../core/graph.js";
import { loadQueue, pending, loadQueueWithStates } from "../core/review.js";
import { runFixLifecycle } from "../core/fix.js";
import { chooseFixTarget, approveFixWithPostApplyVerification } from "../core/fixApply.js";
import { buildDiagnosis } from "../core/diagnose.js";
import { buildHandoff, renderHandoffPrompt } from "../core/handoff.js";
import { buildSolutions } from "../core/solutions.js";
import { buildFindingEvidence } from "../core/evidence.js";
import { loadChanges, rollbackChange } from "../core/changes.js";
import { loadConfig, listAnnotations } from "../config/index.js";
import { applyAnnotations } from "../core/reachability.js";
import { recordAudit } from "../core/audit.js";
import { sanitizeRelPath } from "../core/security.js";

function denied(reason, extra = {}) {
  return { ok: false, denied: true, reason, ...extra };
}

function resolveProjectRoot(dir) {
  // MCP clients may pass any string; always resolve within the filesystem
  // normally (path.resolve), then let downstream fs calls fail naturally if
  // the directory doesn't exist — no execution of untrusted paths as commands.
  return path.resolve(dir ?? ".");
}

export function createToolHandlers() {
  return {
    map_project: {
      description: "Build and return the current scored workflow map (read-only).",
      inputSchema: { type: "object", properties: { dir: { type: "string" } }, required: [] },
      mutation: false,
      async handler({ dir }) {
        const g = buildScoredGraph(resolveProjectRoot(dir));
        return { ok: true, stats: g.stats, repoConfidence: g.repoConfidence, workflows: getWorkflowSummaries(g), orphans: g.orphans };
      },
    },

    get_project_summary: {
      description: "Return a compact project summary (files, workflows, confidence, orphan count).",
      inputSchema: { type: "object", properties: { dir: { type: "string" } }, required: [] },
      mutation: false,
      async handler({ dir }) {
        const g = buildScoredGraph(resolveProjectRoot(dir));
        return { ok: true, summary: getRepoStatusSummary(g) };
      },
    },

    get_project_diagnosis: {
      description: "Return Map'd's deterministic diagnosis of understanding limits: confidence blockers, runtime blind spots, env contract, and next actions.",
      inputSchema: {
        type: "object",
        properties: {
          dir: { type: "string" },
          top: { type: "number" },
        },
        required: [],
      },
      mutation: false,
      async handler({ dir, top }) {
        return { ok: true, diagnosis: buildDiagnosis(resolveProjectRoot(dir), { top: top ?? 5 }) };
      },
    },

    profile_project: {
      description: "Profile map-building and optionally modernization scan timing (read-only).",
      inputSchema: {
        type: "object",
        properties: {
          dir: { type: "string" },
          modernizeMode: { type: "string", enum: ["light", "medium", "heavy"] },
          checkRegistry: { type: "boolean" },
          registryTimeoutMs: { type: "number" },
        },
        required: [],
      },
      mutation: false,
      async handler({ dir, modernizeMode, checkRegistry, registryTimeoutMs }) {
        const abs = resolveProjectRoot(dir);
        const startedAt = performance.now();
        const g = buildScoredGraph(abs);
        const mapDurationMs = Number((performance.now() - startedAt).toFixed(2));
        const result = {
          map: {
            durationMs: mapDurationMs,
            fileCount: g.stats.fileCount,
            workflowCount: g.workflows.length,
            repoConfidence: g.repoConfidence,
          },
        };
        if (modernizeMode) {
          const report = runModernizationScan(abs, g, loadPkg(abs), modernizeMode, {
            profile: true,
            checkRegistry: checkRegistry !== false,
            registryTimeoutMs: registryTimeoutMs ?? 2000,
          });
          result.modernize = { mode: modernizeMode, findingCount: report.findings.length, profile: report.profile };
        }
        return { ok: true, profile: result };
      },
    },

    get_workflow: {
      description: "Return one workflow's files, function count, and confidence signals by workflow ID.",
      inputSchema: { type: "object", properties: { dir: { type: "string" }, workflowId: { type: "string" } }, required: ["workflowId"] },
      mutation: false,
      async handler({ dir, workflowId }) {
        const g = buildScoredGraph(resolveProjectRoot(dir));
        const wf = g.workflows.find((w) => w.id === workflowId);
        if (!wf) return denied(`No workflow with id ${workflowId}`);
        return { ok: true, workflow: wf };
      },
    },

    search_project: {
      description: "Keyword search over functions and files (deterministic ranking, not a full-repo dump).",
      inputSchema: { type: "object", properties: { dir: { type: "string" }, query: { type: "string" } }, required: ["query"] },
      mutation: false,
      async handler({ dir, query }) {
        const g = buildScoredGraph(resolveProjectRoot(dir));
        return { ok: true, hits: searchFunctions(g, query).slice(0, 20) };
      },
    },

    get_task_context: {
      description: "Return a compact graph-backed context pack for a task/question: ranked symbols, relevant files, workflows, and caveats.",
      inputSchema: {
        type: "object",
        properties: {
          dir: { type: "string" },
          query: { type: "string" },
          maxHits: { type: "number" },
          maxFiles: { type: "number" },
        },
        required: ["query"],
      },
      mutation: false,
      async handler({ dir, query, maxHits, maxFiles }) {
        const g = buildScoredGraph(resolveProjectRoot(dir));
        return { ok: true, context: buildTaskContext(g, query, { maxHits: maxHits ?? 8, maxFiles: maxFiles ?? 8 }) };
      },
    },

    get_symbol: {
      description: "Return one file's parsed functions/imports/exports.",
      inputSchema: { type: "object", properties: { dir: { type: "string" }, file: { type: "string" } }, required: ["file"] },
      mutation: false,
      async handler({ dir, file }) {
        const abs = resolveProjectRoot(dir);
        try { sanitizeRelPath(abs, file); } catch (e) { return denied(e.message); }
        const g = buildScoredGraph(abs);
        const node = findFileNode(g, file);
        if (!node) return denied(`No such file in the map: ${file}`);
        return { ok: true, file: node };
      },
    },

    check_project: {
      description: "Diff the current map against the saved baseline and write findings (mirrors `mapd check`; writes only Map'd metadata, not source files).",
      inputSchema: { type: "object", properties: { dir: { type: "string" } }, required: [] },
      mutation: false,
      async handler({ dir }) {
        const abs = resolveProjectRoot(dir);
        const loaded = loadBaseline(abs);
        if (!loaded) return denied("No baseline found — run `mapd baseline` first.");
        if (loaded.schemaMismatch) return denied("Baseline schema mismatch — re-run `mapd baseline`.");
        const current = buildScoredGraph(abs);
        const findings = diffGraphs(loaded.graph, current);
        return { ok: true, findings, repoConfidence: current.repoConfidence };
      },
    },

    compare_baseline: {
      description: "Read-only diff against the baseline without saving findings.",
      inputSchema: { type: "object", properties: { dir: { type: "string" } }, required: [] },
      mutation: false,
      async handler({ dir }) {
        const abs = resolveProjectRoot(dir);
        const loaded = loadBaseline(abs);
        if (!loaded) return denied("No baseline found.");
        if (loaded.schemaMismatch) return denied("Baseline schema mismatch.");
        const current = buildScoredGraph(abs);
        return { ok: true, findings: diffGraphs(loaded.graph, current) };
      },
    },

    modernize_project: {
      description: "Run the rule-based modernization scan (mirrors `mapd modernize`).",
      inputSchema: {
        type: "object",
        properties: {
          dir: { type: "string" },
          mode: { type: "string", enum: ["light", "medium", "heavy"] },
          profile: { type: "boolean" },
          checkRegistry: { type: "boolean" },
          registryTimeoutMs: { type: "number" },
        },
        required: [],
      },
      mutation: false,
      async handler({ dir, mode, profile, checkRegistry, registryTimeoutMs }) {
        const abs = resolveProjectRoot(dir);
        const g = buildScoredGraph(abs);
        const report = runModernizationScan(abs, g, loadPkg(abs), mode ?? "medium", {
          profile: !!profile,
          checkRegistry: checkRegistry !== false,
          registryTimeoutMs: registryTimeoutMs ?? 2000,
        });
        const fresh = report.findings; // before the save merges in carried lifecycle entries
        const saved = saveModernizationReport(abs, report);
        return { ok: true, findings: fresh, resolvedNow: saved.resolvedNow, profile: report.profile };
      },
    },

    list_findings: {
      description: "List review-queue items with derived states (active, stale, approved, resolved, dismissed, historical). By default returns only items awaiting approval; pass state to filter, or all:true for everything.",
      inputSchema: {
        type: "object",
        properties: {
          dir: { type: "string" },
          state: { type: "string", enum: ["active", "stale", "approved", "resolved", "dismissed", "historical"] },
          all: { type: "boolean" },
        },
        required: [],
      },
      mutation: false,
      async handler({ dir, state, all }) {
        const { items, freshness } = loadQueueWithStates(resolveProjectRoot(dir));
        const filtered = state ? items.filter((i) => i.state === state) : all ? items : pending(items);
        return { ok: true, items: filtered, freshness };
      },
    },

    get_finding_evidence: {
      description: "Return the deterministic evidence behind one review-queue item: files with workflow membership and reachability class, user annotations, gate results, and report freshness.",
      inputSchema: { type: "object", properties: { dir: { type: "string" }, id: { type: "string" } }, required: ["id"] },
      mutation: false,
      async handler({ dir, id }) {
        const evidence = buildFindingEvidence(resolveProjectRoot(dir), id);
        if (!evidence) return denied(`No item with id ${id} — call list_findings for current IDs.`);
        return { ok: true, evidence };
      },
    },

    get_handoff: {
      description: "Package the highest-priority open findings into an external-agent task prompt (mirrors `mapd handoff`). Stale-report findings are excluded, with the exclusion disclosed.",
      inputSchema: { type: "object", properties: { dir: { type: "string" }, top: { type: "number" } }, required: [] },
      mutation: false,
      async handler({ dir, top }) {
        const data = buildHandoff(resolveProjectRoot(dir), { top: top ?? 5 });
        return { ok: true, handoff: data, prompt: renderHandoffPrompt(data) };
      },
    },

    get_solutions: {
      description: "Cluster related open findings into data-backed solutions ranked by workflow blast radius (mirrors `mapd solutions`, deterministic clustering only — no narration).",
      inputSchema: { type: "object", properties: { dir: { type: "string" }, top: { type: "number" } }, required: [] },
      mutation: false,
      async handler({ dir, top }) {
        return { ok: true, solutions: buildSolutions(resolveProjectRoot(dir), { top: top ?? 5 }) };
      },
    },

    list_changes: {
      description: "List every recorded real-tree change (fix/integrate/review/annotate writes) with backup metadata and rollback status.",
      inputSchema: { type: "object", properties: { dir: { type: "string" } }, required: [] },
      mutation: false,
      async handler({ dir }) {
        return { ok: true, changes: loadChanges(resolveProjectRoot(dir)) };
      },
    },

    rollback_change: {
      description: "Restore a file to its state before a recorded change. Requires approve:true from the calling agent — a real-tree mutation, same approval rule as apply_approved_fix.",
      inputSchema: { type: "object", properties: { dir: { type: "string" }, changeId: { type: "string" }, approve: { type: "boolean" } }, required: ["changeId"] },
      mutation: true,
      async handler({ dir, changeId, approve }) {
        const abs = resolveProjectRoot(dir);
        if (approve !== true) {
          return denied(
            `rollback_change requires an explicit approve:true argument — mutation was NOT applied.`,
            { requiresApproval: true, changeId },
          );
        }
        const r = rollbackChange(abs, changeId);
        recordAudit(abs, { command: "mcp:rollback_change", initiator: "mcp", approvalStatus: r.ok ? "approved" : "failed", finalStatus: r.ok ? "rolled-back" : "failed", changeIds: [changeId] });
        if (!r.ok) return denied(r.detail);
        return { ok: true, detail: r.detail };
      },
    },

    list_annotations: {
      description: "List user-asserted annotations (.mapdrc project.annotations) and which files in the current map each pattern matches. These are user assertions, never auto-detected facts.",
      inputSchema: { type: "object", properties: { dir: { type: "string" } }, required: [] },
      mutation: false,
      async handler({ dir }) {
        const abs = resolveProjectRoot(dir);
        const annotations = listAnnotations(abs);
        const g = buildScoredGraph(abs);
        const matches = applyAnnotations(new Set(g.files.map((f) => f.file)), annotations);
        return {
          ok: true,
          annotations: Object.entries(annotations).map(([pattern, classification]) => ({
            pattern, classification,
            matchedFiles: matches.filter((m) => m.pattern === pattern).map((m) => m.file),
          })),
        };
      },
    },

    get_finding: {
      description: "Get one review-queue item by ID.",
      inputSchema: { type: "object", properties: { dir: { type: "string" }, id: { type: "string" } }, required: ["id"] },
      mutation: false,
      async handler({ dir, id }) {
        const item = loadQueue(resolveProjectRoot(dir)).find((i) => i.id === id);
        if (!item) return denied(`No item with id ${id}`);
        return { ok: true, item };
      },
    },

    propose_fix: {
      description: "Generate and gate-verify a fix proposal for a finding (does not touch the real working tree; saves a proposal awaiting approval). If id is omitted, targets the strongest open finding.",
      inputSchema: { type: "object", properties: { dir: { type: "string" }, id: { type: "string" }, maxAttempts: { type: "number" } }, required: [] },
      mutation: false,
      async handler({ dir, id, maxAttempts }) {
        const abs = resolveProjectRoot(dir);
        const config = loadConfig(abs);
        const targetId = id ?? chooseFixTarget(pending(loadQueue(abs)))?.id;
        if (!targetId) return denied("No open check or modernize findings to target.");
        const r = await runFixLifecycle(abs, targetId, config, { maxAttempts });
        if (!r.ok) return denied(r.reason);
        return { ok: true, findingId: targetId, status: r.proposalRecord.status, attempts: r.attempts, stopReason: r.stopReason, proposalPath: r.proposalPath };
      },
    },

    verify_proposal: {
      description: "Return the last recorded gate-verification results for a saved fix proposal.",
      inputSchema: { type: "object", properties: { dir: { type: "string" }, id: { type: "string" } }, required: ["id"] },
      mutation: false,
      async handler({ dir, id }) {
        const abs = resolveProjectRoot(dir);
        const p = path.join(abs, ".mapd", "proposals", `${id}.json`);
        if (!fs.existsSync(p)) return denied(`No saved proposal for finding ${id} — run propose_fix first.`);
        const record = JSON.parse(fs.readFileSync(p, "utf8"));
        return { ok: true, status: record.status, attempts: record.attempts, stopReason: record.stopReason };
      },
    },

    apply_approved_fix: {
      description: "Apply a verified, awaiting-approval fix proposal to the real working tree. Requires approve:true from the calling agent — the one real mutation tool in this server.",
      inputSchema: { type: "object", properties: { dir: { type: "string" }, id: { type: "string" }, approve: { type: "boolean" } }, required: ["id"] },
      mutation: true,
      async handler({ dir, id, approve }) {
        const abs = resolveProjectRoot(dir);
        if (approve !== true) {
          return denied(
            `apply_approved_fix requires an explicit approve:true argument — mutation was NOT applied.`,
            { requiresApproval: true, findingId: id },
          );
        }
        const item = loadQueue(abs).find((i) => i.id === id && i.source === "fix");
        if (!item) return denied(`No fix proposal with id ${id} in the review queue.`);
        const config = loadConfig(abs);
        const r = approveFixWithPostApplyVerification(abs, item, config);
        recordAudit(abs, { command: "mcp:apply_approved_fix", initiator: "mcp", approvalStatus: r.ok ? "approved" : "failed", finalStatus: r.ok ? "applied" : "failed" });
        if (!r.ok) return denied(r.detail);
        return { ok: true, detail: r.detail, postApplyVerification: r.postApplyVerification };
      },
    },

    generate_docs: {
      description: "Render MAP.md from the current scored graph (mirrors `mapd docs`).",
      inputSchema: { type: "object", properties: { dir: { type: "string" } }, required: [] },
      mutation: false,
      async handler({ dir }) {
        const abs = resolveProjectRoot(dir);
        const g = buildScoredGraph(abs);
        const md = await renderDocs(g, { withNarration: false });
        const out = path.join(abs, "MAP.md");
        fs.writeFileSync(out, md);
        return { ok: true, path: out };
      },
    },

    get_mapd_status: {
      description: "Return repo confidence, baseline status, open-findings count, and how many open findings come from stale reports.",
      inputSchema: { type: "object", properties: { dir: { type: "string" } }, required: [] },
      mutation: false,
      async handler({ dir }) {
        const abs = resolveProjectRoot(dir);
        const g = buildScoredGraph(abs);
        const loaded = loadBaseline(abs);
        const { items } = loadQueueWithStates(abs);
        const open = items.filter((i) => i.state === "active" || i.state === "stale");
        return {
          ok: true,
          repoConfidence: g.repoConfidence,
          baseline: loaded ? (loaded.schemaMismatch ? "schema-mismatch" : "present") : "none",
          openFindings: open.length,
          staleFindings: open.filter((i) => i.state === "stale").length,
        };
      },
    },
  };
}
