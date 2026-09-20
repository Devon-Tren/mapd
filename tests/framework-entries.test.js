/**
 * tests/framework-entries.test.js — Next.js/Vite/Electron/NestJS entry-point
 * detection. Every detector must either verify a real match or find nothing
 * — never fabricate an entry pointing at a file that doesn't exist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectNextJsEntries, detectHtmlEntries, detectViteEntries, detectElectronPreloadEntries, detectToolingConfigEntries } from "../src/core/frameworkEntries.js";
import { parseProject } from "../src/core/parser.js";
import { buildGraph, loadPkg } from "../src/core/graph.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapd-fw-"));
}

// ---- Next.js --------------------------------------------------------------

test("detectNextJsEntries: recognizes Pages Router pages and API routes, excludes _app/_document", () => {
  const fileSet = new Set(["pages/index.js", "pages/about.tsx", "pages/api/users.ts", "pages/_app.tsx", "pages/_document.tsx"]);
  const entries = detectNextJsEntries(fileSet);
  const files = entries.map((e) => e.file).sort();
  assert.deepEqual(files, ["pages/about.tsx", "pages/api/users.ts", "pages/index.js"]);
  assert.equal(entries.find((e) => e.file === "pages/api/users.ts").kind, "nextjs-api-route");
  assert.equal(entries.find((e) => e.file === "pages/index.js").kind, "nextjs-page");
});

test("detectNextJsEntries: recognizes App Router page/route/layout files nested anywhere under app/", () => {
  const fileSet = new Set(["app/page.tsx", "app/dashboard/page.tsx", "app/api/hello/route.ts", "app/layout.tsx", "app/dashboard/component.tsx"]);
  const entries = detectNextJsEntries(fileSet);
  const files = entries.map((e) => e.file).sort();
  assert.deepEqual(files, ["app/api/hello/route.ts", "app/dashboard/page.tsx", "app/layout.tsx", "app/page.tsx"]);
  assert.ok(!files.includes("app/dashboard/component.tsx"), "a plain component file must not be treated as an entry point");
});

test("detectNextJsEntries: finds nothing in a non-Next.js project (no false positives)", () => {
  const fileSet = new Set(["src/index.js", "src/utils.js"]);
  assert.deepEqual(detectNextJsEntries(fileSet), []);
});

// ---- HTML (Vite's default entry convention — no explicit rollupOptions.input) ----

test("detectHtmlEntries: resolves a root-relative <script type=\"module\"> src (the standard Vite default convention)", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "index.html"), `<!DOCTYPE html>
<html><body><div id="root"></div>
<script type="module" src="/src/main.jsx"></script>
</body></html>`);
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/main.jsx"), "export const x = 1;\n");
  const fileSet = new Set(["index.html", "src/main.jsx"]);
  const entries = detectHtmlEntries(dir, fileSet);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].file, "src/main.jsx");
  assert.equal(entries[0].kind, "html-module-entry");
});

test("detectHtmlEntries: resolves a directory-relative script src too", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "index.html"), `<script type="module" src="./main.js"></script>`);
  fs.writeFileSync(path.join(dir, "main.js"), "export const x = 1;\n");
  const fileSet = new Set(["index.html", "main.js"]);
  const entries = detectHtmlEntries(dir, fileSet);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].file, "main.js");
});

test("detectHtmlEntries: ignores non-module scripts and external URLs, never fabricates an entry for a missing file", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "index.html"), `
    <script src="https://cdn.example.com/analytics.js"></script>
    <script src="./legacy.js"></script>
    <script type="module" src="/src/missing.jsx"></script>
  `);
  const fileSet = new Set(["index.html"]);
  assert.deepEqual(detectHtmlEntries(dir, fileSet), []);
});

test("detectHtmlEntries: attribute order (src before type) still matches", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "index.html"), `<script src="/src/main.ts" type="module"></script>`);
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/main.ts"), "export const x = 1;\n");
  const fileSet = new Set(["index.html", "src/main.ts"]);
  const entries = detectHtmlEntries(dir, fileSet);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].file, "src/main.ts");
});

test("detectHtmlEntries: no HTML file present -> no entries, no error", () => {
  const dir = tmpProject();
  assert.deepEqual(detectHtmlEntries(dir, new Set()), []);
});

// ---- Vite -------------------------------------------------------------------

test("detectViteEntries: resolves build.rollupOptions.input string entries that actually exist", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "vite.config.ts"), `
    export default {
      build: { rollupOptions: { input: "./src/main.ts" } },
    };
  `);
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/main.ts"), "export const x = 1;\n");
  const fileSet = new Set(["vite.config.ts", "src/main.ts"]);
  const entries = detectViteEntries(dir, fileSet);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].file, "src/main.ts");
  assert.equal(entries[0].kind, "vite-entry");
});

test("detectViteEntries: resolves multiple named entries (Electron main/preload/renderer pattern)", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "vite.config.js"), `
    export default {
      build: { rollupOptions: { input: { main: "./src/main.ts", preload: "./src/preload.ts" } } },
    };
  `);
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/main.ts"), "export const x = 1;\n");
  fs.writeFileSync(path.join(dir, "src/preload.ts"), "export const y = 2;\n");
  const fileSet = new Set(["vite.config.js", "src/main.ts", "src/preload.ts"]);
  const entries = detectViteEntries(dir, fileSet);
  assert.deepEqual(entries.map((e) => e.file).sort(), ["src/main.ts", "src/preload.ts"]);
});

test("detectViteEntries: never fabricates an entry when the referenced file doesn't actually exist", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "vite.config.ts"), `
    export default { build: { rollupOptions: { input: "./src/does-not-exist.ts" } } };
  `);
  const fileSet = new Set(["vite.config.ts"]);
  assert.deepEqual(detectViteEntries(dir, fileSet), []);
});

test("detectViteEntries: does not mistake an unrelated 'input' key for a Vite entry (anchored on the rollupOptions parent)", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "vite.config.ts"), `
    export default { someOtherConfig: { input: "./src/main.ts" } };
  `);
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/main.ts"), "export const x = 1;\n");
  const fileSet = new Set(["vite.config.ts", "src/main.ts"]);
  assert.deepEqual(detectViteEntries(dir, fileSet), [], "an 'input' key outside rollupOptions must not be treated as an entry");
});

test("detectViteEntries: no vite.config file present -> no entries, no error", () => {
  const dir = tmpProject();
  assert.deepEqual(detectViteEntries(dir, new Set()), []);
});

// ---- Electron ---------------------------------------------------------------

test("detectElectronPreloadEntries: resolves path.join(__dirname, ...) preload references", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "main.js"), `
    import { BrowserWindow } from "electron";
    import path from "node:path";
    function createWindow() {
      new BrowserWindow({ webPreferences: { preload: path.join(__dirname, "preload.js") } });
    }
  `);
  fs.writeFileSync(path.join(dir, "preload.js"), "export const bridge = 1;\n");
  const parsed = parseProject(dir);
  const fileSet = new Set(parsed.files.map((f) => f.file));
  const entries = detectElectronPreloadEntries(dir, parsed.files, fileSet);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].file, "preload.js");
  assert.equal(entries[0].kind, "electron-preload");
});

test("detectElectronPreloadEntries: resolves a plain string literal preload path", () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, "electron"));
  fs.writeFileSync(path.join(dir, "electron/main.js"), `
    import { BrowserWindow } from "electron";
    new BrowserWindow({ webPreferences: { preload: "./preload.js" } });
  `);
  fs.writeFileSync(path.join(dir, "electron/preload.js"), "export const bridge = 1;\n");
  const parsed = parseProject(dir);
  const fileSet = new Set(parsed.files.map((f) => f.file));
  const entries = detectElectronPreloadEntries(dir, parsed.files, fileSet);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].file, "electron/preload.js");
});

test("detectElectronPreloadEntries: never fabricates when the preload path can't be verified (e.g. a variable reference)", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "main.js"), `
    import { BrowserWindow } from "electron";
    const preloadPath = computePreloadPath();
    new BrowserWindow({ webPreferences: { preload: preloadPath } });
  `);
  const parsed = parseProject(dir);
  const fileSet = new Set(parsed.files.map((f) => f.file));
  const entries = detectElectronPreloadEntries(dir, parsed.files, fileSet);
  assert.deepEqual(entries, [], "an unresolvable dynamic preload reference must not be guessed at");
});

// ---- NestJS decorators (via the full parser + graph pipeline) ---------------

test("NestJS @Get()/@Post() method decorators become detected entry points connected to a workflow", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", type: "module" }));
  fs.writeFileSync(path.join(dir, "cats.controller.ts"), `
    import { Controller, Get, Post } from "@nestjs/common";
    @Controller("cats")
    export class CatsController {
      @Get()
      findAll() { return []; }

      @Post()
      create() { return null; }
    }
  `);
  const parsed = parseProject(dir);
  const catsFile = parsed.files.find((f) => f.file === "cats.controller.ts");
  assert.equal(catsFile.parsed, true, "decorator syntax must parse cleanly");
  assert.equal(catsFile.decoratorRoutes.length, 2);
  assert.ok(catsFile.decoratorRoutes.some((r) => r.decorator === "Get" && r.class === "CatsController" && r.method === "findAll"));

  const graph = buildGraph(dir, parsed, loadPkg(dir));
  const workflow = graph.workflows.find((w) => w.entry.kind === "nestjs-route");
  assert.ok(workflow, "a NestJS route decorator must produce a real workflow entry point");
  assert.ok(workflow.files.includes("cats.controller.ts"));
});

// ---- Tooling configs (read by an external tool, not imported by app code) ---

test("detectToolingConfigEntries: recognizes playwright/jest/vitest/cypress/pm2 config conventions at project root", () => {
  const fileSet = new Set([
    "playwright.config.ts", "jest.config.js", "vitest.config.js", "cypress.config.js", "ecosystem.config.js",
    "src/server.js",
  ]);
  const entries = detectToolingConfigEntries(fileSet);
  const kinds = Object.fromEntries(entries.map((e) => [e.file, e.kind]));
  assert.equal(kinds["playwright.config.ts"], "playwright-config");
  assert.equal(kinds["jest.config.js"], "jest-config");
  assert.equal(kinds["vitest.config.js"], "vitest-config");
  assert.equal(kinds["cypress.config.js"], "cypress-config");
  assert.equal(kinds["ecosystem.config.js"], "pm2-ecosystem");
  assert.ok(!("src/server.js" in kinds));
});

test("detectToolingConfigEntries: ignores same-named files nested in subdirectories (convention is root-only)", () => {
  const fileSet = new Set(["nested/playwright.config.ts"]);
  assert.deepEqual(detectToolingConfigEntries(fileSet), []);
});

test("detectToolingConfigEntries: a tooling config registered as an entry makes its own imports reachable, not just itself", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", type: "module" }));
  fs.writeFileSync(path.join(dir, "playwright.config.ts"), `import { helper } from "./e2e/helper.js";\nexport default { use: helper };\n`);
  fs.mkdirSync(path.join(dir, "e2e"));
  fs.writeFileSync(path.join(dir, "e2e/helper.js"), "export function helper(){ return 1; }\n");
  const parsed = parseProject(dir);
  const graph = buildGraph(dir, parsed, loadPkg(dir));
  assert.ok(!graph.orphans.includes("playwright.config.ts"), "the config file itself must not be flagged as an orphan");
  assert.ok(!graph.orphans.includes("e2e/helper.js"), "a file only imported by a tooling config must be reachable through it, not orphaned");
});
