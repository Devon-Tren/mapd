/**
 * tests/integrate.test.js — F1 conflict detection/classification/gates + F3 rules.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { detectConflicts, verifyProposal, scoreResolution } from "../src/core/integrate.js";
import { runModernizationScan, LEGACY_DEPS } from "../src/core/modernize.js";
import { parseProject } from "../src/core/parser.js";
import { buildGraph } from "../src/core/graph.js";
import { scoreGraph } from "../src/core/confidence.js";

const sh = (cwd, cmd) => execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
const G = `git -c user.email=t@t -c user.name=t`;

test("detectConflicts on a non-git directory returns requiresGit, not a raw git error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-nogit-"));
  const res = detectConflicts(dir, "anybranch");
  assert.equal(res.requiresGit, true, "must flag the missing repo cleanly");
  assert.equal(res.mergeable, false);
  assert.deepEqual(res.conflicts, []);
});

function conflictRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-it-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "greet.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "greet.js"), `export function greet(n){ return "hello " + n; }\n`);
  sh(dir, `git init -q -b main`); sh(dir, `${G} add -A`); sh(dir, `${G} commit -qm base`);
  sh(dir, `git checkout -qb feature`);
  fs.writeFileSync(path.join(dir, "greet.js"), `export function greet(n){ return \`Hello, \${n}!\`; }\n`);
  sh(dir, `${G} commit -qam feature`);
  sh(dir, `git checkout -q main`);
  fs.writeFileSync(path.join(dir, "greet.js"),
    `export function greet(n){ return "HELLO " + n.toUpperCase(); }\nexport function farewell(n){ return "bye " + n; }\n`);
  sh(dir, `${G} commit -qam main`);
  return dir;
}

test("F1: conflict detected and classified workflow-scale when export sets diverge", () => {
  const dir = conflictRepo();
  const { mergeable, conflicts, mergeError } = detectConflicts(dir, "feature");
  assert.equal(mergeError, undefined);
  assert.equal(mergeable, false);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].classification, "workflow-scale");
  assert.deepEqual(conflicts[0].requiredExports, ["farewell", "greet"]);
});

test("F1: clean merge reports mergeable with no fabricated conflicts", () => {
  const dir = conflictRepo();
  sh(dir, `git checkout -qb clean-branch`);
  fs.writeFileSync(path.join(dir, "other.js"), `export function other(){}\n`);
  sh(dir, `${G} add -A`); sh(dir, `${G} commit -qm other`);
  sh(dir, `git checkout -q main`);
  const r = detectConflicts(dir, "clean-branch");
  assert.equal(r.mergeable, true);
  assert.equal(r.conflicts.length, 0);
});

test("F1: gates reject a proposal that drops a required export; accept one preserving the union", () => {
  const dir = conflictRepo();
  const { conflicts } = detectConflicts(dir, "feature");
  const c = conflicts[0];

  const bad = `export function greet(n){ return \`Hello, \${n}!\`; }\n`; // drops farewell
  const badGates = verifyProposal(c, bad);
  assert.equal(badGates.find((g) => g.gate === "G2-export-union-preserved").passed, false);

  const good = `export function greet(n){ return \`Hello, \${n.toUpperCase()}!\`; }\nexport function farewell(n){ return "bye " + n; }\n`;
  const goodGates = verifyProposal(c, good);
  assert.ok(goodGates.every((g) => g.passed), JSON.stringify(goodGates));

  const sBad = scoreResolution(c, badGates, false);
  const sGood = scoreResolution(c, goodGates, false);
  assert.ok(sGood.score > sBad.score);
  assert.ok(sGood.score < 0.8, "workflow-scale without tests must not clear the default apply threshold");
});

function scanFixture(pkgExtra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-mod-"));
  const pkg = { name: "t", main: "index.js", type: "module", dependencies: { moment: "^2.0.0", request: "^2.0.0" }, ...pkgExtra };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  fs.writeFileSync(path.join(dir, "index.js"),
    `export function main(){ var a = 1; return fetch("/x").then(r => r.json()); }\n`);
  const g = scoreGraph(dir, buildGraph(dir, parseProject(dir), pkg));
  return { dir, g, pkg };
}

test("F3: light mode finds legacy deps only; medium adds patterns", () => {
  const { dir, g, pkg } = scanFixture();
  const light = runModernizationScan(dir, g, pkg, "light");
  const lightRules = light.findings.map((f) => f.rule);
  assert.ok(lightRules.includes("legacy-dep:moment") && lightRules.includes("legacy-dep:request"));
  assert.ok(!lightRules.some((r) => r === "var-declarations"), "light must not run pattern tier");

  const medium = runModernizationScan(dir, g, pkg, "medium");
  const medRules = medium.findings.map((f) => f.rule);
  assert.ok(medRules.includes("var-declarations"));
  assert.ok(medRules.includes("promise-then-chains"));
});

test("F3: impact scores are derived and present on every non-info finding", () => {
  const { dir, g, pkg } = scanFixture();
  const r = runModernizationScan(dir, g, pkg, "heavy");
  for (const f of r.findings.filter((x) => !x.informational)) {
    assert.ok(f.operationalImpact, `${f.rule} missing operationalImpact`);
    const oi = f.operationalImpact;
    assert.ok(Math.abs(oi.impact - oi.reach * oi.certainty) < 1e-9, "impact must equal reach×certainty");
    assert.equal(f.status, "awaiting-approval");
  }
  // curated-table findings must carry certainty exactly 1.0 by definition
  for (const f of r.findings.filter((x) => x.rule.startsWith("legacy-dep:"))) assert.equal(f.certainty, 1.0);
  assert.ok(Object.keys(LEGACY_DEPS).length >= 10);
});
