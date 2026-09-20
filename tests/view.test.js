/**
 * tests/view.test.js — `mapd view` emits a self-contained HTML model: workflow
 * graph, per-file heatmap data, and a baseline diff when present. No external
 * resources; embedded JSON must parse; numbers come from the real graph.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveBaseline } from "../src/core/regression.js";
import { buildScoredGraph } from "../src/core/intelligence.js";
import { buildViewModel, renderViewHtml } from "../src/core/view.js";

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-view-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "entry.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "entry.js"), `import { h } from "./h.js";\nexport function run(){ return h(); }\nrun();\n`);
  fs.writeFileSync(path.join(dir, "h.js"), `export function h(){ return 1; }\n`);
  fs.writeFileSync(path.join(dir, "island.js"), `export function island(){ return 2; }\n`);
  return dir;
}

test("view model carries per-file heatmap fields and workflow signals", () => {
  const m = buildViewModel(project());
  assert.ok(m.files.length >= 3);
  const f = m.files.find((x) => x.file === "h.js");
  for (const k of ["test", "reach", "dynamic", "workflows", "loc"]) assert.ok(k in f, `file model missing ${k}`);
  assert.ok(m.workflows[0].signals.parseIntegrity != null);
  assert.ok(m.ceiling.value >= m.repoConfidence);
});

test("rendered HTML is self-contained and embeds a parseable model", () => {
  const html = renderViewHtml(buildViewModel(project()));
  assert.doesNotMatch(html, /<(script|link)[^>]+(src|href)=["']https?:/, "must not reference external resources");
  const m = html.match(/type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(m, "must embed a data script");
  const model = JSON.parse(m[1].replace(/\\u003c/g, "<"));
  assert.ok(Array.isArray(model.files) && Array.isArray(model.workflows));
  assert.match(html, /Heatmap/);
  assert.match(html, /Diff vs baseline/);
});

test("diff view reflects the saved baseline", () => {
  const dir = project();
  saveBaseline(dir, buildScoredGraph(dir));
  const m = buildViewModel(dir);
  assert.equal(m.baselinePresent, true);
  assert.ok(m.workflows.every((w) => w.baseline != null), "each workflow carries its baseline score");
});

test("no baseline → diff view is disabled honestly", () => {
  const m = buildViewModel(project());
  assert.equal(m.baselinePresent, false);
});
