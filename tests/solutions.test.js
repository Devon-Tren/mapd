/**
 * tests/solutions.test.js — `mapd solutions`: layer 1 (deterministic
 * clustering + blast radius, must be complete with zero provider) and
 * layer 2 (optional LLM narration, must be mechanically verified against
 * layer 1's own data and discarded on any hallucinated file/workflow).
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
import { buildSolutions, narrateSolutions, renderSolutions } from "../src/core/solutions.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapd-solutions-"));
}
function scored(dir) {
  const parsed = parseProject(dir);
  const graph = buildGraph(dir, parsed, loadPkg(dir));
  return scoreGraph(dir, graph);
}

test("buildSolutions: no open findings -> empty solutions, zero provider needed", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "empty", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), "export function hi(){ return 1; }\n");
  const data = buildSolutions(dir, { top: 5 });
  assert.equal(data.solutions.length, 0);
  assert.match(renderSolutions(data), /No open findings/);
});

test("buildSolutions: findings sharing files are clustered into one solution, not listed separately", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "cluster", main: "shared.js", type: "module" }));
  // both var-declarations and promise-then-chains fire on the SAME file -> must cluster
  fs.writeFileSync(path.join(dir, "shared.js"), `
    var a = 1;
    export function run(){ return fetchData().then(x => x).catch(e => e); }
  `);
  const graph = scored(dir);
  saveModernizationReport(dir, runModernizationScan(dir, graph, loadPkg(dir), "medium"));

  const data = buildSolutions(dir, { top: 5 });
  assert.equal(data.solutions.length, 1, "both findings touch shared.js — they must merge into one cluster");
  const kinds = data.solutions[0].kinds.sort();
  assert.deepEqual(kinds, ["promise-then-chains", "var-declarations"]);
  assert.equal(data.solutions[0].members.length, 2);
});

test("buildSolutions: findings touching disjoint files stay in separate solutions", () => {
  const dir = tmpProject();
  // both a.js and b.js registered as their own entry points, so medium mode's
  // "top 3 workflows" scoping covers both (an orphan file would otherwise be
  // out of scope in medium mode and never even generate a finding to test against)
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "disjoint", bin: { a: "./a.js", b: "./b.js" }, type: "module" }));
  fs.writeFileSync(path.join(dir, "a.js"), `var a = 1;\nexport function ra(){ return a; }\n`);
  fs.writeFileSync(path.join(dir, "b.js"), `export function rb(){ return fetchData().then(x=>x).catch(e=>e); }\n`);
  const graph = scored(dir);
  saveModernizationReport(dir, runModernizationScan(dir, graph, loadPkg(dir), "medium"));

  const data = buildSolutions(dir, { top: 5 });
  assert.equal(data.solutions.length, 2, "unrelated findings on different files must not be merged");
});

test("buildSolutions: architecture/dependency findings never bridge unrelated clusters via incidental file overlap", () => {
  const dir = tmpProject();
  // 12+ files so monolithic-workflow / orphan-cluster (architecture tier) can fire and list many files
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "arch", main: "entry.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "entry.js"), `var localVar = 1;\nexport function run(){ return localVar; }\n`);
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(dir, `orphan${i}.js`), `export function f${i}(){ return ${i}; }\n`);
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(dir, `pad${i}.js`), `export function p${i}(){ return ${i}; }\n`);

  const graph = scored(dir);
  saveModernizationReport(dir, runModernizationScan(dir, graph, loadPkg(dir), "heavy"));

  const data = buildSolutions(dir, { top: 20 });
  const varSolution = data.solutions.find((s) => s.kinds.includes("var-declarations"));
  const orphanSolution = data.solutions.find((s) => s.kinds.includes("orphan-cluster"));
  assert.ok(varSolution && orphanSolution, "both findings must be present");
  assert.notEqual(varSolution.clusterId, orphanSolution.clusterId, "architecture-tier orphan-cluster must never merge into the unrelated var-declarations cluster");
});

test("buildSolutions: blast radius reflects real workflow membership and import in-degree, never invented", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "blast", main: "entry.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "entry.js"), `import { helper } from "./helper.js";\nvar x = 1;\nhelper();\n`);
  fs.writeFileSync(path.join(dir, "helper.js"), "export function helper(){ return 1; }\n");
  const graph = scored(dir);
  saveModernizationReport(dir, runModernizationScan(dir, graph, loadPkg(dir), "medium"));

  const data = buildSolutions(dir, { top: 5 });
  const solution = data.solutions.find((s) => s.kinds.includes("var-declarations"));
  assert.ok(solution);
  for (const wfId of solution.blastRadius.workflowsTouched) {
    assert.ok(graph.workflows.some((w) => w.id === wfId), "every cited workflow ID must be a real workflow");
  }
});

test("buildSolutions: a real check (regression) finding participates in clustering and priority ranking", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "checkproj", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), `export function greet(){ return 1; }\nexport function farewell(){ return 2; }\n`);
  saveBaseline(dir, scored(dir));
  fs.writeFileSync(path.join(dir, "index.js"), `export function greet(){ return 1; }\n`);
  const loaded = loadBaseline(dir);
  saveFindings(dir, diffGraphs(loaded.graph, scored(dir)));

  const data = buildSolutions(dir, { top: 5 });
  const exportSolution = data.solutions.find((s) => s.kinds.includes("export-removed"));
  assert.ok(exportSolution, "a real regression finding must surface as a solution");
  assert.equal(exportSolution.members[0].severity, "high");
});

// ---- Layer 2: narration, verified against layer 1's own data ----

function fakeProvider(response) {
  return { available: () => true, complete: async () => response };
}

async function oneSolutionDataset(dir) {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "narrate", main: "shared.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "shared.js"), `var a = 1;\nexport function run(){ return a; }\n`);
  const graph = scored(dir);
  saveModernizationReport(dir, runModernizationScan(dir, graph, loadPkg(dir), "medium"));
  return buildSolutions(dir, { top: 5 });
}

test("narrateSolutions: no provider -> data returned unchanged", async () => {
  const dir = tmpProject();
  const data = await oneSolutionDataset(dir);
  const result = await narrateSolutions(data, { available: () => false });
  assert.deepEqual(result, data);
});

test("narrateSolutions: a valid, grounded narrative is attached", async () => {
  const dir = tmpProject();
  const data = await oneSolutionDataset(dir);
  const provider = fakeProvider(JSON.stringify([{ whyItMatters: "This touches shared.js, a file only one other module depends on." }]));
  const result = await narrateSolutions(data, provider);
  assert.equal(result.solutions[0].narrative, "This touches shared.js, a file only one other module depends on.");
});

test("narrateSolutions: a narrative citing a file NOT in the cluster is rejected, not surfaced", async () => {
  const dir = tmpProject();
  const data = await oneSolutionDataset(dir);
  const provider = fakeProvider(JSON.stringify([{ whyItMatters: "This also affects totally-fabricated-file.js which is critical." }]));
  const result = await narrateSolutions(data, provider);
  assert.equal(result.solutions[0].narrative, null);
  assert.match(result.solutions[0].narrativeSkippedReason, /totally-fabricated-file\.js/);
});

test("narrateSolutions: a narrative citing a workflow ID NOT in this cluster's blast radius is rejected", async () => {
  const dir = tmpProject();
  const data = await oneSolutionDataset(dir);
  const provider = fakeProvider(JSON.stringify([{ whyItMatters: "This impacts wf:main:nonexistent-entry.js directly." }]));
  const result = await narrateSolutions(data, provider);
  assert.equal(result.solutions[0].narrative, null);
  assert.match(result.solutions[0].narrativeSkippedReason, /wf:main:nonexistent-entry\.js/);
});

test("narrateSolutions: malformed JSON response fails safe to unmodified layer-1 data", async () => {
  const dir = tmpProject();
  const data = await oneSolutionDataset(dir);
  const provider = fakeProvider("not json");
  const result = await narrateSolutions(data, provider);
  assert.equal(result.solutions[0].narrative, null);
  assert.equal(result.solutions[0].narrativeSkippedReason, undefined);
});

test("narrateSolutions: a response array of the wrong length fails safe to unmodified layer-1 data", async () => {
  const dir = tmpProject();
  const data = await oneSolutionDataset(dir);
  const provider = fakeProvider(JSON.stringify([{ whyItMatters: "a" }, { whyItMatters: "b" }])); // 2 vs 1 solution
  const result = await narrateSolutions(data, provider);
  assert.deepEqual(result, data);
});

test("narrateSolutions: the model choosing an empty string for low confidence is respected, not forced", async () => {
  const dir = tmpProject();
  const data = await oneSolutionDataset(dir);
  const provider = fakeProvider(JSON.stringify([{ whyItMatters: "" }]));
  const result = await narrateSolutions(data, provider);
  assert.equal(result.solutions[0].narrative, null);
});

test("renderSolutions: includes narrative when present, and the skip reason when rejected", async () => {
  const dir = tmpProject();
  const data = await oneSolutionDataset(dir);
  const good = await narrateSolutions(data, fakeProvider(JSON.stringify([{ whyItMatters: "Grounded reason." }])));
  assert.match(renderSolutions(good), /Why it matters: Grounded reason\./);

  const rejected = await narrateSolutions(data, fakeProvider(JSON.stringify([{ whyItMatters: "cites bogus-file.js" }])));
  assert.match(renderSolutions(rejected), /narrative skipped/);
});

test("buildSolutions/renderSolutions: findings from a stale report are EXCLUDED from solutions, and the empty case says why", async () => {
  const dir = tmpProject();
  const data0 = await oneSolutionDataset(dir);
  assert.equal(data0.freshness.stale, false, "sanity check: freshly-generated report must not start out stale");
  assert.ok(data0.solutions.length >= 1, "sanity check: the fresh report must actually produce a solution");

  const reportPath = path.join(dir, ".mapd", "modernize-medium.json");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  report.generatedAt = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(reportPath, JSON.stringify(report));
  fs.writeFileSync(path.join(dir, "shared.js"), `var a = 1;\nvar b = 2;\nexport function run(){ return a + b; }\n`);

  const data = buildSolutions(dir, { top: 5 });
  assert.equal(data.freshness.stale, true);
  assert.equal(data.solutions.length, 0, "every finding came from the stale report — none may appear as a solution");
  assert.ok(data.excludedStaleCount >= 1, "the exclusion must be counted, not silent");
  const rendered = renderSolutions(data);
  assert.match(rendered, /stale report/i);
  assert.match(rendered, /modernize-medium\.json/);
  assert.doesNotMatch(rendered, /No open findings/, "'no open findings' would be misleading — the findings exist, they're just stale");
});
