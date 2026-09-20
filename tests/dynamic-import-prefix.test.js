/**
 * tests/dynamic-import-prefix.test.js — template-literal dynamic loads
 * (`import(\`./plugins/${name}.js\`)`, `require(\`./cmds/${x}.js\`)`) are the
 * classic plugin/command-registry pattern the master prompt calls out as a
 * static-analysis blind spot. The detector may only report a directory it
 * verified exists in the project (from the literal prefix), and files under
 * it must be classified "dynamically-loaded", never "truly orphaned" — and
 * never asserted alive either.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProject } from "../src/core/parser.js";
import { detectDynamicImportPrefixes, classifyUncoveredFiles, detectGeneratedFiles } from "../src/core/reachability.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapd-dynimport-"));
}

function parsedOf(dir) {
  const parsed = parseProject(dir);
  return { files: parsed.files, fileSet: new Set(parsed.files.map((f) => f.file)) };
}

test("detectDynamicImportPrefixes: import(`./plugins/${name}.js`) resolves the literal prefix to a real directory and cites the call site", () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, "plugins"));
  fs.writeFileSync(path.join(dir, "plugins", "alpha.js"), "export default {};\n");
  fs.writeFileSync(path.join(dir, "loader.js"), "export async function load(name){ return import(`./plugins/${name}.js`); }\n");
  const { files, fileSet } = parsedOf(dir);
  const results = detectDynamicImportPrefixes(dir, files, fileSet);
  assert.equal(results.length, 1);
  assert.equal(results[0].dir, "plugins");
  assert.equal(results[0].referencedFrom, "loader.js");
  assert.equal(results[0].via, "dynamic-import-template");
  assert.ok(Number.isInteger(results[0].line));
});

test("detectDynamicImportPrefixes: require(`./commands/${cmd}.cjs`) is detected the same way", () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, "commands"));
  fs.writeFileSync(path.join(dir, "commands", "run.cjs"), "module.exports = {};\n");
  fs.writeFileSync(path.join(dir, "cli.cjs"), "module.exports = (cmd) => require(`./commands/${cmd}.cjs`);\n");
  const { files, fileSet } = parsedOf(dir);
  const results = detectDynamicImportPrefixes(dir, files, fileSet);
  assert.equal(results.length, 1);
  assert.equal(results[0].dir, "commands");
  assert.equal(results[0].via, "require-template");
});

test("detectDynamicImportPrefixes: never fabricates — a prefix pointing at a directory that doesn't exist detects nothing", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "loader.js"), "export async function load(name){ return import(`./nope/${name}.js`); }\n");
  const { files, fileSet } = parsedOf(dir);
  assert.deepEqual(detectDynamicImportPrefixes(dir, files, fileSet), []);
});

test("detectDynamicImportPrefixes: a template literal with no interpolation is static import resolution's job, not a dynamic edge", () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, "plugins"));
  fs.writeFileSync(path.join(dir, "plugins", "alpha.js"), "export default {};\n");
  fs.writeFileSync(path.join(dir, "loader.js"), "export async function load(){ return import(`./plugins/alpha.js`); }\n");
  const { files, fileSet } = parsedOf(dir);
  assert.deepEqual(detectDynamicImportPrefixes(dir, files, fileSet), []);
});

test("detectDynamicImportPrefixes: bare specifiers (`pkg/${x}`) are not resolvable against the project tree and are skipped", () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, "pkg"));
  fs.writeFileSync(path.join(dir, "pkg", "a.js"), "export default 1;\n");
  fs.writeFileSync(path.join(dir, "loader.js"), "export async function load(x){ return import(`pkg/${x}.js`); }\n");
  const { files, fileSet } = parsedOf(dir);
  assert.deepEqual(detectDynamicImportPrefixes(dir, files, fileSet), []);
});

test("classifyUncoveredFiles: files under a template-literal-loaded directory are dynamically-loaded, not orphaned", () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, "plugins"));
  fs.writeFileSync(path.join(dir, "plugins", "alpha.js"), "export default {};\n");
  fs.writeFileSync(path.join(dir, "orphan.js"), "export const dead = 1;\n");
  fs.writeFileSync(path.join(dir, "loader.js"), "export async function load(name){ return import(`./plugins/${name}.js`); }\n");
  const { files, fileSet } = parsedOf(dir);
  const uncovered = ["plugins/alpha.js", "orphan.js"];
  const generated = detectGeneratedFiles(dir, fileSet, null);
  const result = classifyUncoveredFiles(dir, files, fileSet, uncovered, generated);
  assert.deepEqual(result.dynamicallyLoaded.map((d) => d.file), ["plugins/alpha.js"]);
  assert.equal(result.dynamicallyLoaded[0].evidence[0].referencedFrom, "loader.js");
  assert.deepEqual(result.trulyOrphaned, ["orphan.js"]);
});
