/**
 * tests/test-file-reach-weighting.test.js — regression test for a real
 * ranking bug found by dogfooding mapd on its own codebase: a duplicate-
 * functions cluster confined entirely to test-fixture files (e.g. 11 test
 * files all defining an identical `tmpProject` helper) outranked a genuine
 * production duplicate with real workflow blast radius, purely because raw
 * file-count inflated its "reach" score. Test files never ship — they
 * should count for less toward operational reach, not be excluded outright
 * (large-scale test-suite disrepair is still worth surfacing, just far less
 * urgently than the same pattern in shipped code).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProject } from "../src/core/parser.js";
import { buildGraph, loadPkg } from "../src/core/graph.js";
import { scoreGraph } from "../src/core/confidence.js";
import { runModernizationScan, saveModernizationReport } from "../src/core/modernize.js";
import { buildSolutions } from "../src/core/solutions.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapd-reachweight-"));
}
function scored(dir) {
  const parsed = parseProject(dir);
  const graph = buildGraph(dir, parsed, loadPkg(dir));
  return scoreGraph(dir, graph);
}

// Duplicate detection (computeShapeHash in parser.js) requires at least
// MIN_SHAPE_HASH_LINES (4) lines in the function body — a one-liner never
// gets a shape hash at all, so every fixture function here needs real bulk.
// Two distinct operator patterns so the src-code and test-fixture clusters
// land in separate shape-hash groups instead of merging into one finding
// (shape hashing normalizes names but keeps operators literal).
const DUP_FN = (name) => `export function ${name}(x) {\n  const y = x + 1;\n  const z = y * 2;\n  return z;\n}\n`;
const DUP_FN_ALT = (name) => `export function ${name}(x) {\n  const y = x - 1;\n  const z = y / 2;\n  return z;\n}\n`;

test("mapd solutions: a duplicate-functions cluster confined to many test files ranks below a smaller real-source duplicate with workflow blast radius", () => {
  // This is the actual bug as observed on mapd's own codebase: it showed up
  // in `mapd solutions`' combined (modernize priority × blast radius)
  // ranking, not necessarily in modernize's raw per-finding priority alone —
  // a tiny synthetic repo doesn't reproduce the file-count proportions of a
  // real one, so this checks the layer where the bug actually manifested.
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "entry.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "entry.js"), `import { helper } from "./helper.js";\nimport "./a.js"; import "./b.js";\nhelper();\n`);
  fs.writeFileSync(path.join(dir, "helper.js"), "export function helper(){ return 1; }\n");
  // a small, real duplicate inside the connected production workflow
  fs.writeFileSync(path.join(dir, "a.js"), DUP_FN("shared"));
  fs.writeFileSync(path.join(dir, "b.js"), DUP_FN("shared"));
  // a much larger duplicate confined entirely to test-fixture files
  fs.mkdirSync(path.join(dir, "tests"));
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(dir, "tests", `t${i}.test.js`), DUP_FN_ALT("tmpProject"));

  const graph = scored(dir);
  saveModernizationReport(dir, runModernizationScan(dir, graph, loadPkg(dir), "heavy"));

  const data = buildSolutions(dir, { top: 10 });
  const testSolution = data.solutions.find((s) => s.files.every((file) => file.startsWith("tests/")));
  const srcSolution = data.solutions.find((s) => s.files.includes("a.js"));

  assert.ok(testSolution, "the test-fixture duplicate cluster must still be reported, not silently dropped");
  assert.ok(srcSolution, "the real production duplicate cluster must be reported");
  assert.ok(
    srcSolution.priority > testSolution.priority,
    `production duplicate (${srcSolution.priority}) must outrank the test-only cluster (${testSolution.priority})`,
  );
});

test("a duplicate confined to test files still gets a nonzero priority — weighted down, never excluded", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "entry.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "entry.js"), "export function hi(){ return 1; }\n");
  fs.mkdirSync(path.join(dir, "tests"));
  fs.writeFileSync(path.join(dir, "tests", "a.test.js"), DUP_FN("dup"));
  fs.writeFileSync(path.join(dir, "tests", "b.test.js"), DUP_FN("dup"));

  const graph = scored(dir);
  const report = runModernizationScan(dir, graph, loadPkg(dir), "heavy");
  const finding = report.findings.find((f) => f.rule === "duplicate-functions");
  assert.ok(finding, "must still be reported");
  assert.ok(finding.operationalImpact.priority > 0, "must not be zeroed out entirely");
});

test("a duplicate entirely in production files is unaffected by the test-weighting change", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "entry.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "entry.js"), `import "./a.js"; import "./b.js";\n`);
  fs.writeFileSync(path.join(dir, "a.js"), DUP_FN("shared"));
  fs.writeFileSync(path.join(dir, "b.js"), DUP_FN("shared"));

  const graph = scored(dir);
  const report = runModernizationScan(dir, graph, loadPkg(dir), "heavy");
  const finding = report.findings.find((f) => f.rule === "duplicate-functions");
  assert.ok(finding);
  // reach = 2 files / 3 total + 2 occurrences / (3*5) = 0.667 + 0.133 = 0.8
  assert.equal(finding.operationalImpact.reach, 0.8);
});
