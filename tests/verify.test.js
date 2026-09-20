/**
 * tests/verify.test.js — `mapd verify` collapses the gates into one verdict with
 * a CI-honest exit code: FAIL (exit 2) only on MEANINGFUL regressions (invalid
 * config, removed exports/workflows, new parse failures), WARN (exit 0) on noise
 * like a missing/rebaselineable baseline, and PASS when clean.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildScoredGraph } from "../src/core/intelligence.js";
import { saveBaseline } from "../src/core/regression.js";
import { runVerify } from "../src/core/verify.js";

function project(helperSrc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-verify-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "entry.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "entry.js"), `import { helper } from "./helper.js";\nexport function run(){ return helper(); }\nrun();\n`);
  fs.writeFileSync(path.join(dir, "helper.js"), helperSrc);
  return dir;
}

test("no baseline → WARN, not FAIL, exit 0", () => {
  const v = runVerify(project(`export function helper(){ return 1; }\n`));
  assert.equal(v.summary.baseline, "none");
  assert.equal(v.verdict, "warn");
  assert.equal(v.exitCode, 0);
  assert.ok(v.prSummary.includes("Verdict: WARN"));
});

test("clean re-verify against a fresh baseline → PASS, exit 0", () => {
  const dir = project(`export function helper(){ return 1; }\n`);
  saveBaseline(dir, buildScoredGraph(dir));
  const v = runVerify(dir);
  assert.equal(v.verdict, "pass");
  assert.equal(v.exitCode, 0);
  assert.equal(v.summary.findings.total, 0);
});

test("removing an exported symbol → FAIL, exit 2", () => {
  const dir = project(`export function helper(){ return 1; }\nexport function extra(){ return 2; }\n`);
  saveBaseline(dir, buildScoredGraph(dir));
  fs.writeFileSync(path.join(dir, "helper.js"), `export function helper(){ return 1; }\n`);
  const v = runVerify(dir);
  assert.equal(v.verdict, "fail");
  assert.equal(v.exitCode, 2);
  assert.ok(v.gates.some((g) => g.name === "regression" && g.status === "fail"));
});

test("invalid config → FAIL", () => {
  const dir = project(`export function helper(){ return 1; }\n`);
  fs.writeFileSync(path.join(dir, ".mapdrc"), JSON.stringify({ mapping: "not-an-object" }));
  const v = runVerify(dir);
  assert.equal(v.verdict, "fail");
  assert.ok(v.gates.some((g) => g.name === "config" && g.status === "fail"));
});

test("--strict escalates a warn-only run to exit 1", () => {
  const v = runVerify(project(`export function helper(){ return 1; }\n`), { strict: true });
  assert.equal(v.verdict, "warn");
  assert.equal(v.exitCode, 1, "strict turns warnings into a nonzero exit");
});
