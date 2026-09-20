/**
 * tests/runtime-edge-detectors.test.js — the two file-level runtime-edge
 * detectors added after AST verification (not assumption): Vite's
 * import.meta.glob and the bundler-standard `new Worker(new URL(...))`
 * pattern. Same design rule as every detector: verified AST shape + a real
 * file in the project, or nothing detected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProject } from "../src/core/parser.js";
import { detectImportMetaGlobs, detectWorkerUrls, classifyUncoveredFiles, detectGeneratedFiles } from "../src/core/reachability.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapd-runtimeedge-"));
}

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function parsedOf(dir) {
  const parsed = parseProject(dir);
  return { files: parsed.files, fileSet: new Set(parsed.files.map((f) => f.file)) };
}

test("detectImportMetaGlobs: matches exactly the files the literal glob names, citing the call site", () => {
  const dir = tmpProject();
  write(dir, "modules/a.js", "export default 1;\n");
  write(dir, "modules/b.js", "export default 2;\n");
  write(dir, "other/c.js", "export default 3;\n");
  write(dir, "main.js", `export const mods = import.meta.glob("./modules/*.js");\n`);
  const { files, fileSet } = parsedOf(dir);
  const results = detectImportMetaGlobs(dir, files, fileSet);
  assert.deepEqual(results.map((r) => r.file).sort(), ["modules/a.js", "modules/b.js"]);
  assert.equal(results[0].referencedFrom, "main.js");
  assert.match(results[0].via, /import\.meta\.glob/);
});

test("detectImportMetaGlobs: a glob matching nothing detects nothing; non-relative patterns are skipped", () => {
  const dir = tmpProject();
  write(dir, "main.js", `export const a = import.meta.glob("./nope/*.js");\nexport const b = import.meta.glob("bare/*.js");\n`);
  const { files, fileSet } = parsedOf(dir);
  assert.deepEqual(detectImportMetaGlobs(dir, files, fileSet), []);
});

test("detectWorkerUrls: new Worker(new URL('./worker.js', import.meta.url)) resolves to the real file", () => {
  const dir = tmpProject();
  write(dir, "worker.js", "self.onmessage = () => {};\n");
  write(dir, "main.js", `export function start(){ return new Worker(new URL("./worker.js", import.meta.url)); }\n`);
  const { files, fileSet } = parsedOf(dir);
  const results = detectWorkerUrls(dir, files, fileSet);
  assert.equal(results.length, 1);
  assert.equal(results[0].file, "worker.js");
  assert.match(results[0].via, /new Worker/);
});

test("detectWorkerUrls: never fabricates — missing file, plain-string arg, or no import.meta.url base detect nothing", () => {
  const dir = tmpProject();
  write(dir, "main.js", [
    `export const a = () => new Worker(new URL("./missing.js", import.meta.url));`,
    `export const b = () => new Worker("./worker-string.js");`,
    `export const c = () => new Worker(new URL("./x.js", base));`,
  ].join("\n") + "\n");
  write(dir, "x.js", "export default 1;\n"); // exists, but the URL base isn't import.meta.url
  const { files, fileSet } = parsedOf(dir);
  assert.deepEqual(detectWorkerUrls(dir, files, fileSet), []);
});

test("classifyUncoveredFiles: glob-matched and worker files classify as dynamically-loaded, not orphaned", () => {
  const dir = tmpProject();
  write(dir, "modules/a.js", "export default 1;\n");
  write(dir, "worker.js", "self.onmessage = () => {};\n");
  write(dir, "orphan.js", "export const dead = 1;\n");
  write(dir, "main.js", `export const mods = import.meta.glob("./modules/*.js");\nexport const w = () => new Worker(new URL("./worker.js", import.meta.url));\n`);
  const { files, fileSet } = parsedOf(dir);
  const uncovered = ["modules/a.js", "worker.js", "orphan.js"];
  const result = classifyUncoveredFiles(dir, files, fileSet, uncovered, detectGeneratedFiles(dir, fileSet, null));
  assert.deepEqual(result.dynamicallyLoaded.map((d) => d.file).sort(), ["modules/a.js", "worker.js"]);
  assert.deepEqual(result.trulyOrphaned, ["orphan.js"]);
});
