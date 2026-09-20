/**
 * tests/generated-file-exclusion.test.js — regression test for a real false
 * positive found via dogfooding: a 272-line `var-declarations` finding
 * pointed entirely at `electron/plan-mode-bundle.cjs`, an esbuild-generated
 * bundle with no header comment and a hyphenated filename that the original
 * (dot-only) naming convention didn't match. Editing that file would have
 * been pointless — it's overwritten on the next `npm run bundle`. The real
 * fix target is the hand-written source the bundler reads from, which must
 * still be scanned normally.
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapd-genexclude-"));
}
function scored(dir) {
  const parsed = parseProject(dir);
  const graph = buildGraph(dir, parsed, loadPkg(dir));
  return scoreGraph(dir, graph);
}

test("a real esbuild-style bundle (hyphenated name, no header, declared via package.json --outfile) is excluded from var-declarations scanning", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "t", main: "electron/main.cjs", type: "module",
    scripts: { bundle: "npx esbuild src/engine/orchestrator.ts --bundle --outfile=electron/plan-mode-bundle.cjs" },
  }));
  fs.mkdirSync(path.join(dir, "electron"), { recursive: true });
  fs.writeFileSync(path.join(dir, "electron", "main.cjs"), `
    const path = require("path");
    require("./plan-mode-bundle.cjs");
  `);
  // real esbuild output shape: no header comment, var-heavy, hyphenated filename
  const bundleLines = ["var __create = Object.create;"];
  for (let i = 0; i < 20; i++) bundleLines.push(`var _tmp${i} = ${i};`);
  fs.writeFileSync(path.join(dir, "electron", "plan-mode-bundle.cjs"), bundleLines.join("\n") + "\n");

  const graph = scored(dir);
  const report = runModernizationScan(dir, graph, loadPkg(dir), "heavy");
  const varFinding = report.findings.find((f) => f.rule === "var-declarations");
  assert.equal(varFinding, undefined, "the generated bundle's var declarations must never surface as a finding");
});

test("meanwhile, the authored source the bundler reads from is still scanned normally", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "t", main: "index.js", type: "module",
    scripts: { bundle: "esbuild src/orchestrator.ts --bundle --outfile=dist-bundle-output.cjs" },
  }));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "orchestrator.ts"), "var legacy1 = 1;\nvar legacy2 = 2;\nexport function run(){ return legacy1 + legacy2; }\n");
  fs.writeFileSync(path.join(dir, "index.js"), `import "./src/orchestrator.ts";\n`);
  fs.writeFileSync(path.join(dir, "dist-bundle-output.cjs"), "var __create = Object.create;\n");

  const graph = scored(dir);
  const report = runModernizationScan(dir, graph, loadPkg(dir), "heavy");
  const varFinding = report.findings.find((f) => f.rule === "var-declarations");
  assert.ok(varFinding, "the hand-written source file must still be flagged for its own real var usage");
  assert.ok(varFinding.files.includes("src/orchestrator.ts"));
  assert.ok(!varFinding.files.includes("dist-bundle-output.cjs"));
});

test("a duplicate-functions finding never points into a generated bundle, even if it duplicates a real source function's shape", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "t", main: "index.js", type: "module",
    scripts: { bundle: "esbuild src/x.ts --outfile=out-bundle.cjs" },
  }));
  const fn = "export function shared(x) {\n  const y = x + 1;\n  const z = y * 2;\n  return z;\n}\n";
  fs.writeFileSync(path.join(dir, "index.js"), fn);
  fs.writeFileSync(path.join(dir, "other.js"), fn);
  fs.writeFileSync(path.join(dir, "out-bundle.cjs"), fn); // same shape, but it's the generated output

  const graph = scored(dir);
  const report = runModernizationScan(dir, graph, loadPkg(dir), "heavy");
  const dupFinding = report.findings.find((f) => f.rule === "duplicate-functions");
  assert.ok(dupFinding, "the real index.js/other.js duplication must still be reported");
  assert.ok(!dupFinding.files.includes("out-bundle.cjs"), "the generated bundle must never be listed as one of the duplicate's files");
});
