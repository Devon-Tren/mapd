/**
 * tests/annotation-classifications.test.js — the two "tell Map'd" levers the
 * master prompt promises beyond generated/dynamically-loaded:
 *   entrypoint          — user-asserted entry; a workflow must form from it
 *                         (works for any language, including heuristic-parsed)
 *   intentional-dormant — deliberately kept code; excluded from orphan claims
 *                         with the annotation as evidence, labeled user-asserted
 * Plus edge cases: nonexistent project root fails with one actionable message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProject } from "../src/core/parser.js";
import { buildGraph } from "../src/core/graph.js";
import { buildScoredGraph } from "../src/core/intelligence.js";
import { setAnnotation } from "../src/config/index.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapd-annocls-"));
}

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

test("entrypoint annotation: an unreferenced file becomes a real workflow, labeled as a user assertion", () => {
  const dir = tmpProject();
  write(dir, "index.js", `export function main(){ return 1; }\n`);
  write(dir, "worker.js", `import { helper } from "./shared.js";\nexport function work(){ return helper(); }\n`);
  write(dir, "shared.js", `export function helper(){ return 2; }\n`);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "index.js" }));

  // without the annotation, worker.js is unreached (nothing imports it)
  const before = buildGraph(dir, parseProject(dir), { name: "t", main: "index.js" }, {});
  assert.ok(!before.workflows.some((w) => w.entry.file === "worker.js"));

  const annotations = { "worker.js": "entrypoint" };
  const g = buildGraph(dir, parseProject(dir), { name: "t", main: "index.js" }, { annotations });
  const wf = g.workflows.find((w) => w.entry.file === "worker.js");
  assert.ok(wf, "the asserted entrypoint must grow a workflow");
  assert.equal(wf.entry.kind, "user-annotation");
  assert.match(wf.entry.detail, /asserted entrypoint/);
  assert.ok(wf.files.includes("shared.js"), "the workflow must include files reachable from the asserted entry");
});

test("entrypoint annotation works for a heuristic-parsed language with no detectable entry marker", () => {
  const dir = tmpProject();
  write(dir, "job.py", `import lib\n\ndef run():\n    pass\n`); // no __main__ guard — cron runs it
  write(dir, "lib.py", `def helper():\n    pass\n`);
  const g = buildGraph(dir, parseProject(dir), null, { annotations: { "job.py": "entrypoint" } });
  const wf = g.workflows.find((w) => w.entry.file === "job.py");
  assert.ok(wf);
  assert.ok(wf.files.includes("lib.py"));
});

test("intentional-dormant annotation: file leaves the orphan list with the annotation as evidence", () => {
  const dir = tmpProject();
  write(dir, "index.js", `export function main(){ return 1; }\n`);
  write(dir, "legacy.js", `export function oldPath(){ return 0; }\n`);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "index.js" }));

  const pkg = { name: "t", main: "index.js" };
  const before = buildGraph(dir, parseProject(dir), pkg, {});
  assert.ok(before.orphans.includes("legacy.js"), "without the annotation it is a real orphan");

  const g = buildGraph(dir, parseProject(dir), pkg, { annotations: { "legacy.js": "intentional-dormant" } });
  assert.ok(!g.orphans.includes("legacy.js"));
  const entry = g.reachability.intentionalDormant.find((d) => d.file === "legacy.js");
  assert.match(entry.evidence[0].userAnnotation, /intentional-dormant/);
});

test("setAnnotation accepts the new classifications end to end", () => {
  const dir = tmpProject();
  assert.equal(setAnnotation(dir, "jobs/**", "entrypoint").ok, true);
  assert.equal(setAnnotation(dir, "attic/**", "intentional-dormant").ok, true);
  const rc = JSON.parse(fs.readFileSync(path.join(dir, ".mapdrc"), "utf8"));
  assert.deepEqual(rc.project.annotations, { "jobs/**": "entrypoint", "attic/**": "intentional-dormant" });
});

test("buildScoredGraph on a nonexistent root fails with one actionable message, not a raw ENOENT", () => {
  assert.throws(() => buildScoredGraph("/definitely/not/a/real/dir"), /project root does not exist/);
});

test("buildScoredGraph on an empty directory returns a sane zero-file graph", () => {
  const dir = tmpProject();
  const g = buildScoredGraph(dir);
  assert.equal(g.stats.fileCount, 0);
  assert.equal(g.workflows.length, 0);
  assert.equal(g.repoConfidence, 0);
});
