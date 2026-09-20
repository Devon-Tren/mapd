/**
 * tests/reachability.test.js — the reachability taxonomy: static analysis
 * genuinely cannot see runtime directory-scan plugin loaders or test-runner
 * glob discovery, so files under those must be classified as "unverifiable,"
 * never silently lumped in with truly orphaned files or falsely asserted as
 * used. Every classification here must be evidenced (a real file/line), and
 * a miss (no evidence found) must fall through honestly to "orphan," never
 * a fabricated classification.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProject } from "../src/core/parser.js";
import { buildGraph, loadPkg } from "../src/core/graph.js";
import {
  detectDynamicDirectoryReferences, detectTestGlobDirectories, isGeneratedArtifact, classifyUncoveredFiles,
  detectGeneratedFiles, detectBundlerOutputs, detectConfigBundlerOutputs,
} from "../src/core/reachability.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapd-reach-"));
}

// ---- dynamic directory references (registry.load(path.join(__dirname, "tools")) style) ----

test("detectDynamicDirectoryReferences: recognizes a runtime directory-scan loader and cites the real call site", () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, "tools"));
  fs.writeFileSync(path.join(dir, "tools", "a.cjs"), "module.exports = {};\n");
  fs.writeFileSync(path.join(dir, "main.cjs"), `
    const path = require("path");
    const registry = require("./registry.cjs");
    registry.load(path.join(__dirname, "tools"));
  `);
  const parsed = parseProject(dir);
  const fileSet = new Set(parsed.files.map((f) => f.file));
  const results = detectDynamicDirectoryReferences(dir, parsed.files, fileSet);
  assert.equal(results.length, 1);
  assert.equal(results[0].dir, "tools");
  assert.equal(results[0].referencedFrom, "main.cjs");
  assert.ok(Number.isInteger(results[0].line));
});

test("detectDynamicDirectoryReferences: never fabricates when the referenced directory doesn't actually exist", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "main.cjs"), `
    const path = require("path");
    registry.load(path.join(__dirname, "does-not-exist"));
  `);
  const parsed = parseProject(dir);
  const fileSet = new Set(parsed.files.map((f) => f.file));
  assert.deepEqual(detectDynamicDirectoryReferences(dir, parsed.files, fileSet), []);
});

test("detectDynamicDirectoryReferences: a single-file path.join(__dirname, ...) reference is not mistaken for a directory reference", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "preload.cjs"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(dir, "main.cjs"), `
    const path = require("path");
    new BrowserWindow({ webPreferences: { preload: path.join(__dirname, "preload.cjs") } });
  `);
  const parsed = parseProject(dir);
  const fileSet = new Set(parsed.files.map((f) => f.file));
  assert.deepEqual(detectDynamicDirectoryReferences(dir, parsed.files, fileSet), [], "preload.cjs is a file, not a directory — must not be classified as a dynamic directory reference");
});

// ---- test-runner glob/config discovery ----

test("detectTestGlobDirectories: resolves Playwright's testDir string", () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, "e2e"));
  fs.writeFileSync(path.join(dir, "e2e", "login.spec.ts"), "test('x', () => {});\n");
  fs.writeFileSync(path.join(dir, "playwright.config.ts"), `export default { testDir: "./e2e" };\n`);
  const fileSet = new Set(["e2e/login.spec.ts", "playwright.config.ts"]);
  const results = detectTestGlobDirectories(dir, fileSet);
  assert.equal(results.length, 1);
  assert.equal(results[0].dir, "e2e");
  assert.equal(results[0].key, "testDir");
});

test("detectTestGlobDirectories: resolves Vitest's include glob array to its static directory prefix", () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tests", "foo.test.ts"), "test('x', () => {});\n");
  fs.writeFileSync(path.join(dir, "vitest.config.ts"), `export default { test: { include: ["tests/**/*.test.ts"] } };\n`);
  const fileSet = new Set(["tests/foo.test.ts", "vitest.config.ts"]);
  const results = detectTestGlobDirectories(dir, fileSet);
  assert.equal(results.length, 1);
  assert.equal(results[0].dir, "tests");
});

test("detectTestGlobDirectories: no config file present -> no results, no error", () => {
  const dir = tmpProject();
  assert.deepEqual(detectTestGlobDirectories(dir, new Set(["a.js"])), []);
});

test("detectTestGlobDirectories: never fabricates when the referenced directory has no project files", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "playwright.config.ts"), `export default { testDir: "./nonexistent" };\n`);
  assert.deepEqual(detectTestGlobDirectories(dir, new Set(["playwright.config.ts"])), []);
});

// ---- generated artifacts ----

test("isGeneratedArtifact: recognizes filename convention (.bundle., .min., .generated.)", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "app.bundle.js"), "console.log(1);\n");
  assert.equal(isGeneratedArtifact(dir, "app.bundle.js").generated, true);
});

test("isGeneratedArtifact: recognizes an explicit header comment marker (on a filename that doesn't already match the naming convention)", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "core-logic.cjs"), "// This file was auto-generated. Do not edit.\nmodule.exports = 1;\n");
  const result = isGeneratedArtifact(dir, "core-logic.cjs");
  assert.equal(result.generated, true);
  assert.match(result.reason, /header comment/);
});

test("isGeneratedArtifact: a hyphen-separated bundle filename (real-world esbuild convention, not just dot-separated) is recognized", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "plan-mode-bundle.cjs"), "var __create = Object.create;\n"); // no header marker at all — real esbuild output has none
  const result = isGeneratedArtifact(dir, "plan-mode-bundle.cjs");
  assert.equal(result.generated, true);
  assert.match(result.reason, /filename convention/);
});

test("isGeneratedArtifact: a hand-written file merely containing 'bundle' as a substring (not a distinct name segment) is not misclassified", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "bundler.js"), "export function createBundler(){ return 1; }\n");
  assert.equal(isGeneratedArtifact(dir, "bundler.js").generated, false);
});

test("detectBundlerOutputs: recognizes an esbuild script's declared --outfile as generated, even with no naming convention and no header", () => {
  const pkg = { scripts: { bundle: "npx esbuild src/engine/orchestrator.ts --bundle --outfile=electron/plan-mode-bundle.cjs" } };
  const outputs = detectBundlerOutputs(pkg);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].path, "electron/plan-mode-bundle.cjs");
  assert.equal(outputs[0].script, "bundle");
});

test("detectBundlerOutputs: a script that doesn't invoke a known bundler tool is ignored, even if it has an -o flag", () => {
  const pkg = { scripts: { convert: "some-random-tool -o output.txt" } };
  assert.deepEqual(detectBundlerOutputs(pkg), []);
});

test("detectConfigBundlerOutputs: webpack output.path (path.resolve(__dirname, ...)) + literal filename resolve to the exact file", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "webpack.config.js"), `
    const path = require("path");
    module.exports = {
      entry: "./src/index.js",
      output: { path: path.resolve(__dirname, "electron"), filename: "main.js" },
    };
  `);
  const outputs = detectConfigBundlerOutputs(dir);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].path, "electron/main.js");
  assert.equal(outputs[0].script, "webpack.config.js");
});

test("detectConfigBundlerOutputs: a webpack filename with substitution tokens falls back to the declared output directory", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "webpack.config.js"), `
    const path = require("path");
    module.exports = { output: { path: path.resolve(__dirname, "build-out"), filename: "[name].bundle.js" } };
  `);
  const outputs = detectConfigBundlerOutputs(dir);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].path, "build-out", "an unresolvable [name] token must not fabricate an exact filename — the declared directory is the honest claim");
});

test("detectConfigBundlerOutputs: rollup output.file (literal) and an output array are both handled", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "rollup.config.mjs"), `
    export default {
      input: "src/index.js",
      output: [
        { file: "electron/bundle.cjs", format: "cjs" },
        { dir: "out-esm", format: "es" },
      ],
    };
  `);
  const outputs = detectConfigBundlerOutputs(dir);
  assert.deepEqual(outputs.map((o) => o.path).sort(), ["electron/bundle.cjs", "out-esm"]);
});

test("detectConfigBundlerOutputs: no config files present -> no outputs, no error; a dynamic output expression is left undetected, never guessed", () => {
  const dir = tmpProject();
  assert.deepEqual(detectConfigBundlerOutputs(dir), []);
  fs.writeFileSync(path.join(dir, "rollup.config.js"), `
    const target = computeTarget();
    export default { output: { file: target } };
  `);
  assert.deepEqual(detectConfigBundlerOutputs(dir), [], "a non-literal output value must not produce a fabricated path");
});

test("end-to-end: a webpack-declared output file (no naming convention, no header) is excluded from modernize scanning", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "electron/main.js", type: "commonjs" }));
  fs.writeFileSync(path.join(dir, "webpack.config.js"), `
    const path = require("path");
    module.exports = { output: { path: path.resolve(__dirname, "electron"), filename: "main.js" } };
  `);
  fs.mkdirSync(path.join(dir, "electron"), { recursive: true });
  fs.writeFileSync(path.join(dir, "electron", "main.js"), "var __webpack_require__ = 1;\nvar a = 2;\nvar b = 3;\n");
  const parsed = parseProject(dir);
  const graph = buildGraph(dir, parsed, loadPkg(dir));
  assert.ok(graph.generatedFiles.some((g) => g.file === "electron/main.js"), "the webpack-declared output must be recognized as generated project-wide");
});

test("isGeneratedArtifact: a file with neither naming convention nor header, but IS a declared esbuild output, is still recognized as generated", () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, "electron"), { recursive: true });
  fs.writeFileSync(path.join(dir, "electron", "orchestrator-out.cjs"), "var __create = Object.create;\n");
  const bundlerOutputs = detectBundlerOutputs({ scripts: { bundle: "esbuild src/x.ts --outfile=electron/orchestrator-out.cjs" } });
  const result = isGeneratedArtifact(dir, "electron/orchestrator-out.cjs", bundlerOutputs);
  assert.equal(result.generated, true);
  assert.match(result.reason, /declared build output/);
});

test("isGeneratedArtifact: an ordinary hand-written file is never misclassified as generated", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "utils.js"), "export function helper(){ return 1; }\n");
  assert.equal(isGeneratedArtifact(dir, "utils.js").generated, false);
});

// ---- combinator + full graph integration ----

test("classifyUncoveredFiles: splits uncovered files into generated/dynamic/truly-orphaned buckets", () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, "tools"));
  fs.writeFileSync(path.join(dir, "tools", "plugin-a.cjs"), "module.exports = {};\n");
  fs.writeFileSync(path.join(dir, "bundle.generated.js"), "console.log(1);\n");
  fs.writeFileSync(path.join(dir, "truly-dead.js"), "export function unused(){ return 1; }\n");
  fs.writeFileSync(path.join(dir, "main.cjs"), `
    const path = require("path");
    registry.load(path.join(__dirname, "tools"));
  `);
  const parsed = parseProject(dir);
  const fileSet = new Set(parsed.files.map((f) => f.file));
  const uncovered = ["tools/plugin-a.cjs", "bundle.generated.js", "truly-dead.js"];
  const generatedFiles = detectGeneratedFiles(dir, fileSet, loadPkg(dir));
  const result = classifyUncoveredFiles(dir, parsed.files, fileSet, uncovered, generatedFiles);

  assert.deepEqual(result.generatedArtifacts.map((g) => g.file), ["bundle.generated.js"]);
  assert.deepEqual(result.dynamicallyLoaded.map((d) => d.file), ["tools/plugin-a.cjs"]);
  assert.deepEqual(result.trulyOrphaned, ["truly-dead.js"]);
});

test("graph.js integration: graph.orphans excludes dynamic/generated files; graph.reachability carries the evidence", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "main.cjs" }));
  fs.mkdirSync(path.join(dir, "tools"));
  fs.writeFileSync(path.join(dir, "tools", "plugin-a.cjs"), "module.exports = {};\n");
  fs.writeFileSync(path.join(dir, "bundle.generated.js"), "console.log(1);\n");
  fs.writeFileSync(path.join(dir, "truly-dead.js"), "export function unused(){ return 1; }\n");
  fs.writeFileSync(path.join(dir, "main.cjs"), `
    const path = require("path");
    registry.load(path.join(__dirname, "tools"));
  `);
  const parsed = parseProject(dir);
  const graph = buildGraph(dir, parsed, loadPkg(dir));

  assert.ok(!graph.orphans.includes("tools/plugin-a.cjs"), "dynamically-loaded plugin file must not be a false orphan");
  assert.ok(!graph.orphans.includes("bundle.generated.js"), "generated artifact must not be a false orphan");
  assert.ok(graph.orphans.includes("truly-dead.js"), "a genuinely unreachable, non-generated, non-dynamic file must still be reported");
  assert.equal(graph.reachability.dynamicallyLoaded[0].file, "tools/plugin-a.cjs");
  assert.equal(graph.reachability.generatedArtifacts[0].file, "bundle.generated.js");
});
