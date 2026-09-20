/**
 * tests/circular-dependencies.test.js — circular import detection: a
 * deterministic Tarjan SCC computation over the resolved import graph, wired
 * into `mapd modernize --mode heavy` as an architecture-tier finding.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectCircularDependencies, buildGraph, loadPkg } from "../src/core/graph.js";
import { parseProject } from "../src/core/parser.js";
import { scoreGraph } from "../src/core/confidence.js";
import { runModernizationScan } from "../src/core/modernize.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapd-cycle-"));
}

function buildProjectGraph(dir) {
  const parsed = parseProject(dir);
  return scoreGraph(dir, buildGraph(dir, parsed, loadPkg(dir)));
}

test("detectCircularDependencies: finds nothing in an acyclic project", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "a.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "a.js"), `import { b } from "./b.js"; export function a(){ return b(); }\n`);
  fs.writeFileSync(path.join(dir, "b.js"), `export function b(){ return 1; }\n`);
  const graph = buildProjectGraph(dir);
  assert.deepEqual(detectCircularDependencies(graph), []);
});

test("detectCircularDependencies: finds a real two-file cycle (a imports b, b imports a)", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "a.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "a.js"), `import { b } from "./b.js"; export function a(){ return b(); }\n`);
  fs.writeFileSync(path.join(dir, "b.js"), `import { a } from "./a.js"; export function b(){ return a; }\n`);
  const graph = buildProjectGraph(dir);
  const cycles = detectCircularDependencies(graph);
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].sort(), ["a.js", "b.js"]);
});

test("detectCircularDependencies: finds a longer three-file cycle (a -> b -> c -> a)", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "a.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "a.js"), `import { b } from "./b.js"; export function a(){ return b(); }\n`);
  fs.writeFileSync(path.join(dir, "b.js"), `import { c } from "./c.js"; export function b(){ return c(); }\n`);
  fs.writeFileSync(path.join(dir, "c.js"), `import { a } from "./a.js"; export function c(){ return a; }\n`);
  const graph = buildProjectGraph(dir);
  const cycles = detectCircularDependencies(graph);
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].sort(), ["a.js", "b.js", "c.js"]);
});

test("detectCircularDependencies: two independent cycles are both reported, and unrelated acyclic files are excluded", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "entry.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "entry.js"), `import "./a.js"; import "./x.js"; import "./standalone.js";\n`);
  fs.writeFileSync(path.join(dir, "a.js"), `import { b } from "./b.js"; export function a(){ return b(); }\n`);
  fs.writeFileSync(path.join(dir, "b.js"), `import { a } from "./a.js"; export function b(){ return a; }\n`);
  fs.writeFileSync(path.join(dir, "x.js"), `import { y } from "./y.js"; export function x(){ return y(); }\n`);
  fs.writeFileSync(path.join(dir, "y.js"), `import { x } from "./x.js"; export function y(){ return x; }\n`);
  fs.writeFileSync(path.join(dir, "standalone.js"), `export function standalone(){ return 1; }\n`);
  const graph = buildProjectGraph(dir);
  const cycles = detectCircularDependencies(graph);
  assert.equal(cycles.length, 2);
  const allCycleFiles = cycles.flat();
  assert.ok(!allCycleFiles.includes("standalone.js"), "an acyclic file must never appear in a reported cycle");
});

test("detectCircularDependencies: a file that imports itself is reported as a self-cycle", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "a.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "a.js"), `import { helper } from "./a.js"; export function a(){ return helper(); }\n`);
  const graph = buildProjectGraph(dir);
  const cycles = detectCircularDependencies(graph);
  assert.deepEqual(cycles, [["a.js"]]);
});

test("mapd modernize --mode heavy: reports circular-dependency findings with derived impact scoring, never on light/medium", () => {
  const dir = tmpProject();
  const pkg = { name: "t", main: "a.js", type: "module" };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  fs.writeFileSync(path.join(dir, "a.js"), `import { b } from "./b.js"; export function a(){ return b(); }\n`);
  fs.writeFileSync(path.join(dir, "b.js"), `import { a } from "./a.js"; export function b(){ return a; }\n`);
  const graph = buildProjectGraph(dir);

  const heavy = runModernizationScan(dir, graph, pkg, "heavy");
  const cycleFinding = heavy.findings.find((f) => f.rule === "circular-dependency");
  assert.ok(cycleFinding, "heavy mode must surface the circular dependency");
  assert.equal(cycleFinding.certainty, 1.0, "an actual graph cycle is a fact, not an estimate");
  assert.ok(cycleFinding.operationalImpact, "must carry the same derived impact scoring as every other finding");
  assert.match(cycleFinding.detail, /a\.js/);
  assert.match(cycleFinding.detail, /b\.js/);

  const medium = runModernizationScan(dir, graph, pkg, "medium");
  assert.ok(!medium.findings.some((f) => f.rule === "circular-dependency"), "architecture tier (and thus circular-dependency) is heavy-only");
});
