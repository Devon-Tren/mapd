/**
 * tests/polyglot.test.js — heuristic language adapters (polyglot.js). The
 * honesty contract under test: files are genuinely mapped (functions,
 * existence-checked import edges, verified entry markers), every node is
 * marked parserKind:"heuristic", confidence discounts them, unreached ones
 * are NEVER asserted orphaned, and the .mapdrc kill switch reverts them to
 * the old honest "unsupported" bucket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProject } from "../src/core/parser.js";
import { buildGraph } from "../src/core/graph.js";
import { scoreGraph } from "../src/core/confidence.js";
import { parsePolyglotFile } from "../src/core/polyglot.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapd-polyglot-"));
}

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

const graphOf = (dir, opts = {}) => buildGraph(dir, parseProject(dir, opts), null, opts);

// ---- python ----------------------------------------------------------------

test("python: __main__ guard is an entry, imports resolve to real files, and a workflow forms", () => {
  const dir = tmpProject();
  write(dir, "app.py", `import util\nfrom pkg import thing\n\ndef run():\n    pass\n\nif __name__ == "__main__":\n    run()\n`);
  write(dir, "util.py", `def helper():\n    return 1\n\ndef _private():\n    return 2\n`);
  write(dir, "pkg/__init__.py", `def thing():\n    return 3\n`);

  const g = graphOf(dir);
  const entry = g.entryPoints.find((e) => e.kind === "python-main-guard");
  assert.ok(entry, "the __main__ guard must register app.py as an entry point");
  const wf = g.workflows.find((w) => w.entry.file === "app.py");
  assert.ok(wf.files.includes("util.py"), "import util must resolve to util.py");
  assert.ok(wf.files.includes("pkg/__init__.py"), "from pkg import ... must resolve to the package __init__");

  const util = g.files.find((f) => f.file === "util.py");
  assert.equal(util.parserKind, "heuristic");
  assert.ok(util.exports.includes("helper"));
  assert.ok(!util.exports.includes("_private"), "underscore-prefixed defs are not public surface");
});

test("python: relative imports (from .sibling import x) resolve within the package", () => {
  const dir = tmpProject();
  write(dir, "pkg/a.py", `from .b import go\n`);
  write(dir, "pkg/b.py", `def go():\n    pass\n`);
  const g = graphOf(dir);
  assert.ok(g.importEdges.some((e) => e.from === "pkg/a.py" && e.to === "pkg/b.py"));
});

// ---- go --------------------------------------------------------------------

test("go: package main + func main is an entry; package-path imports link to that directory's files", () => {
  const dir = tmpProject();
  write(dir, "main.go", `package main\n\nimport (\n\t"example.com/app/store"\n)\n\nfunc main() {\n}\n`);
  write(dir, "store/store.go", `package store\n\nfunc Open() {}\n\nfunc close() {}\n`);

  const g = graphOf(dir);
  assert.ok(g.entryPoints.some((e) => e.kind === "go-main"));
  assert.ok(g.importEdges.some((e) => e.from === "main.go" && e.to === "store/store.go"));
  const store = g.files.find((f) => f.file === "store/store.go");
  assert.ok(store.exports.includes("Open"), "capitalized Go funcs are exported");
  assert.ok(!store.exports.includes("close"), "lowercase Go funcs are package-private");
});

// ---- rust ------------------------------------------------------------------

test("rust: mod declarations resolve to sibling files and main.rs registers as entry", () => {
  const dir = tmpProject();
  write(dir, "src/main.rs", `mod store;\n\nfn main() {\n    store::open();\n}\n`);
  write(dir, "src/store.rs", `pub fn open() {}\n\nfn internal() {}\n`);
  const g = graphOf(dir);
  assert.ok(g.entryPoints.some((e) => e.kind === "rust-main"));
  assert.ok(g.importEdges.some((e) => e.from === "src/main.rs" && e.to === "src/store.rs"));
  const store = g.files.find((f) => f.file === "src/store.rs");
  assert.ok(store.exports.includes("open"));
  assert.ok(!store.exports.includes("internal"));
});

// ---- ruby / java / php ------------------------------------------------------

test("ruby: require_relative resolves; java: import resolves by package-path suffix; php: require resolves", () => {
  const dir = tmpProject();
  write(dir, "cli.rb", `#!/usr/bin/env ruby\nrequire_relative "lib/tool"\n\ndef run\nend\n`);
  write(dir, "lib/tool.rb", `def tool\nend\n`);
  write(dir, "src/com/x/Main.java", `package com.x;\nimport com.x.Store;\npublic class Main {\n  public static void main(String[] args) {}\n}\n`);
  write(dir, "src/com/x/Store.java", `package com.x;\npublic class Store {}\n`);
  write(dir, "index.php", `<?php\nrequire __DIR__ . '/lib/db.php';\nfunction main() {}\n`);
  write(dir, "lib/db.php", `<?php\nfunction connect() {}\n`);

  const g = graphOf(dir);
  assert.ok(g.importEdges.some((e) => e.from === "cli.rb" && e.to === "lib/tool.rb"));
  assert.ok(g.entryPoints.some((e) => e.kind === "shebang" && e.file === "cli.rb"));
  assert.ok(g.importEdges.some((e) => e.from === "src/com/x/Main.java" && e.to === "src/com/x/Store.java"));
  assert.ok(g.entryPoints.some((e) => e.kind === "java-main"));
  assert.ok(g.importEdges.some((e) => e.from === "index.php" && e.to === "lib/db.php"));
});

// ---- honesty contract -------------------------------------------------------

test("no fabricated edges: an import whose target file does not exist never resolves", () => {
  const dir = tmpProject();
  write(dir, "app.py", `import missing_module\n\ndef run():\n    pass\n`);
  const g = graphOf(dir);
  assert.ok(!g.importEdges.some((e) => e.from === "app.py" && e.to), "no internal edge may exist to a nonexistent file");
});

test("kill switch: parseProject polyglot:false reverts these languages to the unsupported bucket", () => {
  const dir = tmpProject();
  write(dir, "app.py", `def run():\n    pass\n`);
  const on = parseProject(dir);
  assert.equal(on.files.filter((f) => f.file === "app.py").length, 1);
  const off = parseProject(dir, { polyglot: false });
  assert.equal(off.files.filter((f) => f.file === "app.py").length, 0);
  assert.deepEqual(off.unsupported, ["app.py"]);
});

test("uncovered heuristic files are heuristic-unverified, never asserted orphaned", () => {
  const dir = tmpProject();
  write(dir, "index.js", `export function main(){ return 1; }\n`);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "index.js" }));
  write(dir, "loose.py", `def maybe_used_by_cron():\n    pass\n`);

  const g = buildGraph(dir, parseProject(dir), JSON.parse(fs.readFileSync(path.join(dir, "package.json"))), {});
  assert.ok(!g.orphans.includes("loose.py"), "a heuristic-parsed file must never be claimed orphaned");
  const entry = g.reachability.heuristicUnverified.find((h) => h.file === "loose.py");
  assert.ok(entry);
  assert.match(entry.reason, /orphan status cannot be asserted/);
});

test("confidence: a heuristic-only workflow earns half parseIntegrity credit and stats disclose the count", () => {
  const dir = tmpProject();
  write(dir, "app.py", `def run():\n    pass\n\nif __name__ == "__main__":\n    run()\n`);
  const g = scoreGraph(dir, graphOf(dir));
  assert.equal(g.stats.heuristicFileCount, 1);
  const wf = g.workflows.find((w) => w.entry.file === "app.py");
  assert.equal(wf.confidence.signals.parseIntegrity.value, 0.5, "heuristic files earn exactly half parse-integrity credit");
});

test("parsePolyglotFile: unreadable or unknown input degrades to an honest unparsed node, never a throw", () => {
  const node = parsePolyglotFile("/nonexistent/nope.py", "nope.py");
  assert.equal(node.parsed, false);
  assert.equal(node.parserKind, "heuristic");
  assert.deepEqual(node.functions, []);
});
