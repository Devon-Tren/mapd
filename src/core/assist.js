/**
 * assist.js — bare `mapd` (no subcommand) guidance. Inspects real project
 * state (config presence, baseline presence, open findings) and returns the
 * one or two commands that actually move things forward next — never a
 * generic help dump. Every claim here is read from the same deterministic
 * sources the rest of Map'd uses (buildScoredGraph, loadBaseline, the review
 * queue) — nothing here is guessed or narrated by an LLM.
 */

import fs from "node:fs";
import path from "node:path";
import { buildScoredGraph } from "./intelligence.js";
import { loadBaseline } from "./regression.js";
import { loadQueueWithStates, pending } from "./review.js";

export function buildAssist(abs) {
  const hasConfig = fs.existsSync(path.join(abs, ".mapdrc"));
  const g = buildScoredGraph(abs);
  const baseline = loadBaseline(abs);
  const { items } = loadQueueWithStates(abs);
  const open = pending(items);
  const highSeverity = open.filter((i) => i.severity === "high");

  const steps = [];
  if (!hasConfig) {
    steps.push({ cmd: "mapd config init", why: "No .mapdrc yet — write starter config with documented defaults." });
  }
  if (!baseline) {
    steps.push({ cmd: "mapd check --save-baseline", why: "No regression baseline yet — snapshot the current map so future changes can be diffed." });
  } else if (baseline.schemaMismatch) {
    steps.push({ cmd: "mapd check --save-baseline", why: `Baseline schema v${baseline.schemaMismatch.found} predates this Map'd (v${baseline.schemaMismatch.expected}) — re-snapshot.` });
  }
  if (highSeverity.length) {
    steps.push({ cmd: "mapd fix", why: `${highSeverity.length} high-severity finding(s) open — auto-selects and proposes a gate-verified fix for the strongest one.` });
  } else if (open.length) {
    steps.push({ cmd: "mapd fix review", why: `${open.length} item(s) awaiting approval.` });
  }
  if (baseline && !baseline.schemaMismatch) {
    steps.push({ cmd: "mapd check", why: "Re-check for regressions against the saved baseline." });
  }
  steps.push({ cmd: "mapd chat", why: "Ask questions, get a ranked \"what should I work on\" plan, or explore the score breakdown." });

  return {
    root: abs,
    summary: { fileCount: g.stats.fileCount, workflowCount: g.workflows.length, repoConfidence: g.repoConfidence },
    openFindings: open.length,
    steps: steps.slice(0, 4),
  };
}

export function renderAssist(data, { bold, dim, cyan, confidenceColor }) {
  const lines = [];
  lines.push(`${bold("Map'd")} — ${dim(data.root)}`);
  lines.push(`  files: ${data.summary.fileCount}  workflows: ${data.summary.workflowCount}  repo confidence: ${confidenceColor(data.summary.repoConfidence)(data.summary.repoConfidence)}  open findings: ${data.openFindings}`);
  lines.push("");
  lines.push(bold("What to run next:"));
  for (const s of data.steps) {
    lines.push(`  ${cyan(s.cmd)}`);
    lines.push(`      ${dim(s.why)}`);
  }
  lines.push("");
  lines.push(dim("mapd --help lists every command; mapd chat answers plain-English questions about this project."));
  return lines.join("\n");
}
