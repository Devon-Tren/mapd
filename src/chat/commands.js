/**
 * commands.js — the slash-command table. Every handler calls the exact same
 * core services cli.js uses — no duplicated business logic. Dependency
 * injection (`deps`) keeps this testable without spawning a real CLI process.
 */

import fs from "node:fs";
import path from "node:path";
import { buildScoredGraph, getWorkflowSummaries, getRepoStatusSummary, buildTaskContext } from "../core/intelligence.js";
import { resolveFile, traceFile, tracePath, renderTraceFile, renderTracePath } from "../core/trace.js";
import { analyzeResolution, renderResolution } from "../core/resolution.js";
import { saveBaseline, loadBaseline, diffGraphs, saveFindings } from "../core/regression.js";
import { renderDocs } from "../core/docs.js";
import { runModernizationScan, saveModernizationReport } from "../core/modernize.js";
import { loadPkg } from "../core/graph.js";
import { pending, loadQueueWithStates } from "../core/review.js";
import { buildFindingEvidence, renderFindingEvidence } from "../core/evidence.js";
import { buildHandoff, renderHandoffPrompt } from "../core/handoff.js";
import { buildSolutions, narrateSolutions, renderSolutions } from "../core/solutions.js";
import { buildDiagnosis, renderDiagnosis } from "../core/diagnose.js";
import { explainScore, ceilingScore, deltaScore, renderExplain, renderCeiling, renderDelta } from "../core/score.js";
import { analyzeTestCoverage, testGaps, testCredit, renderTestGaps, renderTestCredit } from "../core/testGuidance.js";
import { planImprovements, renderImprovePlan } from "../core/improve.js";
import { runVerify, renderVerify } from "../core/verify.js";
import { exportTranscriptMarkdown } from "../core/session.js";
import { bold, dim, red, green, yellow, cyan } from "../core/theme.js";

const themeHelpers = { bold, dim, red, green, yellow, cyan };

function formatMapSummary(g) {
  const lines = [`files: ${g.stats.fileCount}  loc: ${g.stats.totalLoc}  workflows: ${g.workflows.length}`,
    `call resolution: ${(g.stats.callResolutionRate * 100).toFixed(1)}%  repo confidence: ${g.repoConfidence}`];
  for (const wf of g.workflows) lines.push(`  [${wf.confidence.score}] ${wf.id} (${wf.files.length} files)`);
  if (g.orphans.length) lines.push(`orphans: ${g.orphans.join(", ")}`);
  return lines.join("\n");
}

/**
 * `deps`: { rootDir, config, session? }. Returns a table of
 * `command -> async (args[]) -> { ok, text }`.
 */
export function createCommandTable(deps) {
  const abs = path.resolve(deps.rootDir);

  return {
    "/map": async () => {
      const g = buildScoredGraph(abs);
      return { ok: true, text: formatMapSummary(g) };
    },

    "/baseline": async () => {
      const g = buildScoredGraph(abs);
      const p = saveBaseline(abs, g);
      return { ok: true, text: `Baseline saved → ${p} (repo confidence ${g.repoConfidence})` };
    },

    "/check": async () => {
      const loaded = loadBaseline(abs);
      if (!loaded) return { ok: false, text: "No baseline found. Run /baseline first." };
      if (loaded.schemaMismatch) return { ok: false, text: "Baseline schema mismatch — run /baseline to re-snapshot." };
      const current = buildScoredGraph(abs);
      const findings = diffGraphs(loaded.graph, current);
      const saved = saveFindings(abs, findings);
      const resolvedNote = saved.resolvedNow ? `\n${saved.resolvedNow} previously-open finding(s) auto-resolved — not reproduced by this re-check.` : "";
      if (!findings.length) return { ok: true, text: `No regressions. Repo confidence ${loaded.graph.repoConfidence} → ${current.repoConfidence}.${resolvedNote}` };
      return { ok: true, text: findings.map((f) => `[${f.severity.toUpperCase()}] ${f.kind}: ${f.detail}`).join("\n") + resolvedNote };
    },

    "/docs": async () => {
      const g = buildScoredGraph(abs);
      const md = await renderDocs(g, { withNarration: false });
      const out = path.join(abs, "MAP.md");
      fs.writeFileSync(out, md);
      return { ok: true, text: `Docs → ${out}` };
    },

    "/modernize": async (args = []) => {
      const mode = ["light", "medium", "heavy"].includes(args[0]) ? args[0] : "medium";
      const g = buildScoredGraph(abs);
      const report = runModernizationScan(abs, g, loadPkg(abs), mode);
      const freshCount = report.findings.length; // before the save merges in carried lifecycle entries
      const saved = saveModernizationReport(abs, report);
      const resolvedNote = saved.resolvedNow ? ` ${saved.resolvedNow} previously-open finding(s) auto-resolved.` : "";
      return { ok: true, text: `${freshCount} modernization finding(s) (${mode} mode).${resolvedNote}` };
    },

    "/review": async () => {
      const { items, freshness } = loadQueueWithStates(abs);
      const open = pending(items);
      if (!open.length) return { ok: true, text: "Queue is empty — nothing awaiting approval." };
      const lines = open.map((i) => `${i.id}  [${i.source}] (${i.state}) ${i.kind}: ${i.detail}`);
      if (freshness.stale && open.some((i) => i.state === "stale")) {
        lines.push(`\n⚠ items marked (stale) come from ${freshness.staleReports.join(", ")}, which predate a newer source change — refresh with /check or /modernize before acting.`);
      }
      return { ok: true, text: lines.join("\n") };
    },

    "/findings": async () => {
      const { items, freshness } = loadQueueWithStates(abs);
      const open = pending(items).filter((i) => i.source === "check" || i.source.startsWith("modernize-"));
      if (!open.length) return { ok: true, text: "No open findings." };
      const lines = open.map((i) => `${i.id}  [${i.source}] (${i.state}) ${i.kind}: ${i.detail}`);
      if (freshness.stale && open.some((i) => i.state === "stale")) {
        lines.push(`\n⚠ items marked (stale) come from ${freshness.staleReports.join(", ")}, which predate a newer source change — refresh with /check or /modernize before acting.`);
      }
      return { ok: true, text: lines.join("\n") };
    },

    "/evidence": async (args = []) => {
      const id = args[0];
      if (!id) return { ok: false, text: "Usage: /evidence <finding-id> — list IDs with /findings or /review." };
      const data = buildFindingEvidence(abs, id);
      if (!data) return { ok: false, text: `No item with ID ${id}. List current IDs with /review.` };
      return { ok: true, text: renderFindingEvidence(data) };
    },

    "/project": async () => {
      const g = buildScoredGraph(abs);
      const summary = getRepoStatusSummary(g);
      return {
        ok: true,
        text: `root: ${abs}\nfiles: ${summary.fileCount}  workflows: ${summary.workflowCount}  confidence: ${summary.repoConfidence}\nworkflows:\n` +
          getWorkflowSummaries(g).map((w) => `  [${w.confidence}] ${w.id} (${w.fileCount} files)`).join("\n"),
      };
    },

    "/context": async () => {
      const session = deps.session;
      if (!session) return { ok: true, text: "No active session." };
      const lines = [
        `${session.turns.length} turn(s) in this session.`,
        `files inspected: ${session.filesInspected.size ? [...session.filesInspected].join(", ") : "none yet"}`,
        `findings discussed: ${session.findingsDiscussed.size ? [...session.findingsDiscussed].join(", ") : "none yet"}`,
        `commands executed: ${session.commandsExecuted.length ? session.commandsExecuted.map((c) => c.label).join(", ") : "none yet"}`,
        `patches proposed: ${session.patchesProposed.length ? session.patchesProposed.map((p) => `${p.id} (${p.status})`).join(", ") : "none yet"}`,
        `patches applied: ${session.patchesApplied.length ? session.patchesApplied.map((p) => p.id).join(", ") : "none yet"}`,
      ];
      return { ok: true, text: lines.join("\n") };
    },

    "/status": async () => {
      const g = buildScoredGraph(abs);
      const loaded = loadBaseline(abs);
      const { items } = loadQueueWithStates(abs);
      const open = pending(items);
      const staleCount = open.filter((i) => i.state === "stale").length;
      // ceiling-awareness: chat should proactively disclose the honest maximum,
      // never let a reader assume 1.0 is reachable when it structurally isn't.
      const ceiling = ceilingScore(abs, g);
      const ceilingNote = ceiling.ceilingSignalCoverage < 1
        ? ` — 1.0 is not honestly reachable (signalCoverage caps at ${ceiling.ceilingSignalCoverage}: ${ceiling.caps.map((c) => c.cap).join(", ")})`
        : "";
      return {
        ok: true,
        text: `repo confidence: ${g.repoConfidence} (honest ceiling ${ceiling.ceiling}${ceilingNote})\nbaseline: ${loaded ? (loaded.schemaMismatch ? "schema mismatch — re-run /baseline" : "present") : "none"}\nopen findings: ${open.length}${staleCount ? ` (${staleCount} from stale report(s) — refresh with /check or /modernize)` : ""}\ntip: /improve for a ranked plan, /score explain for the breakdown`,
      };
    },

    "/score": async (args = []) => {
      const sub = (args[0] || "explain").toLowerCase();
      const g = buildScoredGraph(abs);
      if (sub === "ceiling") return { ok: true, text: renderCeiling(ceilingScore(abs, g)) };
      if (sub === "delta") {
        const loaded = loadBaseline(abs);
        if (!loaded) return { ok: false, text: "No baseline found. Run /baseline first." };
        if (loaded.schemaMismatch) return { ok: false, text: "Baseline schema mismatch — run /baseline to re-snapshot." };
        return { ok: true, text: renderDelta(deltaScore(loaded.graph, g)) };
      }
      return { ok: true, text: renderExplain(explainScore(g), { workflow: sub !== "explain" ? args[0] : undefined }) };
    },

    "/ceiling": async () => {
      const g = buildScoredGraph(abs);
      return { ok: true, text: renderCeiling(ceilingScore(abs, g)) };
    },

    "/test-gaps": async (args = []) => {
      const analysis = analyzeTestCoverage(abs, buildScoredGraph(abs));
      const gaps = testGaps(analysis, { includeShallow: args.includes("--shallow") });
      return { ok: true, text: renderTestGaps(analysis, gaps, themeHelpers) };
    },

    "/test-credit": async (args = []) => {
      const paddingOnly = args.includes("--padding");
      const analysis = analyzeTestCoverage(abs, buildScoredGraph(abs));
      return { ok: true, text: renderTestCredit(testCredit(analysis, { paddingOnly }), themeHelpers, { paddingOnly }) };
    },

    "/improve": async (args = []) => {
      let budget, risk = "low";
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--budget") budget = args[++i];
        else if (args[i] === "--risk") risk = args[++i];
      }
      return { ok: true, text: renderImprovePlan(planImprovements(abs, { budget, risk })) };
    },

    "/verify": async (args = []) => {
      return { ok: true, text: renderVerify(runVerify(abs, { strict: args.includes("--strict") })) };
    },

    "/transcript": async (args = []) => {
      const session = deps.session;
      if (!session) return { ok: false, text: "No active session to save." };
      const md = exportTranscriptMarkdown(session);
      const out = args[0] ? path.resolve(abs, args[0]) : path.join(abs, ".mapd", "sessions", `${session.id}.md`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, md);
      return { ok: true, text: `Transcript (${session.turns.length} turn(s)) → ${out}` };
    },

    "/diagnose": async (args = []) => {
      const top = Number.parseInt(args[0], 10) || 5;
      return { ok: true, text: renderDiagnosis(buildDiagnosis(abs, { top })) };
    },

    "/handoff": async (args = []) => {
      const top = Number.parseInt(args[0], 10) || 5;
      const data = buildHandoff(abs, { top });
      return { ok: true, text: renderHandoffPrompt(data) };
    },

    "/solutions": async (args = []) => {
      const top = Number.parseInt(args[0], 10) || 5;
      let data = buildSolutions(abs, { top });
      // chat already has a provider in hand when one's configured — narrate
      // automatically here, unlike the CLI's opt-in --narrate (no surprise
      // network calls from a scripted `mapd solutions` invocation).
      if (deps.provider) data = await narrateSolutions(data, deps.provider);
      return { ok: true, text: renderSolutions(data) };
    },

    "/trace": async (args = []) => {
      const [fileArg, toArg] = args;
      if (!fileArg) return { ok: false, text: "Usage: /trace <file> [to-file] — explain why a file is in/out of a workflow, or the chain connecting two files." };
      const g = buildScoredGraph(abs);
      const from = resolveFile(g, fileArg);
      if (from.notFound) return { ok: false, text: `No file matching "${fileArg}". List files with /map.` };
      if (from.ambiguous) return { ok: false, text: `"${fileArg}" is ambiguous — matches: ${from.ambiguous.join(", ")}` };
      if (toArg) {
        const target = resolveFile(g, toArg);
        if (target.notFound) return { ok: false, text: `No file matching "${toArg}".` };
        if (target.ambiguous) return { ok: false, text: `"${toArg}" is ambiguous — matches: ${target.ambiguous.join(", ")}` };
        return { ok: true, text: renderTracePath(tracePath(g, from.file, target.file), themeHelpers) };
      }
      return { ok: true, text: renderTraceFile(traceFile(g, from.file), themeHelpers) };
    },

    "/resolution": async (args = []) => {
      const top = Number.parseInt(args[0], 10) || 10;
      const g = buildScoredGraph(abs);
      return { ok: true, text: renderResolution(analyzeResolution(g, { top }), themeHelpers) };
    },

    "/find": async (args = []) => {
      const query = args.join(" ").trim();
      if (!query) return { ok: false, text: "Usage: /find <query> — ranked symbol/file hits for a task or question." };
      const g = buildScoredGraph(abs);
      const data = buildTaskContext(g, query, { maxHits: 8, maxFiles: 8 });
      if (!data.hits.length && !data.files.length) return { ok: true, text: `No symbol or file matches for "${query}".` };
      const lines = [];
      if (data.hits.length) lines.push("Top hits:", ...data.hits.map((h) => `  ${h.file}#${h.function}  (score ${h.score})`));
      if (data.files.length) lines.push("Relevant files:", ...data.files.map((f) => `  ${f.file}  (${f.loc} LOC)`));
      if (data.workflows.length) lines.push("Matched workflows:", ...data.workflows.map((w) => `  ${w.id}`));
      return { ok: true, text: lines.join("\n") };
    },

    "/help": async () => ({
      ok: true,
      text: "Slash commands: /map /baseline /check /docs /modernize /review /findings /evidence <id> /project /context /status /diagnose /handoff /solutions\n" +
        "  /score [explain|ceiling|delta] /ceiling /trace <file> [to] /resolution /find <query> /test-gaps /test-credit [--padding] /improve [--budget 2h --risk low] /verify [--strict] /transcript [file] /help /clear /end\n" +
        "Natural language also works: \"what's the honest ceiling\", \"what should I work on\", \"show test gaps\", \"is the project passing\", \"trace <file>\", \"what's dragging down the resolution rate\", \"find code related to <topic>\", \"approve finding <id>\", \"fix the highest-severity finding\".",
    }),
  };
}
