/**
 * tests/barrel-reexports.test.js — parser edges that were verifiably missing
 * (checked against real @babel/parser output before fixing, not assumed):
 *   export { x } from "./impl.js"   — barrel re-export is an import edge
 *   export * from "./wide.js"       — same edge; re-exported NAMES stay
 *                                     unfabricated (statically unknowable)
 *   import("./lazy.js")             — STATIC dynamic import is a real edge
 * Without these, the target files fall out of every workflow and read as
 * orphaned. Template-literal dynamic imports remain reachability.js's job.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJsFile, parseProject } from "../src/core/parser.js";
import { buildGraph } from "../src/core/graph.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapd-barrel-"));
}

function write(dir, rel, content) {
  fs.writeFileSync(path.join(dir, rel), content);
}

test("export { x } from './impl.js' records an import edge with the re-exported names", () => {
  const dir = tmpProject();
  write(dir, "barrel.js", `export { helper, other } from "./impl.js";\n`);
  const node = parseJsFile(path.join(dir, "barrel.js"), "barrel.js");
  assert.deepEqual(node.imports, [{ source: "./impl.js", names: ["helper", "other"] }]);
  assert.deepEqual(node.exports.sort(), ["helper", "other"]);
});

test("export * from './wide.js' records the edge but fabricates no names", () => {
  const dir = tmpProject();
  write(dir, "barrel.js", `export * from "./wide.js";\n`);
  const node = parseJsFile(path.join(dir, "barrel.js"), "barrel.js");
  assert.deepEqual(node.imports, [{ source: "./wide.js", names: [] }]);
  assert.deepEqual(node.exports, [], "names behind export * are statically unknowable — none may be invented");
});

test("import('./lazy.js') with a static string records an import edge; template literals do not (reachability's job)", () => {
  const dir = tmpProject();
  write(dir, "loader.js", `export async function load(){ return import("./lazy.js"); }\nexport async function dyn(n){ return import(\`./plugins/\${n}.js\`); }\n`);
  const node = parseJsFile(path.join(dir, "loader.js"), "loader.js");
  assert.deepEqual(node.imports, [{ source: "./lazy.js", names: [] }]);
});

test("a barrel keeps its implementation files inside the workflow instead of orphaning them", () => {
  const dir = tmpProject();
  write(dir, "index.js", `export * from "./api/index.js";\n`);
  fs.mkdirSync(path.join(dir, "api"));
  write(dir, "api/index.js", `export { getUser } from "./users.js";\n`);
  write(dir, "api/users.js", `export function getUser(){ return 1; }\n`);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "index.js" }));

  const g = buildGraph(dir, parseProject(dir), { name: "t", main: "index.js" }, {});
  const wf = g.workflows.find((w) => w.entry.file === "index.js");
  assert.ok(wf.files.includes("api/index.js"), "export * must pull the barrel into the workflow");
  assert.ok(wf.files.includes("api/users.js"), "the barrel's re-export must pull the implementation in too");
  assert.deepEqual(g.orphans, []);
});

test("a lazily-imported module is workflow-reachable, not orphaned", () => {
  const dir = tmpProject();
  write(dir, "index.js", `export async function main(){ const m = await import("./modal.js"); return m.show(); }\n`);
  write(dir, "modal.js", `export function show(){ return true; }\n`);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "index.js" }));

  const g = buildGraph(dir, parseProject(dir), { name: "t", main: "index.js" }, {});
  const wf = g.workflows.find((w) => w.entry.file === "index.js");
  assert.ok(wf.files.includes("modal.js"));
  assert.deepEqual(g.orphans, []);
});
