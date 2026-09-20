/**
 * tests/resolution.test.js — `mapd resolution` ranks fixable call sites by blast
 * radius, counts anonymous functions, and excuses external calls (not a penalty).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildScoredGraph } from "../src/core/intelligence.js";
import { analyzeResolution } from "../src/core/resolution.js";

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-res-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "entry.js", type: "module" }));
  // dynamic dispatch + an unresolved call + an anonymous function + an external call
  fs.writeFileSync(path.join(dir, "entry.js"),
    `import fs from "node:fs";\nexport function run(handlers, name){\n  fs.readFileSync("x");\n  handlers[name]();\n  mysteryGlobal();\n  return [1, 2].map((x) => x * 2);\n}\nrun();\n`);
  return dir;
}

test("summary breaks calls down by type and excuses external calls", () => {
  const a = analyzeResolution(buildScoredGraph(project()));
  assert.ok(a.summary.totalCalls > 0);
  assert.ok(a.summary.externalExcused >= 1, "the node:fs call should be counted as external, not a penalty");
  assert.equal(typeof a.summary.byType, "object");
});

test("hotspots surface fixable (dynamic/unresolved) call sites, not external ones", () => {
  const a = analyzeResolution(buildScoredGraph(project()));
  assert.ok(a.hotspots.length >= 1);
  const top = a.hotspots[0];
  assert.ok(top.count === top.dynamic + top.unresolved);
  assert.ok(top.count >= 1);
  // hotspots are ranked by count × blast radius
  for (let i = 1; i < a.hotspots.length; i++) assert.ok(a.hotspots[i - 1].score >= a.hotspots[i].score);
});

test("anonymous-function report counts unnamed functions", () => {
  const a = analyzeResolution(buildScoredGraph(project()));
  assert.ok(a.anonymousTotal >= 1, "the arrow function assigned to cb should be counted");
});
