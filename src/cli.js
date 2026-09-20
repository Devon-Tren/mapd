#!/usr/bin/env node
/**
 * Map'd — topical layer over a project directory.
 * Function 2 MVP: map → score → document → detect regressions → propose (never apply) fixes.
 */

import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadEnvFiles } from "./core/envFiles.js";
import { loadPkg } from "./core/graph.js";
import { buildScoredGraph, buildTaskContext } from "./core/intelligence.js";
import { renderDocs } from "./core/docs.js";
import { saveBaseline, loadBaseline, diffGraphs, saveFindings } from "./core/regression.js";
import { proposeFix, llmAvailable, resolveConflict, migrationPlan } from "./agents/llm.js";
import { detectConflicts, verifyProposal, scoreResolution, saveIntegrationReport, applyProposals } from "./core/integrate.js";
import { runModernizationScan, saveModernizationReport } from "./core/modernize.js";
import { loadQueue, pending, transition, loadQueueWithStates } from "./core/review.js";
import { buildFindingEvidence, renderFindingEvidence } from "./core/evidence.js";
import { loadConfig, validateConfig, initConfig, setAnnotation, removeAnnotation, listAnnotations } from "./config/index.js";
import { ANNOTATION_CLASSIFICATIONS } from "./config/schema.js";
import { applyAnnotations } from "./core/reachability.js";
import { runFixLifecycle } from "./core/fix.js";
import { chooseFixTarget, approveFixWithPostApplyVerification } from "./core/fixApply.js";
import { loadChanges, rollbackChange } from "./core/changes.js";
import { loadAudits, getAudit, recordAudit } from "./core/audit.js";
import { startChat, createChatContext, handleInput } from "./chat/repl.js";
import { startMcpServer } from "./mcp/server.js";
import { startWatcher } from "./core/watch.js";
import { runDoctor } from "./core/doctor.js";
import { buildHandoff, renderHandoffPrompt } from "./core/handoff.js";
import { buildSolutions, narrateSolutions, renderSolutions } from "./core/solutions.js";
import { buildDiagnosis, renderDiagnosis } from "./core/diagnose.js";
import { explainScore, ceilingScore, simulateScore, deltaScore, renderExplain, renderCeiling, renderSimulate, renderDelta } from "./core/score.js";
import { analyzeTestCoverage, testGaps, testCredit, renderTestGaps, renderTestCredit, honestlyTestedFiles } from "./core/testGuidance.js";
import { planImprovements, renderImprovePlan, renderAgentPack } from "./core/improve.js";
import { runVerify, renderVerify } from "./core/verify.js";
import { lintConfig, renderConfigLint } from "./core/configLint.js";
import { resolveFile, traceFile, tracePath, renderTraceFile, renderTracePath } from "./core/trace.js";
import { analyzeResolution, renderResolution } from "./core/resolution.js";
import { buildViewModel, renderViewHtml } from "./core/view.js";
import { startViewServer, openBrowser } from "./core/viewServer.js";
import { getProvider } from "./agents/provider.js";
import { buildAssist, renderAssist } from "./core/assist.js";
import { bold, dim, red, green, yellow, cyan, confidenceColor, wrapList } from "./core/theme.js";

// Load .env (project cwd, then a user-level ~/.env fallback) before anything
// else reads process.env (ANTHROPIC_API_KEY / OPENAI_API_KEY / KIMI_API_KEY,
// etc.) — see core/envFiles.js for the precedence rule. Never overwrites a
// variable already exported in the shell.
loadEnvFiles();

// A CLI user's mistake (nonexistent dir, malformed .mapdrc, unreadable file)
// should read as one actionable line, not a stack trace. MAPD_DEBUG=1
// restores full stacks for actual debugging.
const friendlyFail = (e) => {
  if (process.env.MAPD_DEBUG) console.error(e);
  else console.error(`mapd: ${e?.message ?? e} (set MAPD_DEBUG=1 for the full stack)`);
  process.exit(1);
};
process.on("uncaughtException", friendlyFail);
process.on("unhandledRejection", friendlyFail);

const pkgVersion = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const program = new Command();
program.name("mapd")
  .description("Verification-first project-understanding layer: deterministic workflow mapping, derived confidence, chat, fix engine, and MCP")
  .version(pkgVersion)
  // Required (per Commander's own docs) for any nested group — `fix`,
  // `tools`, etc. — whose subcommands reuse an option name already declared
  // on the group itself (e.g. `fix`'s own --json vs `fix review`'s --json):
  // without it, an ancestor's own option-parsing greedily claims a flag
  // before the subcommand ever gets a chance to see it. Root itself has no
  // options of its own to misparse, so this is a no-op everywhere else.
  .enablePositionalOptions();

function renderTaskContext(data) {
  const lines = [];
  lines.push(`${bold("Map'd context")} — ${cyan(data.query)}`);
  lines.push(`files: ${data.summary.fileCount}  workflows: ${data.summary.workflowCount}  confidence: ${confidenceColor(data.summary.repoConfidence)(data.summary.repoConfidence)}`);
  if (data.caveats.length) {
    lines.push("");
    lines.push(`${yellow("caveats:")}`);
    for (const c of data.caveats) lines.push(`  - ${c}`);
  }
  lines.push("");
  lines.push(bold("Top hits"));
  if (!data.hits.length) {
    lines.push("  no symbol matches");
  } else {
    for (const h of data.hits) {
      const tags = [h.exported ? "exported" : null, h.matches?.length ? `matched ${h.matches.join(", ")}` : null]
        .filter(Boolean).join("; ");
      lines.push(`  ${h.file}#${h.function}  ${dim(`score ${h.score}${tags ? `; ${tags}` : ""}`)}`);
    }
  }
  lines.push("");
  lines.push(bold("Relevant files"));
  if (!data.files.length) {
    lines.push("  no files selected");
  } else {
    for (const f of data.files) {
      const exportsText = f.exports.length ? ` exports: ${f.exports.join(", ")}` : "";
      lines.push(`  ${f.file}  ${dim(`${f.loc} LOC; ${f.functions.length} parsed function(s)${exportsText}`)}`);
    }
  }
  if (data.workflows.length) {
    lines.push("");
    lines.push(bold("Matched workflows"));
    for (const wf of data.workflows) {
      lines.push(`  ${wf.id}  ${dim(`${wf.fileCount} files; matched ${wf.matchedFiles.join(", ")}`)}`);
    }
  }
  return lines.join("\n");
}

function renderProfile(profile) {
  if (!profile) return "";
  const lines = [`${bold("Profile")}: total ${profile.totalMs}ms`];
  for (const step of profile.steps ?? []) {
    lines.push(`  ${step.name}: ${step.durationMs}ms`);
  }
  return lines.join("\n");
}

function timedValue(fn) {
  const startedAt = performance.now();
  const value = fn();
  return { value, durationMs: Number((performance.now() - startedAt).toFixed(2)) };
}

function registryOptsFromCli(opts) {
  return {
    checkRegistry: opts.registry !== false,
    registryTimeoutMs: Number.parseInt(opts.registryTimeout, 10) || 2000,
  };
}

function looksLikeDirectoryArg(value) {
  if (!value) return false;
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\")) return true;
  try { return fs.statSync(path.resolve(value)).isDirectory(); } catch { return false; }
}

/**
 * Registers the same command (identical arguments/options/description/action)
 * under multiple parents — used to keep a legacy top-level name working
 * (hidden from help/listing, per backward-compat) while also exposing the
 * same functionality at its new, consolidated location. `build` chains
 * .argument/.option/.description onto the Command it's given and returns it;
 * `action` is attached once per registration so there is exactly one action
 * body regardless of how many entry points reach it.
 */
function twin(parents, name, build, action) {
  return parents.map(({ cmd, cmdOpts }) => build(cmd.command(name, cmdOpts)).action(action));
}

async function mapAction(dir, opts) {
  const abs = path.resolve(dir);
  if (opts.view) {
    if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(buildScoredGraph(abs), null, 2));
    if (!opts.static && !opts.out) {
      const { url, providerAvailable } = await startViewServer(abs, { port: opts.port ?? 0, open: opts.open });
      console.log(`${green("Map'd view")} live at ${cyan(url)}  ${dim("(chat embedded — Ctrl-C to stop)")}`);
      console.log(dim(`  chat: command-style questions ("what should I work on", "show test gaps", "is it passing") answer instantly; ${providerAvailable ? "free-form Q&A uses your LLM and can take a while" : "set ANTHROPIC_API_KEY/OPENAI_API_KEY/KIMI_API_KEY for free-form answers"}.`));
      return;
    }
    const model = buildViewModel(abs);
    const out = path.resolve(abs, opts.out || "mapd-view.html");
    fs.writeFileSync(out, renderViewHtml(model));
    console.log(`${green("Map'd view")} → ${out}  ${dim(`(static, no chat — ${model.stats.files} files, ${model.stats.workflows} workflows)`)}`);
    if (opts.open) openBrowser(`file://${out}`);
    return;
  }

  const built = opts.profile ? timedValue(() => buildScoredGraph(dir)) : null;
  const g = built ? built.value : buildScoredGraph(dir);
  if (opts.json) {
    fs.writeFileSync(opts.json, JSON.stringify(g, null, 2));
  }
  const loaded = loadBaseline(abs);
  const { items } = loadQueueWithStates(abs);
  const open = pending(items);
  console.log(`\n${bold("Map'd")} — ${dim(abs)}`);
  console.log(`  files: ${g.stats.fileCount}  loc: ${g.stats.totalLoc}  workflows: ${g.workflows.length}`);
  console.log(`  call resolution: ${(g.stats.callResolutionRate * 100).toFixed(1)}%  repo confidence: ${confidenceColor(g.repoConfidence)(g.repoConfidence)}`);
  console.log(`  baseline: ${loaded ? (loaded.schemaMismatch ? red("schema-mismatch") : green("present")) : dim("none")}  open findings: ${open.length > 0 ? yellow(open.length) : green(open.length)}\n`);
  for (const wf of g.workflows) {
    console.log(`  ${confidenceColor(wf.confidence.score)(`[${wf.confidence.score}]`)} ${wf.id}  ${dim(`(${wf.files.length} files, signal coverage ${wf.confidence.signalCoverage})`)}`);
  }
  if (g.orphans.length) console.log(`\n  ${yellow("orphans:")} ${wrapList(g.orphans, { width: 90, indent: "           " })}`);
  if (g.stats.heuristicFileCount) {
    console.log(`\n  ${dim(`${g.stats.heuristicFileCount} non-JS/TS file(s) mapped by heuristic language adapters (half-weight in confidence; disable with .mapdrc mapping.polyglot=false)`)}`);
  }
  if (g.reachability?.heuristicUnverified?.length) {
    console.log(`  ${dim(`${g.reachability.heuristicUnverified.length} heuristic-parsed file(s) unreached by import tracing — unverifiable, NOT claimed orphaned`)}`);
  }
  if (opts.json) console.log(`\n  raw graph → ${opts.json}`);
  if (built) console.log(`\n  ${dim(`map built in ${built.durationMs}ms`)}`);

  const hint = !loaded ? "mapd check --save-baseline to start tracking regressions"
    : open.length ? "mapd fix review to see what's awaiting approval"
    : "mapd check for regressions, or mapd chat to explore";
  console.log(`\n  ${dim(`Next: ${hint}`)}`);
}

program
  .command("map")
  .argument("[dir]", "project root", ".")
  .option("--json <file>", "also write the raw scored graph as JSON (or, with --view, print the view model as JSON)")
  .option("--profile", "also print map-build timing (for modernization-scan timing use `tools modernize --profile`)")
  .option("--view", "open a browser view instead (workflow graph, heatmap, embedded chat) — see the options below")
  .option("--static", "with --view, write a self-contained HTML file instead of serving (no chat panel)")
  .option("--out <file>", "with --view, output HTML path (implies --static)")
  .option("--port <n>", "with --view, port for the local server (default: an open port)", (v) => Number.parseInt(v, 10))
  .option("--no-open", "with --view, don't open a browser automatically")
  .description("Build the scored workflow map and print a summary (baseline + queue status included). --view opens an interactive browser view instead.")
  .action(mapAction);

program
  .command("context", { hidden: true }) // reachable via `mapd chat`: "find code related to <topic>"
  .argument("<query>", "task or question to build context for")
  .argument("[dir]", "project root", ".")
  .option("--json", "print the raw context pack as JSON")
  .option("--hits <n>", "maximum ranked symbol hits", "8")
  .option("--files <n>", "maximum relevant file cards", "8")
  .description("Build a compact graph-backed context pack for a task/question")
  .action((query, dir, opts) => {
    const g = buildScoredGraph(dir);
    const data = buildTaskContext(g, query, {
      maxHits: Number.parseInt(opts.hits, 10) || 8,
      maxFiles: Number.parseInt(opts.files, 10) || 8,
    });
    console.log(opts.json ? JSON.stringify(data, null, 2) : renderTaskContext(data));
  });

program
  .command("baseline", { hidden: true }) // folded into `mapd check --save-baseline`
  .argument("[dir]", "project root", ".")
  .description("Snapshot the current scored map as the regression baseline")
  .action((dir) => {
    const g = buildScoredGraph(dir);
    const p = saveBaseline(path.resolve(dir), g);
    console.log(`Baseline saved → ${p} (repo confidence ${g.repoConfidence})`);
  });

program
  .command("check")
  .argument("[dir]", "project root", ".")
  .option("--propose", "draft LLM fix proposals for high-severity findings (requires ANTHROPIC_API_KEY)")
  .option("--json", "print the structured result (findings, confidence delta, resolved count) as JSON")
  .option("--save-baseline", "snapshot the current scored map as the regression baseline, instead of diffing against one")
  .description("Diff current map against baseline; write findings awaiting approval and auto-resolve ones that no longer reproduce (exits 2 on high-severity findings — CI-friendly). --save-baseline snapshots instead of diffing.")
  .action(async (dir, opts) => {
    const abs = path.resolve(dir);
    if (opts.saveBaseline) {
      const g = buildScoredGraph(dir);
      const p = saveBaseline(abs, g);
      if (opts.json) { console.log(JSON.stringify({ ok: true, path: p, repoConfidence: g.repoConfidence }, null, 2)); return; }
      console.log(`Baseline saved → ${p} (repo confidence ${g.repoConfidence})`);
      return;
    }
    const loaded = loadBaseline(abs);
    if (!loaded) {
      if (opts.json) { console.log(JSON.stringify({ ok: false, error: "no-baseline" }, null, 2)); }
      else console.error("No baseline found. Run `mapd check --save-baseline` first.");
      process.exitCode = 1;
      return;
    }
    if (loaded.schemaMismatch) {
      if (opts.json) { console.log(JSON.stringify({ ok: false, error: "schema-mismatch", schemaMismatch: loaded.schemaMismatch }, null, 2)); }
      else console.error(`Baseline schema v${loaded.schemaMismatch.found} does not match this Map'd (v${loaded.schemaMismatch.expected}). ` +
        "Diffing across schemas would misreport — run `mapd check --save-baseline` to re-snapshot.");
      process.exitCode = 1;
      return;
    }
    const baseline = loaded.graph;
    const current = buildScoredGraph(dir);
    const findings = diffGraphs(baseline, current);
    // A re-check that reproduces nothing is what auto-RESOLVES previously-open
    // findings (see regression.js saveFindings) — always save, even when clean.
    const confidence = { from: baseline.repoConfidence, to: current.repoConfidence };
    if (!findings.length) {
      const saved = saveFindings(abs, findings);
      if (opts.json) { console.log(JSON.stringify({ ok: true, findings: [], confidence, resolvedNow: saved.resolvedNow, path: saved.path }, null, 2)); return; }
      console.log(green(`No regressions. Repo confidence ${confidence.from} → ${confidence.to}.`));
      if (saved.resolvedNow) console.log(green(`${saved.resolvedNow} previously-open finding(s) auto-resolved — not reproduced by this re-check.`));
      return;
    }
    if (!opts.json) {
      for (const f of findings) {
        const sevColor = f.severity === "high" ? red : f.severity === "medium" ? yellow : dim;
        console.log(`  ${sevColor(`[${f.severity.toUpperCase()}]`)} ${bold(f.kind)}: ${f.detail}`);
      }
    }

    if (opts.propose) {
      if (!llmAvailable()) {
        if (!opts.json) console.log("\n--propose requires ANTHROPIC_API_KEY; findings saved without proposals.");
      } else {
        for (const f of findings.filter((x) => x.severity === "high")) {
          const sources = (f.evidence?.files ?? [])
            .slice(0, 3)
            .map((file) => {
              try { return { file, source: fs.readFileSync(path.join(abs, file), "utf8").slice(0, 8000) }; }
              catch { return { file, source: null }; }
            });
          f.proposal = await proposeFix(f, sources);
          if (!opts.json) console.log(`  → proposal drafted for ${f.kind} (awaiting approval)`);
        }
      }
    }
    const saved = saveFindings(abs, findings);
    process.exitCode = findings.some((f) => f.severity === "high") ? 2 : 0; // CI-friendly
    if (opts.json) { console.log(JSON.stringify({ ok: true, findings, confidence, resolvedNow: saved.resolvedNow, path: saved.path }, null, 2)); return; }
    console.log(`\n${findings.length} finding(s) → ${saved.path} (status: awaiting-approval — nothing was modified)`);
    if (saved.resolvedNow) console.log(green(`${saved.resolvedNow} previously-open finding(s) auto-resolved — not reproduced by this re-check.`));
    console.log(dim(`\nNext: mapd fix will auto-select and propose a fix for the strongest open finding.`));
  });

// `tools` — advanced/scriptable functionality that isn't part of the daily
// map/check/fix/chat loop: still fully supported, just not top-level noise.
const tools = program.command("tools")
  .description("Advanced tools: docs, integrate, modernize, watch, test coverage, change ledger, MCP server, improvement planner, command listing");

twin(
  [{ cmd: program, cmdOpts: { hidden: true } }, { cmd: tools, cmdOpts: undefined }],
  "docs",
  (c) => c
    .argument("[dir]", "project root", ".")
    .option("-o, --out <file>", "output file", "MAP.md")
    .option("--no-narration", "skip LLM narration even if a key is present")
    .description("Render MAP.md from the scored graph"),
  async (dir, opts) => {
    const g = buildScoredGraph(dir);
    const md = await renderDocs(g, { withNarration: opts.narration });
    const out = path.resolve(dir, opts.out);
    fs.writeFileSync(out, md);
    console.log(`Docs → ${out} (narration: ${opts.narration && llmAvailable() ? "on" : "off — deterministic only"})`);
  },
);

twin(
  [{ cmd: program, cmdOpts: { hidden: true } }, { cmd: tools, cmdOpts: undefined }],
  "integrate",
  (c) => c
    .argument("<branch>", "branch to merge into the current branch")
    .argument("[dir]", "project root", ".")
    .option("--propose", "draft LLM resolutions for classified conflicts (requires ANTHROPIC_API_KEY)")
    .option("--apply", "apply proposals from the saved report that meet the threshold")
    .option("--threshold <n>", "minimum derived resolution score for --apply", "0.8")
    .description("F1: detect + classify merge conflicts; optionally propose gated resolutions"),
  async (branch, dir, opts) => {
    const abs = path.resolve(dir);
    const allFiles = fs.existsSync(abs) ? buildScoredGraph(dir).files.map((f) => f.file) : [];
    const hasTest = (file) => {
      const base = path.posix.basename(file).replace(/\.(js|ts|jsx|tsx|mjs|cjs)$/, "");
      return allFiles.some((f) => /(\.test\.|\.spec\.|__tests__\/|tests?\/)/.test(f) && f.includes(base));
    };

    const { mergeable, conflicts, mergeError, requiresGit } = detectConflicts(abs, branch);
    if (requiresGit) {
      console.error("`mapd integrate` needs a git repository — this project isn't one. It merges the branch in an isolated worktree to classify conflicts, so there's nothing to integrate without git.");
      process.exitCode = 1;
      return;
    }
    if (mergeError) {
      console.error(`Merge attempt failed before conflict detection:\n  ${mergeError}`);
      process.exitCode = 1;
      return;
    }
    if (mergeable) {
      console.log(`Merging '${branch}' is clean — no congruence issues. Run your normal merge.`);
      return;
    }
    console.log(`\n${conflicts.length} conflicted file(s) merging '${branch}':`);
    for (const c of conflicts) console.log(`  [${c.classification}] ${c.file}`);

    if (opts.propose) {
      if (!llmAvailable()) {
        console.log("\n--propose requires ANTHROPIC_API_KEY; report saved with classification only.");
      } else {
        for (const c of conflicts) {
          if (!c.ours || !c.theirs) { c.proposal = { status: "manual-required", reason: c.classification }; continue; }
          const merged = await resolveConflict(c);
          if (!merged) continue;
          const gates = verifyProposal(c, merged);
          const failed = gates.filter((g) => !g.passed);
          c.proposal = {
            mergedSource: merged,
            gates,
            status: failed.length ? "rejected-by-gate" : "awaiting-approval",
            resolutionScore: scoreResolution(c, gates, hasTest(c.file)),
          };
          console.log(`  → ${c.file}: ${c.proposal.status}` +
            (failed.length ? ` (${failed.map((g) => g.gate).join(", ")})` : ` [score ${c.proposal.resolutionScore.score}]`));
        }
      }
    }

    const report = { branch, generatedAt: new Date().toISOString(), conflicts };
    const p = saveIntegrationReport(abs, branch, report);
    console.log(`\nIntegration report → ${p} (nothing was modified)`);

    if (opts.apply) {
      const t = parseFloat(opts.threshold);
      const { applied, skipped } = applyProposals(abs, report, t);
      for (const a of applied) console.log(`  APPLIED ${a.file} (score ${a.score} ≥ ${t})`);
      for (const s of skipped) console.log(`  skipped ${s.file} (${s.reason ?? `score ${s.score} < ${t}`})`);
      if (applied.length) console.log(`\nApplied files are working-tree edits — review the diff, then commit yourself.`);
    }
  },
);

twin(
  [{ cmd: program, cmdOpts: { hidden: true } }, { cmd: tools, cmdOpts: undefined }],
  "modernize",
  (c) => c
    .argument("[modeOrDir]", "scan mode (light | medium | heavy; defaults to medium) or project root")
    .argument("[dir]", "project root", ".")
    .option("-m, --mode <mode>", "light | medium | heavy (same as the positional mode)")
    .option("--profile", "include deterministic phase timing in the saved report and terminal output")
    .option("--no-registry", "skip npm outdated registry check (faster/offline deterministic scan)")
    .option("--registry-timeout <ms>", "npm outdated timeout in milliseconds", "2000")
    .option("--propose", "heavy mode: draft LLM migration plans for top findings (requires ANTHROPIC_API_KEY)")
    .option("--json", "print the structured report (findings with operational-impact scores) as JSON")
    .description("F3: rule-based modernization scan with derived operational-impact scores — `mapd tools modernize` (medium), `heavy`, `light`"),
  async (modeOrDir, dir, opts) => {
    // `mapd modernize heavy` / `mapd modernize light [dir]` — the first
    // positional is a mode when it names one, otherwise it is the project dir
    const MODES = ["light", "medium", "heavy"];
    let positionalMode = null;
    if (modeOrDir !== undefined) {
      if (MODES.includes(modeOrDir.toLowerCase())) positionalMode = modeOrDir.toLowerCase();
      else if (dir === ".") dir = modeOrDir;
      else {
        console.error(`Unknown mode '${modeOrDir}'. Use light, medium, or heavy (or omit for medium).`);
        process.exitCode = 1;
        return;
      }
    }
    const mode = positionalMode ?? opts.mode ?? "medium";
    if (!MODES.includes(mode)) {
      console.error(`Unknown mode '${mode}'. Use light, medium, or heavy.`);
      process.exitCode = 1;
      return;
    }
    if (positionalMode && opts.mode && opts.mode !== positionalMode) {
      console.error(`Conflicting modes: positional '${positionalMode}' vs --mode '${opts.mode}'. Pass one or the other.`);
      process.exitCode = 1;
      return;
    }
    opts.mode = mode;
    const abs = path.resolve(dir);
    const g = buildScoredGraph(dir);
    const report = runModernizationScan(abs, g, loadPkg(abs), opts.mode, { profile: opts.profile, ...registryOptsFromCli(opts) });

    if (!opts.json) {
      console.log(`\n${bold(`Modernization scan (${opts.mode})`)} — ${report.findings.length} finding(s):\n`);
      for (const f of report.findings) {
        const oi = f.operationalImpact;
        if (!oi) { console.log(`  ${dim("[info]")} ${f.detail}`); continue; }
        const priorityColor = oi.priority >= 0.5 ? red : oi.priority >= 0.2 ? yellow : dim;
        console.log(`  ${priorityColor(`[priority ${oi.priority}]`)} ${dim(`(${f.tier})`)} ${bold(f.rule)}`);
        console.log(`      ${f.detail}`);
        console.log(`      ${dim(`impact ${oi.impact} = reach ${oi.reach} × certainty ${oi.certainty}; safety ${oi.safety}`)}`);
      }
    }

    if (opts.propose && opts.mode === "heavy") {
      if (!llmAvailable()) {
        if (!opts.json) console.log("\n--propose requires ANTHROPIC_API_KEY; report saved without plans.");
      } else {
        for (const f of report.findings.filter((x) => x.operationalImpact).slice(0, 5)) {
          f.migrationPlan = await migrationPlan(f, g.stats);
          if (!opts.json) console.log(`  → migration plan drafted for ${f.rule} (awaiting approval)`);
        }
      }
    } else if (opts.propose && !opts.json) {
      console.log("\n--propose only runs in heavy mode (light/medium are detection-only by design).");
    }

    if (opts.profile && !opts.json) {
      console.log("");
      console.log(renderProfile(report.profile));
    }

    const saved = saveModernizationReport(abs, report);
    if (opts.json) { console.log(JSON.stringify({ mode: opts.mode, findings: report.findings, resolvedNow: saved.resolvedNow, path: saved.path }, null, 2)); return; }
    console.log(`\nReport → ${saved.path} (status: awaiting-approval — nothing was modified)`);
    if (saved.resolvedNow) console.log(green(`${saved.resolvedNow} previously-open finding(s) auto-resolved — not reproduced by this re-scan.`));
  },
);

// `fixCmd` is declared here (ahead of its own full definition further below)
// so `review` and `evidence` can be registered as its subcommands via twin(),
// while also staying reachable at their original hidden top-level path.
// enablePositionalOptions: `fix` and its `review`/`evidence` subcommands both
// declare a `--json` option — without this, Commander's own parser (which
// resolves a command's OWN options before checking whether the first operand
// matches a subcommand name) swallows `--json` as fix's option even when it's
// written after `review`/`evidence`, so the subcommand never sees it. This
// makes Commander stop parsing fix's own options at the first token that
// matches a subcommand name, handing everything after it (in original order)
// to that subcommand instead.
const fixCmd = program.command("fix").enablePositionalOptions();

twin(
  [{ cmd: program, cmdOpts: { hidden: true } }, { cmd: fixCmd, cmdOpts: undefined }],
  "review",
  (c) => c
    .argument("[dir]", "project root", ".")
    .option("--approve <id>", "approve one item by ID (integration proposals get applied)")
    .option("--dismiss <id>", "dismiss one item by ID")
    .option("--reason <text>", "reason recorded with a dismissal")
    .option("--all", "include every item regardless of state (resolved, dismissed, historical)")
    .option("--state <state>", "filter the listing by derived state (active, stale, approved, resolved, dismissed, historical)")
    .option("--json", "print the queue (or the approve/dismiss result) as JSON")
    .description("Unified approval queue across check / integrate / modernize / fix reports, with derived states"),
  (dir, opts) => {
    const abs = path.resolve(dir);
    const { items, freshness } = loadQueueWithStates(abs);

    const targetId = opts.approve ?? opts.dismiss;
    if (targetId) {
      const item = items.find((i) => i.id === targetId);
      if (!item) {
        if (opts.json) { console.log(JSON.stringify({ ok: false, error: "no-such-id", id: targetId }, null, 2)); }
        else console.error(`No item with ID ${targetId}. Run \`mapd fix review\` to list current IDs.`);
        process.exitCode = 1;
        return;
      }
      if (opts.approve && item.state === "stale" && !opts.json) {
        console.log(yellow(`Note: this finding comes from a stale report (${path.basename(item.file)} predates a newer source change) — it may already be fixed.`));
      }
      const r = transition(abs, item, opts.approve ? "approve" : "dismiss", opts.reason);
      if (!r.ok) process.exitCode = 1;
      if (opts.json) { console.log(JSON.stringify({ ok: r.ok, action: r.action, id: item.id, detail: r.detail }, null, 2)); return; }
      console.log(r.ok ? green(`${r.action.toUpperCase()} ${item.id}: ${r.detail}`) : red(`FAILED: ${r.detail}`));
      return;
    }

    const list = opts.state
      ? items.filter((i) => i.state === opts.state)
      : opts.all ? items : pending(items);
    if (opts.json) {
      console.log(JSON.stringify({ count: list.length, freshness, items: list }, null, 2));
      return;
    }
    if (!list.length) {
      console.log(dim(opts.state ? `No items in state "${opts.state}".` : opts.all ? "No reviewable items in any report." : "Queue is empty — nothing awaiting approval."));
      return;
    }
    const staleCount = list.filter((i) => i.state === "stale").length;
    console.log(`\n${bold(`${list.length} item(s)`)}${opts.state ? ` in state "${opts.state}"` : opts.all ? "" : " awaiting approval"}:\n`);
    for (const i of list) {
      const meta = [
        i.severity && `sev:${i.severity}`,
        i.priority != null && `priority:${i.priority}`,
        i.score != null && `score:${i.score}`,
        i.hasProposal && "proposal:yes",
      ].filter(Boolean).join("  ");
      const sevColor = i.severity === "high" ? red : i.severity === "medium" ? yellow : dim;
      const stateColor = i.state === "stale" ? yellow : i.state === "active" ? green : dim;
      console.log(`  ${cyan(i.id)}  ${dim(`[${i.source}]`)} ${bold(i.kind)} ${stateColor(`(${i.state})`)}`);
      console.log(`            ${i.detail}${meta ? `\n            ${sevColor(meta)}` : ""}`);
    }
    if (staleCount) {
      console.log(`\n${yellow(`${staleCount} item(s) marked (stale) come from report(s) that predate a newer source change (${freshness.staleReports.join(", ")}).`)}`);
      console.log(yellow("They may already be fixed — re-run `mapd check` / `mapd tools modernize` before acting on them."));
    }
    console.log(`\n${dim(`Approve: mapd fix review --approve <id>   Dismiss: mapd fix review --dismiss <id> [--reason "..."]   Evidence: mapd fix evidence <id>`)}`);
  },
);

twin(
  [{ cmd: program, cmdOpts: { hidden: true } }, { cmd: fixCmd, cmdOpts: undefined }],
  "evidence",
  (c) => c
    .argument("<id>", "review-queue item ID from `mapd fix review`")
    .argument("[dir]", "project root", ".")
    .option("--json", "print the structured evidence instead of the rendered view")
    .description("Show the deterministic evidence behind one finding: files, workflows, reachability class, annotations, gate results, and report freshness"),
  (id, dir, opts) => {
    const data = buildFindingEvidence(path.resolve(dir), id);
    if (!data) {
      console.error(`No item with ID ${id}. Run \`mapd fix review\` to list current IDs.`);
      process.exitCode = 1;
      return;
    }
    if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }
    console.log(renderFindingEvidence(data));
  },
);

// `configCmd` is declared here (ahead of its own full definition further
// below) so `annotate` can be registered as one of its subcommands via twin,
// while also staying reachable at its original hidden top-level path.
const configCmd = program.command("config").description("Manage .mapdrc project configuration");

const ANNOTATE_DESC = "Manage user-asserted annotations (.mapdrc project.annotations) — the project-knowledge memory for what static analysis cannot know";
// Not using twin() here: these are pure command GROUPS (no action of their
// own, only subcommands), so each just needs .description(), registered once
// per parent — the subcommand loop below is what twin()'s de-duplication
// benefit actually applies to.
const annotateGroups = [
  program.command("annotate", { hidden: true }).description(ANNOTATE_DESC),
  configCmd.command("annotate").description(ANNOTATE_DESC),
];
for (const annotate of annotateGroups) {
  annotate
    .command("add")
    .argument("<pattern>", "glob pattern, e.g. \"eval/results/**\"")
    .argument("<classification>", `one of: ${ANNOTATION_CLASSIFICATIONS.join(", ")}`)
    .argument("[dir]", "project root", ".")
    .description("Assert a classification for files matching a glob; recorded as a rollback-able .mapdrc change and always surfaced as user-asserted, never as detected")
    .action((pattern, classification, dir) => {
      const abs = path.resolve(dir);
      const r = setAnnotation(abs, pattern, classification);
      if (!r.ok) { console.error(`annotate add: ${r.reason}`); process.exitCode = 1; return; }
      recordAudit(abs, { command: "annotate add", initiator: "cli", finalStatus: "applied", changeIds: [r.changeId], pattern, classification });
      console.log(green(`${r.replaced ? "Updated" : "Added"} annotation "${pattern}": "${classification}" → ${r.path} (change ${r.changeId})`));
      if (r.hadComments) console.log(yellow("Note: .mapdrc comments were not preserved by this rewrite (rollback with `mapd tools changes rollback` if needed)."));
      const g = buildScoredGraph(abs);
      const matched = applyAnnotations(new Set(g.files.map((f) => f.file)), { [pattern]: classification });
      console.log(matched.length
        ? `Matches ${matched.length} file(s) in the current map: ${matched.slice(0, 5).map((m) => m.file).join(", ")}${matched.length > 5 ? ", …" : ""}`
        : yellow("Matches 0 files in the current map — check the pattern (globs: ** crosses directories, * stays within a segment)."));
    });

  annotate
    .command("list")
    .argument("[dir]", "project root", ".")
    .option("--json", "print as JSON")
    .description("List resolved annotations and which current files each pattern matches")
    .action((dir, opts) => {
      const abs = path.resolve(dir);
      const annotations = listAnnotations(abs);
      const entries = Object.entries(annotations);
      if (!entries.length) {
        if (opts.json) { console.log("{}"); return; }
        console.log(dim("No annotations. Add one with `mapd config annotate add <pattern> <classification>`."));
        return;
      }
      const g = buildScoredGraph(abs);
      const fileSet = new Set(g.files.map((f) => f.file));
      const matches = applyAnnotations(fileSet, annotations);
      if (opts.json) {
        console.log(JSON.stringify(entries.map(([pattern, classification]) => ({
          pattern, classification,
          matchedFiles: matches.filter((m) => m.pattern === pattern).map((m) => m.file),
        })), null, 2));
        return;
      }
      console.log(`\n${bold(`${entries.length} annotation(s)`)} ${dim("(user-asserted in .mapdrc, surfaced as assertions — never as detected facts)")}\n`);
      for (const [pattern, classification] of entries) {
        const matched = matches.filter((m) => m.pattern === pattern);
        console.log(`  ${cyan(`"${pattern}"`)}: ${bold(classification)}  ${matched.length ? dim(`→ ${matched.length} file(s) in the current map`) : yellow("→ matches 0 files in the current map")}`);
      }
    });

  annotate
    .command("remove")
    .argument("<pattern>", "the exact glob pattern to remove")
    .argument("[dir]", "project root", ".")
    .description("Remove one annotation from the project .mapdrc (recorded as a rollback-able change)")
    .action((pattern, dir) => {
      const abs = path.resolve(dir);
      const r = removeAnnotation(abs, pattern);
      if (!r.ok) { console.error(`annotate remove: ${r.reason}`); process.exitCode = 1; return; }
      recordAudit(abs, { command: "annotate remove", initiator: "cli", finalStatus: "applied", changeIds: [r.changeId], pattern });
      console.log(green(`Removed annotation "${pattern}" → ${r.path} (change ${r.changeId})`));
      if (r.hadComments) console.log(yellow("Note: .mapdrc comments were not preserved by this rewrite (rollback with `mapd tools changes rollback` if needed)."));
    });
}

twin(
  [{ cmd: program, cmdOpts: { hidden: true } }, { cmd: tools, cmdOpts: undefined }],
  "watch",
  (c) => c
    .argument("[dir]", "project root", ".")
    .option("--interval <ms>", "debounce window after a change", "400")
    .option("--json-events", "also print each structured watch event as one JSON line (for external consumers)")
    .description("Continuous mode: re-map on file change (hash-cached), report deltas and regressions live"),
  async (dir, opts) => {
    const abs = path.resolve(dir);
    const intervalMs = Math.max(50, parseInt(opts.interval, 10) || 400);
    const { bus, initialGraph } = startWatcher(abs, { intervalMs });

    console.log(`[watch] initial map: ${initialGraph.stats.fileCount} files, ${initialGraph.workflows.length} workflow(s), confidence ${initialGraph.repoConfidence}`);
    console.log(`[watch] watching ${abs} — Ctrl+C to stop\n`);

    bus.on("error", (e) => console.log(`[watch] rescan failed: ${e.message}`));
    bus.on("remap", (evt) => {
      if (opts.jsonEvents) console.log(JSON.stringify(evt));
      const d = evt.repoConfidence.delta;
      console.log(`[watch] remap ${evt.durationMs}ms (reparsed ${evt.reparsedCount}, cache hits ${evt.cacheHits}) — confidence ${evt.repoConfidence.from} → ${evt.repoConfidence.to} (${d >= 0 ? "+" : ""}${d})`);
      for (const f of evt.newFindings) console.log(`  [${f.severity.toUpperCase()}] ${f.kind}: ${f.detail}`);
      for (const f of evt.resolvedFindings) console.log(`  [INFO] ${f.detail}`);
    });
  },
);

fixCmd
  .argument("[id]", "finding ID from `mapd fix review`; omit to auto-select the strongest open check/modernize finding")
  .argument("[dir]", "project root", ".")
  .option("--propose", "generate and gate-verify a fix proposal (requires a configured LLM provider)")
  .option("--apply", "after a successful --propose, immediately approve and apply the verified proposal")
  .option("--max-attempts <n>", "override fix.maxAttempts from .mapdrc for this run")
  .option("--dry-run", "run the full lifecycle but do not persist a proposal file")
  .option("--impact", "preview the finding's blast radius, risk, test coverage, and modeled score gain — without proposing anything")
  .option("--json", "with --impact, print the impact preview as JSON")
  .description("Load a finding, propose a gate-verified fix, retry on gate failure, and save it awaiting approval. Subcommands: `mapd fix review` (approval queue), `mapd fix evidence <id>`.")
  .action(async (id, dir, opts) => {
    let targetId = id;
    let rootDir = dir;
    if (targetId && dir === "." && looksLikeDirectoryArg(targetId)) {
      rootDir = targetId;
      targetId = null;
    }
    const abs = path.resolve(rootDir);
    const config = loadConfig(abs, { cliOverrides: opts.maxAttempts ? { fix: { maxAttempts: parseInt(opts.maxAttempts, 10) } } : {} });

    if (opts.impact) {
      let impactId = targetId;
      if (!impactId) {
        const selected = chooseFixTarget(pending(loadQueue(abs)));
        if (!selected) { console.error("fix --impact: no open findings to preview. Run `mapd check` or `mapd tools modernize` first."); process.exitCode = 1; return; }
        impactId = selected.id;
      }
      const evidence = buildFindingEvidence(abs, impactId);
      if (!evidence) { console.error(`No finding with ID ${impactId}. List IDs with \`mapd fix review\`.`); process.exitCode = 1; return; }
      const g = buildScoredGraph(abs);
      const wfFiles = new Set(g.workflows.flatMap((w) => w.files));
      const tested = honestlyTestedFiles(g);
      const files = (evidence.files ?? []).map((f) => f.file);
      const inWorkflow = files.filter((f) => wfFiles.has(f));
      const workflows = [...new Set((evidence.files ?? []).flatMap((f) => f.workflows ?? []))];
      const testedCount = inWorkflow.filter((f) => tested.has(f)).length;
      const riskByKind = { "parse-failure": "medium", "export-removed": "high", "workflow-removed": "high", "confidence-regression": "medium", "resolution-degradation": "medium" };
      const risk = riskByKind[evidence.kind] ?? (evidence.severity === "high" ? "high" : evidence.severity === "medium" ? "medium" : "low");
      const modeledGain = evidence.kind === "parse-failure" && inWorkflow.length ? simulateScore(abs, g, { fixParse: inWorkflow }).delta : null;
      const impact = {
        id: impactId, kind: evidence.kind, severity: evidence.severity, risk,
        files, filesInWorkflow: inWorkflow.length, workflows, blastRadius: workflows.length,
        testedFiles: testedCount, untestedFiles: inWorkflow.length - testedCount,
        modeledScoreGain: modeledGain,
        note: modeledGain == null ? "score gain from resolving this finding isn't directly modeled — it removes the finding and its regression risk; use `mapd score simulate` to model specific signal changes." : null,
      };
      if (opts.json) { console.log(JSON.stringify(impact, null, 2)); return; }
      console.log(`\n${bold("fix impact")} — ${cyan(impactId)} ${dim(`(${evidence.kind}${evidence.severity ? `, ${evidence.severity}` : ""})`)}`);
      console.log(`  risk: ${risk === "high" ? red(risk) : risk === "medium" ? yellow(risk) : green(risk)}   blast radius: ${workflows.length} workflow(s)${workflows.length ? dim(` (${workflows.join(", ")})`) : ""}`);
      console.log(`  files: ${files.length} (${inWorkflow.length} in a workflow)   honestly tested: ${testedCount}/${inWorkflow.length}`);
      if (modeledGain != null) console.log(`  modeled score gain if fixed: ${green(`+${modeledGain}`)}`);
      else console.log(dim(`  ${impact.note}`));
      return;
    }

    if (!opts.propose && !opts.dryRun) {
      console.log("Nothing to do — pass --propose to generate a gate-verified fix proposal (or --dry-run to preview without saving).");
      return;
    }
    if (!targetId) {
      const selected = chooseFixTarget(pending(loadQueue(abs)));
      if (!selected) {
        console.error("fix: no open check or modernize findings to target. Run `mapd check` or `mapd tools modernize` first.");
        process.exitCode = 1;
        return;
      }
      targetId = selected.id;
      console.log(`Auto-selected finding ${targetId}: ${selected.kind}${selected.severity ? ` (${selected.severity})` : ""} — ${selected.detail}`);
    }
    const startedAt = Date.now();
    const r = await runFixLifecycle(abs, targetId, config, { dryRun: opts.dryRun });
    if (!r.ok) {
      console.error(`fix ${targetId}: ${r.reason}`);
      process.exitCode = 1;
      recordAudit(abs, { command: "fix", initiator: "cli", finalStatus: "failed", durationMs: Date.now() - startedAt, reason: r.reason });
      return;
    }
    console.log(`\nfix ${targetId}: ${r.attempts.length} attempt(s), stopped because "${r.stopReason}"`);
    for (const a of r.attempts) {
      const failed = a.gates.filter((g) => !g.passed).map((g) => g.gate);
      console.log(`  attempt ${a.attempt}: ${a.passed ? "PASSED all gates" : `failed (${failed.join(", ")})`}`);
    }
    if (r.dryRun) {
      console.log(`\n--dry-run: proposal not saved. Final status would be "${r.proposalRecord.status}".`);
      return;
    }
    console.log(`\nProposal → ${r.proposalPath} (status: ${r.proposalRecord.status})`);
    recordAudit(abs, {
      command: "fix", initiator: "cli", provider: config.chat?.provider, attempt: r.attempts.length,
      gates: r.attempts.map((a) => a.gates), finalStatus: r.proposalRecord.status,
      durationMs: Date.now() - startedAt,
    });
    if (r.proposalRecord.status !== "awaiting-approval") {
      console.log(`Gate verification did not pass within the attempt budget — nothing was modified. Review the proposal file for details.`);
      return;
    }
    console.log(`Review with \`mapd fix review\`, then \`mapd fix review --approve <id>\` to apply.`);

    if (opts.apply) {
      const item = pending(loadQueue(abs)).find((i) => i.source === "fix" && path.resolve(i.file) === path.resolve(r.proposalPath));
      if (!item) {
        console.error("--apply: could not locate the freshly-saved proposal in the review queue.");
        process.exitCode = 1;
        return;
      }
      const applied = approveFixWithPostApplyVerification(abs, item, config);
      if (applied.ok) {
        const health = applied.postApplyVerification?.health;
        const checks = applied.postApplyVerification?.correctness?.checks ?? [];
        console.log(`APPLIED: ${applied.detail}`);
        console.log(`POST-APPLY verified: confidence ${health.preConfidence} → ${health.postConfidence}, workflows ${health.preWorkflowCount} → ${health.postWorkflowCount}${checks.length ? `, checks ${checks.map((c) => c.script).join(", ")}` : ", no project checks configured"}.`);
      } else {
        console.error(`FAILED to apply safely: ${applied.detail}`);
        for (const issue of applied.postApplyVerification?.issues ?? []) console.error(`  - ${issue}`);
        process.exitCode = 1;
      }
      recordAudit(abs, {
        command: "fix --apply",
        initiator: "cli",
        approvalStatus: applied.ok ? "approved" : "failed",
        finalStatus: applied.ok ? "applied" : "rolled-back",
        changeIds: applied.changeIds ?? [],
        postApplyVerification: applied.postApplyVerification ?? null,
      });
    }
  });

// The change ledger — one group for the three verbs over recorded real-tree
// changes. `changes` (bare) defaults to `changes list` for back-compat.
const CHANGES_DESC = "The change ledger: list applied real-tree changes, roll one back, or inspect audit records";
const changesGroups = [
  program.command("changes", { hidden: true }).description(CHANGES_DESC),
  tools.command("changes").description(CHANGES_DESC),
];
for (const changesCmd of changesGroups) {
  changesCmd
    .command("list", { isDefault: true })
    .argument("[dir]", "project root", ".")
    .option("--json", "print as JSON")
    .description("List recorded real-tree changes (fix applies, integrate applies, review approvals)")
    .action((dir, opts) => {
      const abs = path.resolve(dir);
      const recorded = loadChanges(abs);
      if (opts.json) { console.log(JSON.stringify(recorded, null, 2)); return; }
      if (!recorded.length) { console.log("No recorded changes."); return; }
      for (const c of recorded) {
        console.log(`  ${c.id}  [${c.source}] ${c.file}${c.rolledBack ? " (rolled back)" : ""}  ${c.at}`);
      }
    });

  changesCmd
    .command("rollback")
    .argument("<changeId>", "change ID from `mapd tools changes`")
    .argument("[dir]", "project root", ".")
    .description("Restore a file to its state before a recorded change")
    .action((changeId, dir) => {
      const r = rollbackChange(path.resolve(dir), changeId);
      console.log(r.ok ? r.detail : `FAILED: ${r.detail}`);
      if (!r.ok) process.exitCode = 1;
    });

  changesCmd
    .command("audit")
    .argument("[dir]", "project root", ".")
    .option("--id <id>", "show one audit record by ID (omit to list all)")
    .option("--json", "print as JSON")
    .description("Inspect structured audit records")
    .action((dir, opts) => {
      const abs = path.resolve(dir);
      if (!opts.id) {
        const audits = loadAudits(abs);
        if (opts.json) { console.log(JSON.stringify(audits, null, 2)); return; }
        if (!audits.length) { console.log("No audit records."); return; }
        for (const a of audits) console.log(`  ${a.id}  ${a.timestamp}  ${a.command ?? "?"}  ${a.finalStatus ?? "?"}`);
        return;
      }
      const a = getAudit(abs, opts.id);
      if (!a) { console.error(`No audit record matching ${opts.id}`); process.exitCode = 1; return; }
      console.log(JSON.stringify(a, null, 2));
    });
}

twin(
  [{ cmd: program, cmdOpts: { hidden: true } }, { cmd: tools, cmdOpts: undefined }],
  "mcp",
  (c) => c.description("Start a local MCP server over stdio, exposing Map'd's project understanding and verification tools to compatible agents"),
  async () => {
    await startMcpServer();
  },
);

program
  .command("chat")
  .argument("[dirOrQuery...]", "project root, and/or a one-shot query. A leading real directory is used as the root; anything else is joined into the query. With a query, chat answers once and exits (the natural-language router) instead of starting the REPL.")
  .description("Start an interactive, project-aware chat session (exit with `mapd chat end`, exit, quit, or /end). Pass a query to get one answer and exit instead — same engine, non-interactive.")
  .action(async (args) => {
    let dir = ".";
    let queryTokens = args;
    if (args.length) {
      try {
        if (fs.statSync(path.resolve(args[0])).isDirectory()) { dir = args[0]; queryTokens = args.slice(1); }
      } catch { /* not a real path — treat all tokens as the query */ }
    }
    if (queryTokens.length) {
      const ctx = createChatContext(dir);
      console.log(await handleInput(queryTokens.join(" "), ctx));
      return;
    }
    await startChat(dir);
  });

program
  .command("status", { hidden: true }) // folded into `mapd map`'s default output
  .argument("[dir]", "project root", ".")
  .option("--json", "print as JSON")
  .description("Show repo confidence, baseline status, and open findings")
  .action((dir, opts) => {
    const abs = path.resolve(dir);
    const g = buildScoredGraph(abs);
    const loaded = loadBaseline(abs);
    const { items } = loadQueueWithStates(abs);
    const open = items.filter((i) => i.state === "active" || i.state === "stale");
    const staleCount = open.filter((i) => i.state === "stale").length;
    const summary = {
      root: abs,
      fileCount: g.stats.fileCount,
      workflowCount: g.workflows.length,
      repoConfidence: g.repoConfidence,
      baseline: loaded ? (loaded.schemaMismatch ? "schema-mismatch" : "present") : "none",
      openFindings: open.length,
      staleFindings: staleCount,
      heuristicFileCount: g.stats.heuristicFileCount ?? 0,
    };
    if (opts.json) { console.log(JSON.stringify(summary, null, 2)); return; }
    console.log(`\n${bold("Map'd status")} — ${dim(abs)}`);
    console.log(`  files: ${summary.fileCount}${summary.heuristicFileCount ? dim(` (${summary.heuristicFileCount} heuristic-parsed)`) : ""}  workflows: ${summary.workflowCount}  repo confidence: ${confidenceColor(summary.repoConfidence)(summary.repoConfidence)}`);
    console.log(`  baseline: ${summary.baseline === "present" ? green(summary.baseline) : summary.baseline === "none" ? dim(summary.baseline) : red(summary.baseline)}`);
    console.log(`  open findings: ${summary.openFindings > 0 ? yellow(summary.openFindings) : green(summary.openFindings)}${staleCount ? yellow(`  (${staleCount} from stale report(s) — re-run mapd check/modernize)`) : ""}`);
  });

program
  .command("doctor")
  .argument("[dir]", "project root", ".")
  .option("--json", "print as JSON")
  .description("Inspect runtime, config, provider, cache, baseline, and git/MCP readiness")
  .action((dir, opts) => {
    const abs = path.resolve(dir);
    const { ok, checks } = runDoctor(abs);
    if (opts.json) { console.log(JSON.stringify({ ok, checks }, null, 2)); return; }
    console.log(`\n${bold("Map'd doctor")} — ${dim(abs)}\n`);
    for (const c of checks) {
      const tag = c.ok ? green("[OK]  ") : red("[FAIL]");
      const parts = c.detail.split(", ");
      const detail = c.detail.length > 90 && parts.length > 3 ? wrapList(parts, { width: 90, indent: "        " }) : c.detail;
      console.log(`  ${tag} ${bold(c.name)}: ${detail}`);
    }
    console.log(`\n${ok ? green("All checks passed.") : red("Some checks failed — see above.")}`);
    if (!ok) process.exitCode = 1;
  });

program
  .command("diagnose", { hidden: true }) // reachable via `mapd chat`: "diagnose the understanding limits"
  .argument("[dir]", "project root", ".")
  .option("--top <n>", "number of examples to show per diagnosis section", (v) => Number.parseInt(v, 10), 5)
  .option("--json", "print the structured diagnosis instead of the rendered report")
  .description("Explain Map'd's current understanding limits: weak confidence signals, runtime blind spots, env contract, and next actions")
  .action((dir, opts) => {
    const data = buildDiagnosis(path.resolve(dir), { top: opts.top });
    if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }
    console.log(renderDiagnosis(data));
  });

program
  .command("solutions", { hidden: true }) // reachable via `mapd chat`: "show me solutions"
  .argument("[dir]", "project root", ".")
  .option("--top <n>", "number of highest-priority items to include", (v) => Number.parseInt(v, 10), 5)
  .option("--narrate", "attach an optional LLM-written explanation per solution (requires a configured provider; verified against real data, never surfaced if it can't be)")
  .option("--handoff", "instead of the clustered report, emit the highest-priority findings as a ready-to-paste prompt for Claude Code / Codex")
  .option("--json", "print the structured data instead of the rendered report")
  .description("Cluster related findings into data-backed solutions ranked by real workflow blast radius (add --handoff for a paste-ready agent prompt)")
  .action(async (dir, opts) => {
    const abs = path.resolve(dir);
    if (opts.handoff) {
      const data = buildHandoff(abs, { top: opts.top });
      console.log(opts.json ? JSON.stringify(data, null, 2) : renderHandoffPrompt(data));
      return;
    }
    const config = loadConfig(abs);
    let data = buildSolutions(abs, { top: opts.top });
    if (opts.narrate) data = await narrateSolutions(data, getProvider(config));
    if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }
    console.log(renderSolutions(data));
  });

const score = program.command("score", { hidden: true }) // reachable via `mapd chat`: "explain the score", "what's the ceiling", etc.
  .description("Score Intelligence: explain, simulate, ceiling, and delta over the derived confidence number");

score
  .command("explain")
  .argument("[dir]", "project root", ".")
  .option("--workflow <id>", "restrict the per-workflow breakdown to one workflow")
  .option("--json", "print the structured breakdown as JSON")
  .description("Show exactly what each signal contributes to — and what each weak signal costs — the repo and per-workflow score")
  .action((dir, opts) => {
    const g = buildScoredGraph(path.resolve(dir));
    const data = explainScore(g);
    if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }
    console.log(renderExplain(data, { workflow: opts.workflow }));
  });

score
  .command("ceiling")
  .argument("[dir]", "project root", ".")
  .option("--json", "print the structured ceiling as JSON")
  .description("Report the honest maximum confidence reachable by in-repo work, and the structural caps (no git, heuristic parsing) that hold it below 1.0")
  .action((dir, opts) => {
    const abs = path.resolve(dir);
    const g = buildScoredGraph(abs);
    const data = ceilingScore(abs, g);
    if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }
    console.log(renderCeiling(data));
  });

const csv = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);
score
  .command("simulate")
  .argument("[dir]", "project root", ".")
  .option("--add-tests <files>", "comma-separated workflow files to treat as newly tested", csv, [])
  .option("--fix-parse <files>", "comma-separated AST files to treat as parsed-clean", csv, [])
  .option("--resolve-rate <n>", "hypothetical call-resolution rate (0..1)", (v) => Number.parseFloat(v))
  .option("--cover <n>", "hypothetical repo-coverage fraction (0..1)", (v) => Number.parseFloat(v))
  .option("--json", "print the structured simulation as JSON")
  .description("Ask what confidence would become if you added tests, fixed parses, or resolved calls — re-runs the real scorer, never a fake number")
  .action((dir, opts) => {
    const abs = path.resolve(dir);
    const g = buildScoredGraph(abs);
    const data = simulateScore(abs, g, {
      addTests: opts.addTests, fixParse: opts.fixParse,
      resolutionRate: opts.resolveRate, coverageOfRepo: opts.cover,
    });
    if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }
    console.log(renderSimulate(data));
  });

score
  .command("delta")
  .argument("[dir]", "project root", ".")
  .option("--json", "print the structured delta as JSON")
  .description("Explain why confidence changed since the baseline snapshot — attributed to per-signal contribution moves (no git required)")
  .action((dir, opts) => {
    const abs = path.resolve(dir);
    const loaded = loadBaseline(abs);
    if (!loaded) {
      console.error("No baseline found. Run `mapd check --save-baseline` first.");
      process.exitCode = 1;
      return;
    }
    if (loaded.schemaMismatch) {
      console.error(`Baseline schema v${loaded.schemaMismatch.found} does not match this Map'd (v${loaded.schemaMismatch.expected}). Run \`mapd check --save-baseline\` to re-snapshot.`);
      process.exitCode = 1;
      return;
    }
    const current = buildScoredGraph(abs);
    const data = deltaScore(loaded.graph, current);
    if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }
    console.log(renderDelta(data));
  });

program
  .command("verify")
  .argument("[dir]", "project root", ".")
  .option("--strict", "treat warnings as failures (exit 1)")
  .option("--json", "print the structured verification result as JSON")
  .description("One-shot gate: config + map + doctor + baseline regression + score delta + freshness → a single verdict, CI exit code, and PR-ready summary")
  .action((dir, opts) => {
    const v = runVerify(path.resolve(dir), { strict: opts.strict });
    if (opts.json) { console.log(JSON.stringify(v, null, 2)); }
    else { console.log(renderVerify(v)); }
    process.exitCode = v.exitCode;
  });

twin(
  [{ cmd: program, cmdOpts: { hidden: true } }, { cmd: tools, cmdOpts: undefined }],
  "improve",
  (c) => c
    .argument("[dir]", "project root", ".")
    .option("--budget <time>", "time budget, e.g. 2h, 90m (default: unbounded)")
    .option("--risk <level>", "max risk to include: low | medium | high", "low")
    .option("--agent-pack", "emit a paste-ready task pack for Codex / Claude Code (exact files, risk, expected lift, verify command)")
    .option("--json", "print the structured plan as JSON")
    .description("Ranked, honest work queue: the tasks that lift confidence most per unit effort, each with measured score lift, what NOT to fake, and how to verify (also answerable via `mapd chat`: \"what should I work on\")"),
  (dir, opts) => {
    const plan = planImprovements(path.resolve(dir), { budget: opts.budget, risk: opts.risk });
    if (opts.json) { console.log(JSON.stringify(plan, null, 2)); return; }
    if (opts.agentPack) { console.log(renderAgentPack(plan)); return; }
    console.log(renderImprovePlan(plan));
  },
);

const themeHelpers = { bold, dim, red, green, yellow, cyan };

program
  .command("view", { hidden: true }) // folded into `mapd map --view`
  .argument("[dir]", "project root", ".")
  .option("--static", "write a self-contained HTML file instead of serving (no chat panel)")
  .option("--out <file>", "output HTML path (implies --static)")
  .option("--port <n>", "port for the local server (default: an open port)", (v) => Number.parseInt(v, 10))
  .option("--no-open", "don't open a browser automatically")
  .option("--json", "print the view model as JSON instead of writing/serving")
  .description("Open a browser view of the project (workflow graph, recolorable heatmap, baseline diff) with an embedded chat to help you understand it and decide what to work on. Use --static for a standalone HTML file (no chat).")
  .action(async (dir, opts) => {
    const abs = path.resolve(dir);
    if (opts.json) { console.log(JSON.stringify(buildViewModel(abs), null, 2)); return; }
    // Default: serve the live view WITH the chat panel and open the browser.
    if (!opts.static && !opts.out) {
      const { url, providerAvailable } = await startViewServer(abs, { port: opts.port ?? 0, open: opts.open });
      console.log(`${green("Map'd view")} live at ${cyan(url)}  ${dim("(chat embedded — Ctrl-C to stop)")}`);
      console.log(dim(`  chat: command-style questions ("what should I work on", "show test gaps", "is it passing") answer instantly; ${providerAvailable ? "free-form Q&A uses your LLM and can take a while" : "set ANTHROPIC_API_KEY/OPENAI_API_KEY/KIMI_API_KEY for free-form answers"}.`));
      return; // the server keeps the process alive
    }
    const model = buildViewModel(abs);
    const out = path.resolve(abs, opts.out || "mapd-view.html");
    fs.writeFileSync(out, renderViewHtml(model));
    console.log(`${green("Map'd view")} → ${out}  ${dim(`(static, no chat — ${model.stats.files} files, ${model.stats.workflows} workflows)`)}`);
    if (opts.open) openBrowser(`file://${out}`);
  });

program
  .command("resolution", { hidden: true }) // reachable via `mapd chat`: "what's dragging down the resolution rate"
  .argument("[dir]", "project root", ".")
  .option("--top <n>", "number of hotspots / anonymous-function files to show", (v) => Number.parseInt(v, 10), 10)
  .option("--json", "print the structured resolution analysis as JSON")
  .description("Rank the call sites dragging down resolutionRate by workflow blast radius, list anonymous functions hiding edges, and show which unresolved calls are external (not your problem)")
  .action((dir, opts) => {
    const g = buildScoredGraph(path.resolve(dir));
    const data = analyzeResolution(g, { top: opts.top });
    console.log(opts.json ? JSON.stringify(data, null, 2) : renderResolution(data, themeHelpers));
  });

program
  .command("trace", { hidden: true }) // reachable via `mapd chat`: "trace <file>" / "show the import chain from X to Y"
  .argument("<file>", "file to explain (or the FROM file when a target is given)")
  .argument("[to]", "optional target file — show the import/call chain from <file> to <to>")
  .argument("[dir]", "project root", ".")
  .option("--json", "print the structured trace as JSON")
  .description("Explain why a file is in/out of a workflow, or show the exact import/call chain connecting two files")
  .action((file, to, dir, opts) => {
    // `trace <file> [dir]` vs `trace <from> <to> [dir]` — a target file also has
    // slashes, so only treat `to` as the dir when it's a REAL directory on disk.
    const isRealDir = (v) => { try { return fs.statSync(path.resolve(v)).isDirectory(); } catch { return false; } };
    if (to && dir === "." && isRealDir(to)) { dir = to; to = undefined; }
    const g = buildScoredGraph(path.resolve(dir));
    const from = resolveFile(g, file);
    if (from.notFound) { console.error(`No file matching "${file}". List files with \`mapd map\`.`); process.exitCode = 1; return; }
    if (from.ambiguous) { console.error(`"${file}" is ambiguous — matches: ${from.ambiguous.join(", ")}`); process.exitCode = 1; return; }

    if (to) {
      const target = resolveFile(g, to);
      if (target.notFound) { console.error(`No file matching "${to}".`); process.exitCode = 1; return; }
      if (target.ambiguous) { console.error(`"${to}" is ambiguous — matches: ${target.ambiguous.join(", ")}`); process.exitCode = 1; return; }
      const data = tracePath(g, from.file, target.file);
      console.log(opts.json ? JSON.stringify(data, null, 2) : renderTracePath(data, themeHelpers));
      return;
    }
    const data = traceFile(g, from.file);
    console.log(opts.json ? JSON.stringify(data, null, 2) : renderTraceFile(data, themeHelpers));
  });

// Test Guidance — one group over the shared honest-test-credit analysis.
const TEST_DESC = "Test Guidance: find files lowering testPresence (gaps) and see which test really credits which source (credit)";
const testGroups = [
  program.command("test", { hidden: true }).description(TEST_DESC),
  tools.command("test").description(TEST_DESC),
];
for (const testCmd of testGroups) {
  testCmd
    .command("gaps", { isDefault: true })
    .argument("[dir]", "project root", ".")
    .option("--shallow", "also list shallow tests (import module XOR use export)")
    .option("--json", "print the structured analysis as JSON")
    .description("List workflow files lowering testPresence — untested files and name-only padding — with the literal crediting rule and a suggested test filename")
    .action((dir, opts) => {
      const abs = path.resolve(dir);
      const analysis = analyzeTestCoverage(abs, buildScoredGraph(abs));
      const gaps = testGaps(analysis, { includeShallow: opts.shallow });
      if (opts.json) { console.log(JSON.stringify({ summary: analysis.summary, rule: analysis.rule, gaps }, null, 2)); return; }
      console.log(renderTestGaps(analysis, gaps, themeHelpers));
    });

  testCmd
    .command("credit")
    .argument("[dir]", "project root", ".")
    .option("--padding", "show only padding suspects (credited by the basename rule but with no real import/export link)")
    .option("--json", "print the structured credit map as JSON")
    .description("Show which test file credits which source file, and whether that credit is real (imports the module + uses its exports), shallow, or name-only padding")
    .action((dir, opts) => {
      const abs = path.resolve(dir);
      const analysis = analyzeTestCoverage(abs, buildScoredGraph(abs));
      const rows = testCredit(analysis, { paddingOnly: opts.padding });
      if (opts.json) { console.log(JSON.stringify({ summary: analysis.summary, files: rows }, null, 2)); return; }
      console.log(renderTestCredit(rows, themeHelpers, { paddingOnly: opts.padding }));
    });
}

/**
 * Walks Commander's own registered command tree (including nested subcommands
 * like `config init/show/validate`) and returns `{ command, description }`
 * for each — introspected directly from the real registrations, so this can
 * never drift out of sync with what the CLI actually supports. Hidden
 * commands (legacy aliases kept for backward compat) and their subtrees are
 * skipped, matching Commander's own --help filtering.
 */
function listAllCommands(cmd, prefix = "mapd") {
  return cmd.commands.filter((c) => !c._hidden).flatMap((c) => {
    const name = `${prefix} ${c.name()}`;
    const usage = c.usage();
    const entry = { command: usage ? `${name} ${usage}` : name, description: c.description() || "(no description)" };
    return [entry, ...listAllCommands(c, name)];
  });
}

const commandsAction = (opts) => {
  const entries = listAllCommands(program);
  if (opts.json) { console.log(JSON.stringify(entries, null, 2)); return; }
  console.log(`\n${bold("Map'd commands")}\n`);
  for (const e of entries) {
    console.log(`  ${cyan(bold(e.command))}`);
    console.log(`      ${dim(e.description)}\n`);
  }
};

program
  .command("command", { hidden: true })
  .alias("commands")
  .description("List every mapd command and what it does")
  .option("--json", "print as JSON")
  .action(commandsAction);

tools
  .command("commands")
  .description("List every mapd command and what it does")
  .option("--json", "print as JSON")
  .action(commandsAction);

configCmd
  .command("init")
  .argument("[dir]", "project root", ".")
  .option("--force", "overwrite an existing .mapdrc")
  .description("Write a starter .mapdrc with documented defaults")
  .action((dir, opts) => {
    const r = initConfig(dir, { force: opts.force });
    if (!r.ok) {
      console.error(`config init: ${r.reason} → ${r.path}`);
      process.exitCode = 1;
      return;
    }
    console.log(`.mapdrc written → ${r.path}`);
  });

configCmd
  .command("show")
  .argument("[dir]", "project root", ".")
  .option("--json", "print as JSON")
  .description("Print the fully-resolved configuration (defaults + user + project + env)")
  .action((dir, opts) => {
    const resolved = loadConfig(dir);
    if (opts.json) {
      console.log(JSON.stringify(resolved, null, 2));
      return;
    }
    console.log(`\nResolved Map'd configuration for ${path.resolve(dir)}\n`);
    for (const [section, values] of Object.entries(resolved)) {
      console.log(`  [${section}]`);
      for (const [k, v] of Object.entries(values)) console.log(`    ${k}: ${JSON.stringify(v)}`);
    }
  });

configCmd
  .command("validate")
  .argument("[dir]", "project root", ".")
  .description("Validate the resolved configuration against Map'd's schema")
  .action((dir) => {
    const resolved = loadConfig(dir);
    const { ok, errors } = validateConfig(resolved);
    if (ok) {
      console.log("Configuration is valid.");
      return;
    }
    console.error("Configuration errors:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exitCode = 1;
  });

configCmd
  .command("lint")
  .argument("[dir]", "project root", ".")
  .option("--json", "print the structured lint result as JSON")
  .description("Catch config that lies to you: excluded-but-annotated files, stale/over-broad annotation globs, dead excludes, and unattributed manual assertions — each with a suggested patch (exits 1 on errors)")
  .action((dir, opts) => {
    const result = lintConfig(path.resolve(dir));
    if (opts.json) { console.log(JSON.stringify(result, null, 2)); }
    else { console.log(renderConfigLint(result)); }
    if (!result.ok) process.exitCode = 1;
  });

// Bare `mapd` (no subcommand, no flags) — a guided next-step suggestion
// grounded in real project state, instead of a generic help dump. Anything
// else (including `mapd --help`/`-h`/`--version`) still goes through
// Commander normally.
if (process.argv.length === 2) {
  console.log(renderAssist(buildAssist(process.cwd()), { bold, dim, cyan, confidenceColor }));
} else {
  program.parseAsync();
}
