/**
 * tests/config-lint.test.js — `mapd config lint` catches config that lies:
 * excluded-but-annotated, stale globs, dead excludes, unattributed assertions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lintConfig } from "../src/core/configLint.js";
import { validateConfig } from "../src/config/index.js";

function project(mapdrc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-lint-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "entry.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "entry.js"), `export function run(){ return 1; }\nrun();\n`);
  fs.writeFileSync(path.join(dir, "legacy.js"), `export function dead(){ return 2; }\n`);
  if (mapdrc) fs.writeFileSync(path.join(dir, ".mapdrc"), JSON.stringify(mapdrc));
  return dir;
}

test("clean config yields no findings", () => {
  const r = lintConfig(project(null));
  assert.equal(r.ok, true);
  assert.equal(r.findings.length, 0);
});

test("excluded-but-annotated is an error", () => {
  const r = lintConfig(project({ project: { exclude: ["legacy.js"], annotations: { "legacy.js": "entrypoint" } } }));
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.code === "excluded-but-annotated" && f.level === "error"));
  assert.ok(r.findings.every((f) => f.suggestedPatch));
});

test("stale annotation and dead exclude are warnings", () => {
  const r = lintConfig(project({ project: { exclude: ["nope/**"], annotations: { "ghost/**": "generated" } } }));
  assert.ok(r.findings.some((f) => f.code === "stale-annotation" && f.level === "warn"));
  assert.ok(r.findings.some((f) => f.code === "dead-exclude" && f.level === "warn"));
});

test("string annotation is flagged unattributed; object form with reason/source/date is not", () => {
  const strForm = lintConfig(project({ project: { annotations: { "entry.js": "intentional-dormant" } } }));
  assert.ok(strForm.findings.some((f) => f.code === "unattributed-annotation"));

  const objForm = lintConfig(project({ project: { annotations: { "entry.js": { classification: "intentional-dormant", reason: "legacy shim", source: "PR-12", date: "2026-07-14" } } } }));
  assert.ok(!objForm.findings.some((f) => f.code.includes("attribut")), "fully-attributed annotation needs no attribution advice");
});

test("object-form annotation passes schema validation (backward-compatible extension)", () => {
  const okObj = validateConfig({ project: { annotations: { "x.js": { classification: "generated", reason: "r" } } } });
  assert.equal(okObj.ok, true);
  const badField = validateConfig({ project: { annotations: { "x.js": { classification: "generated", nope: 1 } } } });
  assert.equal(badField.ok, false);
  const badCls = validateConfig({ project: { annotations: { "x.js": { classification: "not-real" } } } });
  assert.equal(badCls.ok, false);
});
