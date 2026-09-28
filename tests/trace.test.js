/**
 * tests/trace.test.js — `mapd trace`: explain a file's reachability, and find
 * the real import/call chain between two files (or honestly report none).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildScoredGraph } from "../src/core/intelligence.js";
import { resolveFile, traceFile, tracePath } from "../src/core/trace.js";

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-trace-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "entry.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "entry.js"), `import { mid } from "./mid.js";\nexport function run(){ return mid(); }\nrun();\n`);
  fs.writeFileSync(path.join(dir, "mid.js"), `import { leaf } from "./leaf.js";\nexport function mid(){ return leaf(); }\n`);
  fs.writeFileSync(path.join(dir, "leaf.js"), `export function leaf(){ return 1; }\n`);
  fs.writeFileSync(path.join(dir, "island.js"), `export function island(){ return 2; }\n`); // orphan
  return dir;
}

test("trace <file>: a reachable file shows its workflow and the import chain from the entry", () => {
  const g = buildScoredGraph(project());
  const d = traceFile(g, "leaf.js");
  assert.equal(d.inWorkflow, true);
  assert.ok(d.reachedFrom, "should find a chain from the entry");
  assert.equal(d.reachedFrom.entry, "entry.js");
  assert.deepEqual(d.reachedFrom.chain.map((s) => s.to), ["mid.js", "leaf.js"]);
});

test("trace <file>: an orphan is reported as out-of-workflow with a reason", () => {
  const g = buildScoredGraph(project());
  const d = traceFile(g, "island.js");
  assert.equal(d.inWorkflow, false);
  assert.ok(d.classification && d.reason, "must classify why it's uncovered");
});

test("trace <from> <to>: finds the multi-hop chain", () => {
  const g = buildScoredGraph(project());
  const d = tracePath(g, "entry.js", "leaf.js");
  assert.equal(d.direction, "forward");
  assert.deepEqual(d.chain.map((s) => s.to), ["mid.js", "leaf.js"]);
});

test("trace <from> <to>: honestly reports when no static chain connects two files", () => {
  const g = buildScoredGraph(project());
  const d = tracePath(g, "island.js", "leaf.js");
  assert.equal(d.chain, null);
  assert.match(d.note, /no static import\/call chain/);
});

test("resolveFile: unique suffix match, ambiguity, and not-found", () => {
  const g = buildScoredGraph(project());
  assert.equal(resolveFile(g, "leaf.js").file, "leaf.js");
  assert.ok(resolveFile(g, "does-not-exist.js").notFound);
});

test("chat task context carries each file's deterministic reachability, so the LLM cannot guess it", async () => {
  const { buildTaskContext } = await import("../src/core/intelligence.js");
  const dir = project();
  fs.mkdirSync(path.join(dir, "plugins"));
  fs.writeFileSync(path.join(dir, "plugins", "p.js"), `export default function(){ return 3; }\n`);
  fs.writeFileSync(path.join(dir, "entry.js"), `import { mid } from "./mid.js";\nconst n = process.argv[2];\nexport function run(){ return mid(); }\nexport const load = () => import(\`./plugins/\${n}.js\`);\nrun();\n`);
  const g = buildScoredGraph(dir);
  const ctx = buildTaskContext(g, "plugins p island leaf", { maxHits: 20 });
  const r = Object.fromEntries(ctx.files.map((f) => [f.file, f.reachability]));
  assert.equal(r["plugins/p.js"].classification, "dynamicallyLoaded");
  assert.equal(r["island.js"].classification, "trulyOrphaned");
  assert.equal(r["leaf.js"].inWorkflow, true);
});
