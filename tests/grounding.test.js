/**
 * tests/grounding.test.js — the shared mechanical claim-verifier every
 * LLM-touching surface in mapd routes through (or should). Extracted from
 * solutions.js's narrateSolutions so new surfaces (chat Q&A included) get
 * the same real check instead of reinventing it or skipping it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyGrounding, buildGroundingFileList } from "../src/core/grounding.js";

test("verifyGrounding: text with no claims of a checked type is trivially grounded", () => {
  const result = verifyGrounding("This project looks reasonably clean overall.", { files: ["a.js"] });
  assert.equal(result.grounded, true);
  assert.deepEqual(result.violations, []);
});

test("verifyGrounding: a file path present in ground truth is not a violation", () => {
  const result = verifyGrounding("The issue is in src/agents/provider.js specifically.", { files: ["src/agents/provider.js", "src/cli.js"] });
  assert.equal(result.grounded, true);
});

test("verifyGrounding: a fabricated file path not in ground truth is flagged", () => {
  const result = verifyGrounding("This also affects src/auth/session.js critically.", { files: ["src/cli.js"] });
  assert.equal(result.grounded, false);
  assert.deepEqual(result.violations, [{ type: "file", value: "src/auth/session.js" }]);
});

test("verifyGrounding: a bare filename matching a real file's basename is accepted (not just full path matches)", () => {
  const result = verifyGrounding("The bug is in provider.js.", { files: ["src/agents/provider.js"] });
  assert.equal(result.grounded, true);
});

test("verifyGrounding: a real workflow ID is not a violation", () => {
  const result = verifyGrounding("This touches wf:main:src/cli.js directly.", { workflowIds: ["wf:main:src/cli.js"] });
  assert.equal(result.grounded, true);
});

test("verifyGrounding: a fabricated workflow ID is flagged", () => {
  const result = verifyGrounding("This impacts wf:main:nonexistent-entry.js.", { workflowIds: ["wf:main:src/cli.js"] });
  assert.equal(result.grounded, false);
  assert.equal(result.violations[0].type, "workflowId");
});

test("verifyGrounding: a workflow ID's own trailing filename is not double-counted as a separate bad file claim", () => {
  const result = verifyGrounding(
    "See wf:main:nonexistent-entry.js for details.",
    { workflowIds: ["wf:main:src/cli.js"], files: ["src/cli.js"] },
  );
  assert.equal(result.grounded, false);
  assert.equal(result.violations.length, 1, "must report exactly one violation (the workflow ID), not also a separate file violation for its trailing segment");
  assert.equal(result.violations[0].type, "workflowId");
});

test("verifyGrounding: a real finding ID is not a violation, when findingIds ground truth is provided", () => {
  const result = verifyGrounding("Finding d36f0dec is the highest priority.", { findingIds: ["d36f0dec", "6503d906"] });
  assert.equal(result.grounded, true);
});

test("verifyGrounding: a fabricated finding ID is flagged when findingIds ground truth is provided", () => {
  const result = verifyGrounding("Finding aaaaaaaa is critical.", { findingIds: ["d36f0dec"] });
  assert.equal(result.grounded, false);
  assert.equal(result.violations[0].type, "findingId");
});

test("verifyGrounding: a claim type never checked (no ground truth array provided) is never flagged — no false 'grounded' claim beyond what's actually verified", () => {
  const result = verifyGrounding("Finding aaaaaaaa affects src/fake.js.", { files: ["src/real.js"] });
  // findingIds not provided -> "aaaaaaaa" is not checked at all
  assert.equal(result.checkedTypes.includes("findingIds"), false);
  assert.equal(result.violations.some((v) => v.type === "findingId"), false);
  // files WAS provided -> the fabricated file must still be caught
  assert.equal(result.violations.some((v) => v.type === "file" && v.value === "src/fake.js"), true);
});

test("verifyGrounding: multiple violations across types are all reported, not just the first", () => {
  const result = verifyGrounding(
    "See src/fake.js and wf:main:fake-entry.js and finding aaaaaaaa.",
    { files: ["src/real.js"], workflowIds: ["wf:main:real.js"], findingIds: ["bbbbbbbb"] },
  );
  assert.equal(result.grounded, false);
  const types = result.violations.map((v) => v.type).sort();
  assert.deepEqual(types, ["file", "findingId", "workflowId"]);
});

test("verifyGrounding: empty ground truth (no arrays at all) checks nothing and is always grounded", () => {
  const result = verifyGrounding("This mentions src/whatever.js and wf:main:anything.js.", {});
  assert.equal(result.grounded, true);
  assert.deepEqual(result.checkedTypes, []);
});

test("buildGroundingFileList: includes real metadata files Map'd consumes, not only parsed source files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-grounding-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "index.js" }));
  fs.writeFileSync(path.join(dir, "README.md"), "# t\n");
  const files = buildGroundingFileList(dir, { files: [{ file: "index.js" }] });
  assert.ok(files.includes("index.js"));
  assert.ok(files.includes("package.json"));
  assert.ok(files.includes("README.md"));
});

// ── relation + symbol claims, checked against the parsed graph ───────────────
const miniGraph = {
  files: [
    { file: "electron/main.cjs", functions: [{ name: "boot", calls: ["require", "PlanModeOrchestrator"] }], imports: [{ source: "./plan-mode-bundle.cjs", names: ["PlanModeOrchestrator"] }], exports: [] },
    { file: "electron/plan-mode-bundle.cjs", functions: [{ name: "runPipeline", calls: [] }, { name: "PlanModeOrchestrator.prototype.run", calls: ["runPipeline"] }], imports: [], exports: ["runPipeline", "PlanModeOrchestrator"] },
  ],
};
const files = miniGraph.files.map((f) => f.file);

test("a false 'X calls Y' claim is caught against the real call graph; a true import claim verifies", () => {
  const r = verifyGrounding("`electron/main.cjs` calls `runPipeline` at startup. main.cjs imports `plan-mode-bundle.cjs`.", { files, graph: miniGraph });
  assert.deepEqual(r.violations.map((v) => v.value), ["electron/main.cjs calls runPipeline"]);
  assert.ok(r.verified.some((v) => v.type === "relation" && v.value === "electron/main.cjs imports plan-mode-bundle.cjs"));
});

test("negated relation sentences are not treated as claims", () => {
  const r = verifyGrounding("`electron/main.cjs` does not call `runPipeline` directly.", { files, graph: miniGraph });
  assert.equal(r.violations.filter((v) => v.type === "relation").length, 0);
});

test("code-shaped backticked symbols must exist in the map; plain words, flags and env vars are left alone", () => {
  const r = verifyGrounding("Uses `PlanModeOrchestrator.run`, `runPipeline()` and `inventedHelper()`. Set `ANTHROPIC_API_KEY`, run `npm`, pass `--json`.", { files, graph: miniGraph });
  assert.deepEqual(r.violations.map((v) => v.value), ["inventedHelper"]);
  assert.equal(r.verified.filter((v) => v.type === "symbol").length, 2);
});

test("technology names like Next.js / Node.js are not file claims", () => {
  const r = verifyGrounding("Built with Next.js on Node.js.", { files });
  assert.equal(r.grounded, true);
});

test("no false alarms from real answers: nouns like 'call site', JS built-ins, and Map'd's own vocabulary", () => {
  const text = "`electron/main.cjs` imports the bundle; the context doesn't show the exact call site in `main.cjs`. " +
    "Calls go through `require()` and `JSON.parse()`. The source is classified `dynamicallyLoaded`.";
  const r = verifyGrounding(text, { files, graph: miniGraph });
  assert.deepEqual(r.violations, []);
  assert.ok(r.verified.some((v) => v.type === "file"), "verified files are tallied too");
});
