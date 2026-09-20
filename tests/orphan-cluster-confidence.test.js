/**
 * tests/orphan-cluster-confidence.test.js — the orphan-cluster finding must
 * disclose when it's derived from an incomplete call graph. Orphan status
 * is only as trustworthy as call resolution: a low rate (dynamic require(),
 * CJS indirection, etc.) means real callers can be missed, producing false
 * "unreachable" claims. Previously this finding always reported certainty
 * 1.0 regardless of the graph's actual call-resolution rate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProject } from "../src/core/parser.js";
import { buildGraph, loadPkg } from "../src/core/graph.js";
import { runModernizationScan } from "../src/core/modernize.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapd-orphan-conf-"));
}

test("orphan-cluster finding carries a caveat and reduced certainty when call resolution is low", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "entry.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "entry.js"), `export function run(){ unresolved1(); unresolved2(); unresolved3(); }\nrun();\n`);
  // 3+ genuinely unreachable files to clear the orphan-cluster reporting threshold
  for (const n of [1, 2, 3]) fs.writeFileSync(path.join(dir, `orphan${n}.js`), `export function f${n}(){ return ${n}; }\n`);

  const parsed = parseProject(dir);
  const graph = buildGraph(dir, parsed, loadPkg(dir));
  assert.ok(graph.stats.callResolutionRate < 0.9, "fixture must actually exercise the low-resolution path");

  const report = runModernizationScan(dir, graph, loadPkg(dir), "heavy");
  const finding = report.findings.find((f) => f.rule === "orphan-cluster");
  assert.ok(finding, "orphan-cluster finding must be present");
  assert.match(finding.detail, /CAVEAT: call resolution is only/);
  assert.ok(finding.certainty < 1.0, "certainty must be reduced below 1.0 when resolution is low");
});

test("orphan-cluster finding has no caveat and full certainty when call resolution is high", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "entry.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "entry.js"), `import { helper } from "./helper.js";\nhelper();\n`);
  fs.writeFileSync(path.join(dir, "helper.js"), `export function helper(){ return 1; }\n`);
  for (const n of [1, 2, 3]) fs.writeFileSync(path.join(dir, `orphan${n}.js`), `export function f${n}(){ return ${n}; }\n`);

  const parsed = parseProject(dir);
  const graph = buildGraph(dir, parsed, loadPkg(dir));
  assert.equal(graph.stats.callResolutionRate, 1, "fixture must actually exercise the fully-resolved path");

  const report = runModernizationScan(dir, graph, loadPkg(dir), "heavy");
  const finding = report.findings.find((f) => f.rule === "orphan-cluster");
  assert.ok(finding);
  assert.doesNotMatch(finding.detail, /CAVEAT/);
  assert.equal(finding.certainty, 1.0);
});
