/**
 * tests/cjs-extension-honesty.test.js — regression test for a real false
 * positive: `cjs-in-esm-project` used to flag ANY file using require()/
 * module.exports inside a "type":"module" package, including .cjs files.
 * But Node treats .cjs as CommonJS unconditionally regardless of
 * package.json's "type" — there is no real format ambiguity or interop
 * risk there, unlike a bare .js/.mjs file using CJS syntax, which Node
 * genuinely has to guess about. Only the genuinely ambiguous case should fire.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProject } from "../src/core/parser.js";
import { buildGraph, loadPkg } from "../src/core/graph.js";
import { scoreGraph } from "../src/core/confidence.js";
import { runModernizationScan } from "../src/core/modernize.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapd-cjsext-"));
}
function scored(dir) {
  const parsed = parseProject(dir);
  const graph = buildGraph(dir, parsed, loadPkg(dir));
  return scoreGraph(dir, graph);
}

test(".cjs files inside a \"type\":\"module\" package are never flagged as cjs-in-esm-project", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), "export const x = 1;\n");
  fs.mkdirSync(path.join(dir, "electron"), { recursive: true });
  fs.writeFileSync(path.join(dir, "electron", "main.cjs"), `const fs = require("fs");\nmodule.exports = { run(){ return fs; } };\n`);

  const graph = scored(dir);
  const report = runModernizationScan(dir, graph, loadPkg(dir), "medium");
  const finding = report.findings.find((f) => f.rule === "cjs-in-esm-project");
  assert.equal(finding, undefined, ".cjs is Node's explicit CommonJS opt-out — must not be flagged");
});

test("a bare .js file using require()/module.exports inside a \"type\":\"module\" package IS still flagged (the genuinely ambiguous case)", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), "export const x = 1;\n");
  fs.writeFileSync(path.join(dir, "legacy.js"), `const fs = require("fs");\nmodule.exports = { run(){ return fs; } };\n`);

  const graph = scored(dir);
  // heavy mode includes orphans in the pattern-scan scope; legacy.js isn't
  // imported by index.js so medium mode wouldn't even scan it
  const report = runModernizationScan(dir, graph, loadPkg(dir), "heavy");
  const finding = report.findings.find((f) => f.rule === "cjs-in-esm-project");
  assert.ok(finding, "a bare .js file using CJS syntax inside an ESM package is genuinely ambiguous and must still be flagged");
  assert.match(finding.detail, /not \.cjs/);
});
