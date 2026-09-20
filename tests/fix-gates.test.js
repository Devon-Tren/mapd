/**
 * tests/fix-gates.test.js — the general fix-pipeline gates (FIX-G1..FIX-G3),
 * distinct from integrate.js's merge-specific G1-G3 (covered in gates.test.js).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createIsolatedWorkspace, applyPatchInWorkspace } from "../src/core/workspace.js";
import { runPatchSafetyGate, runProjectCorrectnessGate, runRegressionGate, runFixGates } from "../src/core/gates.js";
import { buildScoredGraph } from "../src/core/intelligence.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-fixgate-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), `export function greet(n){ return "hi " + n; }\n`);
  return dir;
}

test("runPatchSafetyGate: passes for a clean, in-scope, parseable patch", () => {
  const dir = fixture();
  const ws = createIsolatedWorkspace(dir);
  try {
    const patch = { "index.js": `export function greet(n){ return "hello " + n; }\n` };
    applyPatchInWorkspace(ws, "index.js", patch["index.js"]);
    const g = runPatchSafetyGate({ ws, patch });
    assert.equal(g.passed, true, JSON.stringify(g.issues));
  } finally { ws.cleanup(); }
});

test("runPatchSafetyGate: fails when the patch touches a protected path", () => {
  const dir = fixture();
  const ws = createIsolatedWorkspace(dir);
  try {
    const patch = { ".env": "SECRET=1" };
    const g = runPatchSafetyGate({ ws, patch });
    assert.equal(g.passed, false);
    assert.ok(g.issues.some((i) => i.includes("protected path")));
  } finally { ws.cleanup(); }
});

test("runPatchSafetyGate: fails when unexpected files changed beyond the declared patch", () => {
  const dir = fixture();
  const ws = createIsolatedWorkspace(dir);
  try {
    const patch = { "index.js": `export function greet(n){ return "hello " + n; }\n` };
    applyPatchInWorkspace(ws, "index.js", patch["index.js"]);
    applyPatchInWorkspace(ws, "sneaky.js", "export const x = 1;\n"); // not declared in patch
    const g = runPatchSafetyGate({ ws, patch });
    assert.equal(g.passed, false);
    assert.ok(g.issues.some((i) => i.includes("unexpected files changed")));
  } finally { ws.cleanup(); }
});

test("runPatchSafetyGate: fails on unparseable proposed source", () => {
  const dir = fixture();
  const ws = createIsolatedWorkspace(dir);
  try {
    const patch = { "index.js": "function ( {{{ broken" };
    applyPatchInWorkspace(ws, "index.js", patch["index.js"]);
    const g = runPatchSafetyGate({ ws, patch });
    assert.equal(g.passed, false);
  } finally { ws.cleanup(); }
});

test("runProjectCorrectnessGate: skipped (not fabricated) when no scripts are defined", () => {
  const dir = fixture();
  const g = runProjectCorrectnessGate({ cwd: dir, pkg: { scripts: {} } });
  assert.equal(g.passed, true);
  assert.equal(g.skipped, true);
});

test("runProjectCorrectnessGate: runs and reports a failing test script honestly", () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, "index.test.js"), `import assert from "node:assert"; assert.strict.equal(1, 2);\n`);
  const pkg = { name: "t", type: "module", scripts: { test: "node index.test.js" } };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg)); // npm re-reads package.json from disk
  const g = runProjectCorrectnessGate({ cwd: dir, pkg, runLint: false, runTypecheck: false });
  assert.equal(g.passed, false);
  assert.equal(g.checks[0].script, "npm test");
  assert.equal(g.checks[0].passed, false);
});

test("runProjectCorrectnessGate: runs and reports a passing test script honestly", () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, "index.test.js"), `import assert from "node:assert"; assert.strict.equal(1, 1);\n`);
  const pkg = { name: "t", type: "module", scripts: { test: "node index.test.js" } };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg)); // npm re-reads package.json from disk
  const g = runProjectCorrectnessGate({ cwd: dir, pkg, runLint: false, runTypecheck: false });
  assert.equal(g.passed, true, JSON.stringify(g.checks));
});

test("runRegressionGate: passes with zero delta when the workspace is an untouched copy", () => {
  const dir = fixture();
  const preFixGraph = buildScoredGraph(dir);
  const ws = createIsolatedWorkspace(dir);
  try {
    const g = runRegressionGate({ ws, preFixGraph, baseline: null });
    assert.equal(g.passed, true);
    assert.equal(g.deltaConfidence, 0);
    assert.deepEqual(g.newOrphans, []);
  } finally { ws.cleanup(); }
});

test("runFixGates: short-circuits regression/correctness checks when patch safety fails", () => {
  const dir = fixture();
  const preFixGraph = buildScoredGraph(dir);
  const ws = createIsolatedWorkspace(dir);
  try {
    const patch = { ".env": "SECRET=1" };
    const gates = runFixGates({ ws, patch, pkg: { scripts: {} }, preFixGraph });
    assert.equal(gates.length, 1);
    assert.equal(gates[0].passed, false);
  } finally { ws.cleanup(); }
});
