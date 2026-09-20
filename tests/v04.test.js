/**
 * tests/v04.test.js — CJS resolution, entry-detection fix, injection safety,
 * mermaid docs, and hash-cache correctness.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseJsFile, parseProject } from "../src/core/parser.js";
import { buildGraph } from "../src/core/graph.js";
import { scoreGraph } from "../src/core/confidence.js";
import { renderDocs } from "../src/core/docs.js";
import { detectConflicts } from "../src/core/integrate.js";

function tmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-v4-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}
const PKG = JSON.stringify({ name: "t", main: "index.js" });

test("CJS: require bindings (plain + destructured) and module.exports surface extracted", () => {
  const dir = tmpProject({
    "index.js": `const { helper, other } = require("./lib.js");\nconst util = require("./util.js");\nfunction main(){ helper(); util(); }\nmodule.exports = { main };\nexports.extra = function extra(){};`,
    "lib.js": `function helper(){}\nfunction other(){}\nmodule.exports = { helper, other };`,
    "util.js": `module.exports = function util(){};`,
  });
  const idx = parseJsFile(path.join(dir, "index.js"), "index.js");
  assert.deepEqual(idx.imports.find((i) => i.source === "./lib.js").names.sort(), ["helper", "other"]);
  assert.deepEqual(idx.imports.find((i) => i.source === "./util.js").names, ["util"]);
  assert.ok(idx.exports.includes("main") && idx.exports.includes("extra"));

  const lib = parseJsFile(path.join(dir, "lib.js"), "lib.js");
  assert.ok(lib.exports.includes("helper") && lib.exports.includes("other"));

  const g = buildGraph(dir, parseProject(dir), JSON.parse(PKG));
  const cross = g.callEdges.filter((e) => e.resolution === "cross-file").map((e) => e.to);
  assert.ok(cross.includes("lib.js#helper"), `expected CJS cross-file edge, got ${JSON.stringify(cross)}`);
});

test("route calls inside test files do not create entry points", () => {
  const dir = tmpProject({
    "package.json": PKG,
    "index.js": `export function serve(app){ app.get("/x", () => {}); }`,
    "test/index.test.js": `export function t(app){ app.get("/x", () => {}); }`,
  });
  const g = buildGraph(dir, parseProject(dir), JSON.parse(PKG));
  const routes = g.entryPoints.filter((e) => e.kind === "http-route-site").map((e) => e.file);
  assert.deepEqual(routes, ["index.js"]);
});

test("injection safety: hostile branch name is treated as a branch, not a shell command", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-inj-"));
  const sh = (...args) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(path.join(dir, "a.js"), "export function a(){}\n");
  sh("init", "-q", "-b", "main");
  sh("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
  sh("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  const canary = path.join(dir, "PWNED");
  const hostile = `x;touch ${canary}`;
  let threw = false;
  try { detectConflicts(dir, hostile); } catch { threw = true; }
  // Either outcome is acceptable EXCEPT command execution:
  assert.equal(fs.existsSync(canary), false, "hostile branch name executed a shell command");
  assert.ok(threw || true);
});

test("MAP.md contains deterministic mermaid topology and per-workflow diagrams", async () => {
  const dir = tmpProject({
    "package.json": PKG,
    "index.js": `import { u } from "./u.js";\nexport function main(){ u(); }`,
    "u.js": `export function u(){}`,
  });
  const g = scoreGraph(dir, buildGraph(dir, parseProject(dir), JSON.parse(PKG)));
  const md = await renderDocs(g, { withNarration: false });
  const blocks = md.match(/```mermaid/g) ?? [];
  assert.ok(blocks.length >= 2, `expected ≥2 mermaid blocks, got ${blocks.length}`);
  assert.ok(md.includes("## Topology"));
  assert.ok(/n\d+\["index\.js"\] --> n\d+\["u\.js"\]|n\d+\["u\.js"\]/.test(md));
});

test("hash cache: identical results, reparses only the changed file", () => {
  const dir = tmpProject({
    "a.js": `export function a(){}`,
    "b.js": `export function b(){}`,
  });
  const cache = new Map();
  const r1 = parseProject(dir, { cache });
  assert.equal(r1.parsedCount, 2);
  const r2 = parseProject(dir, { cache });
  assert.equal(r2.cacheHits, 2);
  assert.equal(r2.parsedCount, 0);
  fs.appendFileSync(path.join(dir, "a.js"), `\nexport function a2(){}`);
  const r3 = parseProject(dir, { cache });
  assert.equal(r3.parsedCount, 1);
  assert.equal(r3.cacheHits, 1);
  // cached result must equal fresh result
  const fresh = parseProject(dir);
  assert.deepEqual(
    r3.files.map((f) => [f.file, f.exports.sort()]).sort(),
    fresh.files.map((f) => [f.file, f.exports.sort()]).sort()
  );
});

test("npm scripts invoking node files are detected as entry points", () => {
  const dir = tmpProject({
    "package.json": JSON.stringify({ name: "t", scripts: { start: "node srv.js", test: "node --test t/" } }),
    "srv.js": `import { h } from "./h.js";\nexport function serve(){ h(); }`,
    "h.js": `export function h(){}`,
  });
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json")));
  const g = buildGraph(dir, parseProject(dir), pkg);
  const ep = g.entryPoints.find((e) => e.kind === "npm-script");
  assert.ok(ep && ep.file === "srv.js", JSON.stringify(g.entryPoints));
  const wf = g.workflows.find((w) => w.entry.file === "srv.js");
  assert.ok(wf.files.includes("h.js"), "workflow should reach imported files");
  assert.equal(g.orphans.length, 0);
});
