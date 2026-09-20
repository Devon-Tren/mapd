/**
 * tests/test-guidance.test.js — Test Guidance must separate REAL test credit
 * (a test that imports the module and references its exports) from name-only
 * padding (a filename that merely contains the basename), and quantify how much
 * padding inflates testPresence — without silently rewriting the score.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildScoredGraph } from "../src/core/intelligence.js";
import { analyzeTestCoverage, testGaps, testCredit } from "../src/core/testGuidance.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-tg-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "entry.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "entry.js"),
    `import { helper } from "./helper.js";\nimport { widget } from "./widget.js";\nimport { lonely } from "./lonely.js";\nexport function run(){ return helper() + widget() + lonely(); }\nrun();\n`);
  fs.writeFileSync(path.join(dir, "helper.js"), `export function helper(){ return 1; }\n`);
  fs.writeFileSync(path.join(dir, "widget.js"), `export function widget(){ return 2; }\n`);
  fs.writeFileSync(path.join(dir, "lonely.js"), `export function lonely(){ return 3; }\n`);
  fs.mkdirSync(path.join(dir, "tests"));
  // REAL: imports the module and calls its export
  fs.writeFileSync(path.join(dir, "tests", "helper.test.js"),
    `import { helper } from "../helper.js";\nif (helper() !== 1) throw new Error("x");\n`);
  // PADDING: filename contains "widget" but references nothing from widget.js
  fs.writeFileSync(path.join(dir, "tests", "widget.test.js"),
    `const x = 1;\nif (x !== 1) throw new Error("x");\n`);
  return dir;
}

test("classifies real credit, name-only padding, and untested files", () => {
  const dir = fixture();
  const a = analyzeTestCoverage(dir, buildScoredGraph(dir));
  const by = Object.fromEntries(a.files.map((f) => [f.file, f.status]));
  assert.equal(by["helper.js"], "tested-real", "helper: imported + export used");
  assert.equal(by["widget.js"], "tested-nameonly", "widget: filename coincidence only");
  assert.equal(by["lonely.js"], "untested", "lonely: no matching test at all");
});

test("honest testPresence excludes name-only padding the loose rule would have counted", () => {
  const dir = fixture();
  const a = analyzeTestCoverage(dir, buildScoredGraph(dir));
  assert.ok(a.summary.looseRuleWouldCredit > a.summary.testPresence,
    "the name-only credit must NOT count toward the honest, scored testPresence");
  assert.equal(a.summary.nameOnlyPadding, 1);
  assert.ok(a.summary.paddingRejected > 0);
});

test("test-gaps lists untested + padding with a suggested filename; not real tests", () => {
  const dir = fixture();
  const a = analyzeTestCoverage(dir, buildScoredGraph(dir));
  const gaps = testGaps(a).map((g) => g.file);
  assert.ok(gaps.includes("widget.js"), "padding is a gap");
  assert.ok(gaps.includes("lonely.js"), "untested is a gap");
  assert.ok(!gaps.includes("helper.js"), "a real test is not a gap");
  const lonely = a.files.find((f) => f.file === "lonely.js");
  assert.match(lonely.suggestedTest, /tests\/lonely\.test\.js$/);
});

test("test-credit --padding surfaces only the coincidental credits", () => {
  const dir = fixture();
  const a = analyzeTestCoverage(dir, buildScoredGraph(dir));
  const padding = testCredit(a, { paddingOnly: true }).map((f) => f.file);
  assert.deepEqual(padding, ["widget.js"]);
});
