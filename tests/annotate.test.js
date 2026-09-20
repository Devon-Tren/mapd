/**
 * tests/annotate.test.js — `mapd annotate`: annotation memory. User
 * assertions live in the project .mapdrc under project.annotations; edits
 * are validated against the schema's classification set and recorded as
 * rollback-able real-tree changes like every other mutation Map'd makes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setAnnotation, removeAnnotation, listAnnotations, loadConfig, validateConfig } from "../src/config/index.js";
import { loadChanges, rollbackChange } from "../src/core/changes.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapd-annotate-"));
}

function readRc(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, ".mapdrc"), "utf8"));
}

test("setAnnotation: creates .mapdrc when absent, records a change, and the result validates against the schema", () => {
  const dir = tmpProject();
  const r = setAnnotation(dir, "eval/results/**", "generated");
  assert.equal(r.ok, true);
  assert.equal(r.replaced, false);
  assert.ok(r.changeId, "the .mapdrc write must be recorded as a change");

  assert.deepEqual(readRc(dir).project.annotations, { "eval/results/**": "generated" });
  const { ok } = validateConfig(loadConfig(dir, { homeDir: dir }));
  assert.equal(ok, true);

  const changes = loadChanges(dir);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].file, ".mapdrc");
  assert.equal(changes[0].source, "annotate");
});

test("setAnnotation: rejects an unknown classification without touching disk", () => {
  const dir = tmpProject();
  const r = setAnnotation(dir, "x/**", "probably-dead");
  assert.equal(r.ok, false);
  assert.match(r.reason, /classification must be one of/);
  assert.equal(fs.existsSync(path.join(dir, ".mapdrc")), false);
});

test("setAnnotation: updating an existing pattern reports replaced:true and preserves other config", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, ".mapdrc"), JSON.stringify({ chat: { provider: "anthropic" }, project: { annotations: { "a/**": "generated" } } }));
  const r = setAnnotation(dir, "a/**", "dynamically-loaded");
  assert.equal(r.ok, true);
  assert.equal(r.replaced, true);
  const rc = readRc(dir);
  assert.equal(rc.project.annotations["a/**"], "dynamically-loaded");
  assert.equal(rc.chat.provider, "anthropic", "unrelated config must survive the rewrite");
});

test("setAnnotation: discloses when JSONC comments could not be preserved", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, ".mapdrc"), `// my documented config\n{ "project": { "annotations": {} } }\n`);
  const r = setAnnotation(dir, "b/**", "generated");
  assert.equal(r.ok, true);
  assert.equal(r.hadComments, true);
});

test("removeAnnotation: removes exactly one pattern; a missing pattern is an honest error", () => {
  const dir = tmpProject();
  setAnnotation(dir, "a/**", "generated");
  setAnnotation(dir, "b/**", "dynamically-loaded");

  const gone = removeAnnotation(dir, "a/**");
  assert.equal(gone.ok, true);
  assert.deepEqual(readRc(dir).project.annotations, { "b/**": "dynamically-loaded" });

  const missing = removeAnnotation(dir, "a/**");
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /no annotation for pattern/);
});

test("annotation edits are rollback-able through the standard change mechanism", () => {
  const dir = tmpProject();
  setAnnotation(dir, "a/**", "generated");
  const r = setAnnotation(dir, "b/**", "generated");
  assert.deepEqual(Object.keys(readRc(dir).project.annotations), ["a/**", "b/**"]);

  const rolled = rollbackChange(dir, r.changeId);
  assert.equal(rolled.ok, true);
  assert.deepEqual(Object.keys(readRc(dir).project.annotations), ["a/**"], "rollback must restore the pre-edit .mapdrc");
});

test("listAnnotations: returns the resolved annotation map", () => {
  const dir = tmpProject();
  setAnnotation(dir, "eval/results/**", "generated");
  // note: listAnnotations resolves through loadConfig, which also merges the
  // real user-level ~/.mapdrc; assert on the project-set key, not the whole map
  assert.equal(listAnnotations(dir)["eval/results/**"], "generated");
});
