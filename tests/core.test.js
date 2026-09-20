/**
 * tests/core.test.js — covers parser, graph, confidence, regression.
 * Companion files integrate.test.js / modernize.test.js cover F1/F3.
 * Run: npm test (node --test tests/)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJsFile, parseProject } from "../src/core/parser.js";
import { buildGraph } from "../src/core/graph.js";
import { scoreGraph } from "../src/core/confidence.js";
import { diffGraphs } from "../src/core/regression.js";
import { buildScoredGraph, searchFunctions, buildTaskContext } from "../src/core/intelligence.js";
import { parseCachePath } from "../src/core/parseCache.js";

function tmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

const PKG = JSON.stringify({ name: "t", main: "index.js", type: "module" });

test("parser extracts functions, imports, exports, var count, module type", () => {
  const dir = tmpProject({
    "a.js": `import { x } from "./b.js";\nexport function hi(n){ var q = 1; return x(n) + q; }\nfunction inner(){ hi(2); }`,
  });
  const n = parseJsFile(path.join(dir, "a.js"), "a.js");
  assert.equal(n.parsed, true);
  assert.equal(n.parseErrors, 0);
  assert.deepEqual(n.imports[0], { source: "./b.js", names: ["x"] });
  assert.ok(n.exports.includes("hi"));
  assert.equal(n.varCount, 1);
  assert.equal(n.moduleType, "module");
  const hi = n.functions.find((f) => f.name === "hi");
  assert.ok(hi.exported);
  assert.ok(hi.calls.includes("x"));
  const inner = n.functions.find((f) => f.name === "inner");
  assert.ok(inner.calls.includes("hi"));
});

test("unparseable file is recorded honestly, not guessed", () => {
  const dir = tmpProject({ "bad.js": "function ((((" });
  const r = parseProject(dir);
  const bad = r.files.find((f) => f.file === "bad.js");
  assert.equal(bad.parsed, false);
});

test("graph resolves imports, classifies calls, detects entry point, builds workflow", () => {
  const dir = tmpProject({
    "package.json": PKG,
    "index.js": `import { util } from "./lib/util.js";\nimport fs from "node:fs";\nexport function main(){ util(); fs.readFileSync("x"); console.log(1); mystery(); }`,
    "lib/util.js": `export function util(){ return 1; }`,
    "orphan.js": `export function alone(){}`,
  });
  const parsed = parseProject(dir);
  const g = buildGraph(dir, parsed, JSON.parse(PKG));
  const kinds = Object.fromEntries(g.callEdges.map((e) => [e.unresolvedName ?? e.external ?? e.global ?? e.to, e.resolution]));
  assert.equal(kinds["lib/util.js#util"], "cross-file");
  assert.equal(kinds["fs"], "external");
  assert.equal(kinds["console"], "global");
  assert.equal(kinds["mystery"], "unresolved");
  const wf = g.workflows.find((w) => w.entry.kind === "main");
  assert.ok(wf, "main entry point detected");
  assert.ok(wf.files.includes("lib/util.js"), "BFS followed the import");
  assert.ok(g.orphans.includes("orphan.js"));
});

test("Map.get does not false-trigger http route detection", () => {
  const dir = tmpProject({
    "package.json": PKG,
    "index.js": `export function f(){ const m = new Map(); m.get("k"); }`,
  });
  const g = buildGraph(dir, parseProject(dir), JSON.parse(PKG));
  assert.equal(g.entryPoints.filter((e) => e.kind === "http-route-site").length, 0);
});

test("confidence is derived from signals and testPresence moves it", () => {
  const files = {
    "package.json": PKG,
    "index.js": `import { u } from "./u.js";\nexport function main(){ u(); }`,
    "u.js": `export function u(){}`,
  };
  const bare = tmpProject(files);
  const g1 = scoreGraph(bare, buildGraph(bare, parseProject(bare), JSON.parse(PKG)));

  const tested = tmpProject({ ...files, "tests/index.test.js": `import {} from "../index.js";`, "tests/u.test.js": `import {} from "../u.js";` });
  const g2 = scoreGraph(tested, buildGraph(tested, parseProject(tested), JSON.parse(PKG)));

  const s1 = g1.workflows.find((w) => w.entry.kind === "main").confidence;
  const s2 = g2.workflows.find((w) => w.entry.kind === "main").confidence;
  assert.ok(s2.score > s1.score, `tests should raise derived score (${s1.score} -> ${s2.score})`);
  assert.ok(s1.signals.testPresence.value === 0 && s2.signals.testPresence.value > 0);
  // no git repo in tmp dir → stability unavailable, weights renormalized, coverage < 1
  assert.equal(s1.signals.stability.unavailable, true);
  assert.ok(s1.signalCoverage < 1);
});

test("regression diff catches removed export and new orphan", () => {
  const before = {
    "package.json": PKG,
    "index.js": `import { a, b } from "./lib.js";\nexport function main(){ a(); b(); }`,
    "lib.js": `export function a(){}\nexport function b(){}`,
  };
  const d1 = tmpProject(before);
  const g1 = scoreGraph(d1, buildGraph(d1, parseProject(d1), JSON.parse(PKG)));

  const d2 = tmpProject({
    ...before,
    "index.js": `export function main(){}`, // stopped importing lib, dropped a/b from surface
    "lib.js": `export function a(){}`,      // b removed
  });
  const g2 = scoreGraph(d2, buildGraph(d2, parseProject(d2), JSON.parse(PKG)));

  const findings = diffGraphs(g1, g2);
  const kinds = findings.map((f) => f.kind);
  assert.ok(kinds.includes("export-removed"), `expected export-removed in ${kinds}`);
  assert.ok(findings.every((f) => f.status === "awaiting-approval"));
});

test("buildScoredGraph honors .mapdrc include/exclude and max file size", () => {
  const dir = tmpProject({
    "package.json": JSON.stringify({ name: "t", main: "src/index.js", type: "module" }),
    ".mapdrc": JSON.stringify({
      project: { include: ["src/**"], exclude: ["src/generated/**"] },
      mapping: { cache: false, maxFileSizeBytes: 80 },
    }),
    "src/index.js": `export function main(){ return 1; }\n`,
    "src/generated/client.js": `export function generated(){ return 1; }\n`,
    "src/large.js": `export function large(){ return "${"x".repeat(120)}"; }\n`,
    "scripts/tool.js": `export function tool(){ return 1; }\n`,
  });
  const g = buildScoredGraph(dir);
  const files = g.files.map((f) => f.file).sort();
  assert.deepEqual(files, ["src/index.js", "src/large.js"]);
  assert.equal(g.files.find((f) => f.file === "src/large.js").parsed, false);
  assert.equal(g.stats.unparsed, 1);
});

test("retrieval ranks by symbols, files, exports, and builds a compact task context", () => {
  const dir = tmpProject({
    "package.json": JSON.stringify({ name: "t", main: "src/server.js", type: "module" }),
    "src/server.js": `import { loginUser } from "./auth/session.js";\nexport function start(){ loginUser("a"); }\n`,
    "src/auth/session.js": `export function loginUser(email){ return email; }\nexport function logoutUser(){ return true; }\n`,
    "src/billing/invoice.js": `export function createInvoice(){ return true; }\n`,
  });
  const g = buildScoredGraph(dir);
  const hits = searchFunctions(g, "login session");
  assert.equal(hits[0].file, "src/auth/session.js");
  assert.equal(hits[0].function, "loginUser");

  const context = buildTaskContext(g, "where is login handled?", { maxHits: 4, maxFiles: 4 });
  assert.ok(context.files.some((f) => f.file === "src/auth/session.js"));
  assert.ok(context.workflows.some((wf) => wf.matchedFiles.includes("src/auth/session.js")));
});

test("buildScoredGraph persists the parse cache when mapping.cache is enabled", () => {
  const dir = tmpProject({
    "package.json": JSON.stringify({ name: "t", main: "index.js", type: "module" }),
    "index.js": `export function main(){ return 1; }\n`,
  });
  buildScoredGraph(dir);
  const cacheFile = parseCachePath(dir);
  assert.ok(fs.existsSync(cacheFile));
  const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  assert.ok(cache.entries["index.js"]);
  assert.equal(cache.entries["index.js"].node.exports[0], "main");
});
