/**
 * tests/annotations.test.js — .mapdrc `project.annotations`: user-asserted
 * classifications for what static analysis structurally cannot know (a
 * timestamped results directory, a plugin folder loaded by an unrecognized
 * pattern). Mapd never guesses these — the user states them, output labels
 * them as user-asserted (never as detected), and an invalid classification
 * is a config validation error, not a silent no-op.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { globToRegex, applyAnnotations } from "../src/core/reachability.js";
import { buildScoredGraph } from "../src/core/intelligence.js";
import { validateConfig, loadConfig } from "../src/config/index.js";
import { runModernizationScan } from "../src/core/modernize.js";
import { loadPkg } from "../src/core/graph.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapd-annotations-"));
}

// ---- glob matcher ----

test("globToRegex: ** crosses directories, * stays within a segment, literals stay literal", () => {
  assert.ok(globToRegex("eval/results/**").test("eval/results/todo-app-123/_runner.cjs"));
  assert.ok(globToRegex("electron/tools/**").test("electron/tools/web/search.cjs"));
  assert.ok(!globToRegex("electron/tools/**").test("electron/main.cjs"));
  assert.ok(globToRegex("src/*.js").test("src/app.js"));
  assert.ok(!globToRegex("src/*.js").test("src/nested/app.js"), "single * must not cross a directory boundary");
  assert.ok(globToRegex("exact/file.cjs").test("exact/file.cjs"));
  assert.ok(!globToRegex("exact/file.cjs").test("exact/file2.cjs"));
});

test("applyAnnotations: returns matching files with their pattern and classification; unmatched files untouched", () => {
  const fileSet = new Set(["eval/results/run-1/_runner.cjs", "eval/harness.cjs", "src/app.js"]);
  const matches = applyAnnotations(fileSet, { "eval/results/**": "generated" });
  assert.deepEqual(matches, [{ file: "eval/results/run-1/_runner.cjs", classification: "generated", pattern: "eval/results/**" }]);
});

// ---- config validation ----

test("validateConfig: a valid annotations object passes; an unknown classification fails with a specific error", () => {
  const ok = validateConfig({ project: { annotations: { "eval/results/**": "generated", "tools/**": "dynamically-loaded" } } });
  assert.equal(ok.ok, true);
  const bad = validateConfig({ project: { annotations: { "x/**": "definitely-fine-trust-me" } } });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(" "), /classification must be one of/);
});

// ---- end-to-end through .mapdrc -> buildScoredGraph ----

function annotatedProject(annotations) {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, ".mapdrc"), JSON.stringify({ project: { annotations } }));
  fs.writeFileSync(path.join(dir, "index.js"), "export function hi(){ return 1; }\n");
  return dir;
}

test("a 'generated' annotation excludes matching files from orphans AND from modernize pattern scanning, with a user-asserted reason", () => {
  const dir = annotatedProject({ "results/**": "generated" });
  fs.mkdirSync(path.join(dir, "results", "run-1782396943351"), { recursive: true });
  fs.writeFileSync(path.join(dir, "results", "run-1782396943351", "_runner.cjs"), "var a = 1;\nvar b = 2;\nmodule.exports = { a, b };\n");

  const graph = buildScoredGraph(dir);
  assert.ok(!graph.orphans.includes("results/run-1782396943351/_runner.cjs"), "annotated-generated file must not be an orphan");
  const gen = graph.generatedFiles.find((g) => g.file === "results/run-1782396943351/_runner.cjs");
  assert.ok(gen, "must appear in generatedFiles");
  assert.match(gen.reason, /user annotation in \.mapdrc/, "the reason must say it's user-asserted, not detected");

  const report = runModernizationScan(dir, graph, loadPkg(dir), "heavy");
  const varFinding = report.findings.find((f) => f.rule === "var-declarations");
  assert.equal(varFinding, undefined, "annotated-generated file's var usage must not surface as a finding");
});

test("a 'dynamically-loaded' annotation moves matching uncovered files out of orphans with user-annotation evidence", () => {
  const dir = annotatedProject({ "plugins/**": "dynamically-loaded" });
  fs.mkdirSync(path.join(dir, "plugins"), { recursive: true });
  fs.writeFileSync(path.join(dir, "plugins", "custom-loader-target.cjs"), "module.exports = { run(){ return 1; } };\n");

  const graph = buildScoredGraph(dir);
  assert.ok(!graph.orphans.includes("plugins/custom-loader-target.cjs"));
  const dyn = graph.reachability.dynamicallyLoaded.find((d) => d.file === "plugins/custom-loader-target.cjs");
  assert.ok(dyn, "must be classified dynamically-loaded");
  assert.match(JSON.stringify(dyn.evidence), /userAnnotation/, "evidence must be labeled as a user annotation");
});

test("with no annotations configured, behavior is unchanged — an unreachable file is still honestly reported", () => {
  const dir = annotatedProject({});
  fs.writeFileSync(path.join(dir, "dead.js"), "export function unused(){ return 1; }\n");
  const graph = buildScoredGraph(dir);
  assert.ok(graph.orphans.includes("dead.js"));
});

test("annotations load through .mapdrc's JSONC (comments allowed) like every other config field", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, ".mapdrc"), `{
    // teach mapd what it can't statically see
    "project": { "annotations": { "gen/**": "generated" } }
  }`);
  fs.writeFileSync(path.join(dir, "index.js"), "export function hi(){ return 1; }\n");
  const config = loadConfig(dir);
  assert.deepEqual(config.project.annotations, { "gen/**": "generated" });
});
