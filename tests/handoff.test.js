/**
 * tests/handoff.test.js — `mapd handoff`: packages the highest-priority open
 * findings into a structured, then rendered, prompt for an external coding
 * agent. Everything in the output must trace back to real findings/graph
 * data — no invented task text, grouping, or file lists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProject } from "../src/core/parser.js";
import { buildGraph, loadPkg } from "../src/core/graph.js";
import { scoreGraph } from "../src/core/confidence.js";
import { saveBaseline, diffGraphs, loadBaseline, saveFindings } from "../src/core/regression.js";
import { runModernizationScan, saveModernizationReport } from "../src/core/modernize.js";
import { buildHandoff, renderHandoffPrompt, collectTopFindings } from "../src/core/handoff.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapd-handoff-"));
}

function scored(dir) {
  const parsed = parseProject(dir);
  const graph = buildGraph(dir, parsed, loadPkg(dir));
  return scoreGraph(dir, graph);
}

test("buildHandoff: no open findings -> empty task list, prompt says so plainly", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "empty", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), "export function hi(){ return 1; }\n");

  const data = buildHandoff(dir, { top: 5 });
  assert.equal(data.tasks.length, 0);
  const prompt = renderHandoffPrompt(data);
  assert.match(prompt, /No open findings/);
});

test("buildHandoff: a real modernize finding becomes a task with real files/detail, ranked by priority", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "modproj", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), `var x = 1;\nexport function hi(){ return x; }\n`);

  const graph = scored(dir);
  const report = runModernizationScan(dir, graph, loadPkg(dir), "medium");
  saveModernizationReport(dir, report);

  const data = buildHandoff(dir, { top: 5 });
  assert.ok(data.tasks.length >= 1, "the var-declarations finding must surface as a task");
  const varTask = data.tasks.find((t) => t.kind === "var-declarations");
  assert.ok(varTask, "task kind must match the real rule name, not an invented label");
  assert.ok(varTask.files.includes("index.js"), "task must cite the real file, not a fabricated one");
  assert.match(varTask.detail, /var.*declaration/);
});

test("buildHandoff: a real check (regression) finding becomes a severity-ranked task", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "checkproj", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), `export function greet(){ return 1; }\nexport function farewell(){ return 2; }\n`);
  saveBaseline(dir, scored(dir));

  fs.writeFileSync(path.join(dir, "index.js"), `export function greet(){ return 1; }\n`); // drops farewell
  const loaded = loadBaseline(dir);
  const findings = diffGraphs(loaded.graph, scored(dir));
  saveFindings(dir, findings);

  const data = buildHandoff(dir, { top: 5 });
  const exportTask = data.tasks.find((t) => t.kind === "export-removed");
  assert.ok(exportTask, "a real export-removed regression must surface as a task");
  assert.equal(exportTask.severity, "high");
  assert.match(exportTask.detail, /farewell/);
});

test("buildHandoff: tasks are capped at --top and ranked highest priority/severity first", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "manyproj", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), `
    var a = 1; var b = 2; var c = 3;
    export function hi(){
      return fetchData().then(function(x){ return x; }).catch(function(e){ return e; });
    }
  `);
  const graph = scored(dir);
  const report = runModernizationScan(dir, graph, loadPkg(dir), "medium");
  saveModernizationReport(dir, report);

  const data = buildHandoff(dir, { top: 1 });
  assert.equal(data.tasks.length, 1);
  const { findings: top } = collectTopFindings(dir, { top: 10 });
  assert.ok(top.length >= 2, "fixture must actually produce more than one candidate finding");
  assert.ok(top[0].priority >= top[1].priority, "results must be sorted highest priority first");
});

test("buildHandoff: fix-sourced and integrate-sourced queue items are excluded (findings only, not proposals)", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixproj", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), "export function hi(){ return 1; }\n");
  fs.mkdirSync(path.join(dir, ".mapd", "proposals"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".mapd", "proposals", "abc123.json"), JSON.stringify({
    findingId: "abc123", findingKind: "var-declarations", filesPatch: { "index.js": "export function hi(){return 1;}" },
    status: "awaiting-approval",
  }));

  const data = buildHandoff(dir, { top: 5 });
  assert.equal(data.tasks.length, 0, "a fix proposal is not a finding to hand off — it's already an agent-generated patch");
});

test("renderHandoffPrompt: includes newly-added workflows as a regression guard when a baseline exists", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "wfproj", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), "export function hi(){ return 1; }\n");
  saveBaseline(dir, scored(dir));

  fs.writeFileSync(path.join(dir, "second.js"), "export function bye(){ return 2; }\n");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "wfproj", main: "index.js", bin: { second: "./second.js" }, type: "module" }));

  const data = buildHandoff(dir, { top: 5 });
  assert.ok(data.newWorkflows.length >= 1, "a genuinely new workflow since baseline must be listed");
  const prompt = renderHandoffPrompt(data);
  assert.match(prompt, /REGRESSION GUARD/);
  assert.match(prompt, /second\.js/);
});

test("renderHandoffPrompt: cites real finding IDs and an explicit re-verify step per task, never a batched commit", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "verifyproj", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), `var x = 1;\nexport function hi(){ return x; }\n`);
  const graph = scored(dir);
  const report = runModernizationScan(dir, graph, loadPkg(dir), "medium");
  saveModernizationReport(dir, report);

  const data = buildHandoff(dir, { top: 5 });
  const prompt = renderHandoffPrompt(data);
  assert.match(prompt, new RegExp(data.tasks[0].id));
  assert.match(prompt, /run `mapd check` and re-verify/);
  assert.match(prompt, /One commit per task\. Do not batch\./);
});

test("buildHandoff: findings from a stale report are EXCLUDED from the task list, not just flagged with a banner", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "staleproj", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), `var x = 1;\nexport function hi(){ return x; }\n`);
  const graph = scored(dir);
  saveModernizationReport(dir, runModernizationScan(dir, graph, loadPkg(dir), "medium"));
  // backdate the report, then touch a source file after it — simulates the
  // report predating an external fix (e.g. Claude Code/Codex editing the tree)
  const reportPath = path.join(dir, ".mapd", "modernize-medium.json");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  report.generatedAt = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(reportPath, JSON.stringify(report));
  fs.writeFileSync(path.join(dir, "index.js"), `var x = 1;\nvar y = 2;\nexport function hi(){ return x + y; }\n`);

  const data = buildHandoff(dir, { top: 5 });
  assert.equal(data.freshness.stale, true);
  assert.equal(data.tasks.length, 0, "every finding came from the stale report — none may appear as a task");
  assert.ok(data.excludedStaleCount >= 1, "the exclusion must be counted, not silent");
  const prompt = renderHandoffPrompt(data);
  assert.match(prompt, /STALE REPORTS EXCLUDED/);
  assert.match(prompt, /modernize-medium\.json/);
  assert.match(prompt, /nothing current to hand off/);
});

test("buildHandoff: a fresh report's findings still flow through normally alongside a stale one's exclusion", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "mixedproj", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), `var x = 1;\nexport function hi(){ return x; }\n`);
  fs.utimesSync(path.join(dir, "index.js"), new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));
  const graph = scored(dir);
  // stale heavy report (predates the source mtime) + fresh medium report
  const heavy = runModernizationScan(dir, graph, loadPkg(dir), "heavy");
  heavy.generatedAt = new Date(Date.now() - 60_000).toISOString();
  saveModernizationReport(dir, heavy);
  saveModernizationReport(dir, runModernizationScan(dir, graph, loadPkg(dir), "medium")); // generatedAt = now, fresh

  const data = buildHandoff(dir, { top: 10 });
  assert.deepEqual(data.freshness.staleReports, ["modernize-heavy.json"]);
  assert.ok(data.tasks.length >= 1, "the fresh medium report's findings must still produce tasks");
  assert.ok(data.tasks.every((t) => t.source === "modernize-medium"), "no task may originate from the stale heavy report");
  assert.ok(data.excludedStaleCount >= 1);
});
