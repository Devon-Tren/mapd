/**
 * tests/import-resolver.test.js — the toolchain-aware import resolver.
 * Every alias mapd can't resolve becomes a false "unresolved edge" that
 * depresses call resolution and inflates orphan candidates, so resolution
 * must work the way the project's OWN config says it works — and a miss
 * must stay an honest miss (unresolved), never a fabricated internal edge.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createImportResolver, loadPathAliases } from "../src/core/importResolver.js";
import { parseProject } from "../src/core/parser.js";
import { buildGraph, loadPkg } from "../src/core/graph.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapd-resolver-"));
}

// ---- tsconfig/jsconfig paths ----

test("tsconfig paths: a wildcard alias (@/*) resolves to the real file", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
  const fileSet = new Set(["src/utils/helper.ts", "main.ts"]);
  const r = createImportResolver(dir, fileSet, {});
  assert.deepEqual(r.resolve("main.ts", "@/utils/helper"), { internal: "src/utils/helper.ts" });
});

test("tsconfig paths: an exact (non-wildcard) alias resolves", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@db": ["src/db/index.ts"] } } }));
  const fileSet = new Set(["src/db/index.ts"]);
  const r = createImportResolver(dir, fileSet, {});
  assert.deepEqual(r.resolve("main.ts", "@db"), { internal: "src/db/index.ts" });
});

test("tsconfig paths: baseUrl is respected when resolving targets", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: "src", paths: { "~/*": ["*"] } } }));
  const fileSet = new Set(["src/engine/core.ts"]);
  const r = createImportResolver(dir, fileSet, {});
  assert.deepEqual(r.resolve("src/main.ts", "~/engine/core"), { internal: "src/engine/core.ts" });
});

test("tsconfig paths: a matched alias whose target file doesn't exist stays honestly unresolved — never external, never fabricated", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*"] } } }));
  const r = createImportResolver(dir, new Set(["main.ts"]), {});
  assert.deepEqual(r.resolve("main.ts", "@/does-not-exist"), { unresolved: "@/does-not-exist" });
});

test("tsconfig with JSONC comments and trailing commas is tolerated", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "tsconfig.json"), `{
    // path aliases for the app
    "compilerOptions": {
      "baseUrl": ".",
      "paths": {
        "@/*": ["src/*"], /* main alias */
      },
    },
  }`);
  const aliases = loadPathAliases(dir);
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0].keyPrefix, "@/");
});

test("jsconfig.json works as the fallback when there's no tsconfig", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "jsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@lib/*": ["lib/*"] } } }));
  const fileSet = new Set(["lib/util.js"]);
  const r = createImportResolver(dir, fileSet, {});
  assert.deepEqual(r.resolve("app.js", "@lib/util"), { internal: "lib/util.js" });
});

test("no tsconfig at all: bare specifiers stay external, relative resolution unchanged", () => {
  const dir = tmpProject();
  const fileSet = new Set(["src/a.js", "src/b.js"]);
  const r = createImportResolver(dir, fileSet, {});
  assert.deepEqual(r.resolve("src/a.js", "lodash"), { external: "lodash" });
  assert.deepEqual(r.resolve("src/a.js", "./b.js"), { internal: "src/b.js" });
});

// ---- package.json imports (#-prefixed) ----

test("package.json imports: exact #-alias resolves", () => {
  const dir = tmpProject();
  const pkg = { imports: { "#db": "./src/db.js" } };
  const r = createImportResolver(dir, new Set(["src/db.js"]), pkg);
  assert.deepEqual(r.resolve("main.js", "#db"), { internal: "src/db.js" });
});

test("package.json imports: wildcard #-alias with a conditions object resolves", () => {
  const dir = tmpProject();
  const pkg = { imports: { "#utils/*": { node: "./src/utils/*.js", default: "./src/utils/*.js" } } };
  const r = createImportResolver(dir, new Set(["src/utils/fmt.js"]), pkg);
  assert.deepEqual(r.resolve("main.js", "#utils/fmt"), { internal: "src/utils/fmt.js" });
});

test("package.json imports: an unmatched #-spec is unresolved, never external — Node reserves # for internal imports", () => {
  const dir = tmpProject();
  const r = createImportResolver(dir, new Set(["main.js"]), { imports: { "#db": "./src/db.js" } });
  assert.deepEqual(r.resolve("main.js", "#nonexistent"), { unresolved: "#nonexistent" });
});

// ---- package.json exports self-reference ----

test("package.json exports: importing the package's own name resolves through the exports map", () => {
  const dir = tmpProject();
  const pkg = { name: "mylib", exports: { ".": "./src/index.js", "./helpers": "./src/helpers.js" } };
  const r = createImportResolver(dir, new Set(["src/index.js", "src/helpers.js"]), pkg);
  assert.deepEqual(r.resolve("tests/x.test.js", "mylib"), { internal: "src/index.js" });
  assert.deepEqual(r.resolve("tests/x.test.js", "mylib/helpers"), { internal: "src/helpers.js" });
});

// ---- TS-ESM extension rewriting ----

test("TS node16 convention: `import './x.js'` resolves to x.ts on disk", () => {
  const dir = tmpProject();
  const fileSet = new Set(["src/main.ts", "src/engine.ts", "src/view.tsx"]);
  const r = createImportResolver(dir, fileSet, {});
  assert.deepEqual(r.resolve("src/main.ts", "./engine.js"), { internal: "src/engine.ts" });
  assert.deepEqual(r.resolve("src/main.ts", "./view.js"), { internal: "src/view.tsx" });
});

test("extension swap prefers a real .js file when both .js and .ts exist (the literal match wins)", () => {
  const dir = tmpProject();
  const fileSet = new Set(["src/main.ts", "src/engine.js", "src/engine.ts"]);
  const r = createImportResolver(dir, fileSet, {});
  assert.deepEqual(r.resolve("src/main.ts", "./engine.js"), { internal: "src/engine.js" });
});

// ---- end-to-end through buildGraph ----

test("end-to-end: a tsconfig-aliased import produces a real internal edge, connects the workflow, and prevents a false orphan", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "src/main.ts", type: "module" }));
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
  fs.mkdirSync(path.join(dir, "src", "engine"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "main.ts"), `import { run } from "@/engine/core.js";\nrun();\n`);
  fs.writeFileSync(path.join(dir, "src", "engine", "core.ts"), "export function run(){ return 1; }\n");

  const parsed = parseProject(dir);
  const graph = buildGraph(dir, parsed, loadPkg(dir));

  const edge = graph.importEdges.find((e) => e.from === "src/main.ts");
  assert.equal(edge.to, "src/engine/core.ts", "the aliased import (alias + .js->.ts swap combined) must resolve to a real internal edge");
  assert.ok(!graph.orphans.includes("src/engine/core.ts"), "the alias target must be workflow-connected, not a false orphan");
  const mainWf = graph.workflows.find((w) => w.entry.file === "src/main.ts");
  assert.ok(mainWf.files.includes("src/engine/core.ts"));
});
