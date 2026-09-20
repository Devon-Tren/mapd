/**
 * tests/changes.test.js — the real-tree write funnel: recording, rollback,
 * protected-path refusal, path-traversal refusal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyRealTreeWrite, loadChanges, getChange, rollbackChange } from "../src/core/changes.js";
import { recordAudit, loadAudits, getAudit } from "../src/core/audit.js";

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-changes-"));
  fs.writeFileSync(path.join(dir, "index.js"), `export function greet(){ return "hi"; }\n`);
  return dir;
}

test("applyRealTreeWrite: writes the file and records a change with before/after blobs", () => {
  const dir = tmpProject();
  const record = applyRealTreeWrite(dir, "index.js", `export function greet(){ return "hello"; }\n`, "fix");
  assert.match(fs.readFileSync(path.join(dir, "index.js"), "utf8"), /hello/);
  assert.ok(record.id);
  assert.equal(record.source, "fix");
  assert.ok(record.beforeHash);
  assert.ok(record.afterHash);

  const loaded = getChange(dir, record.id);
  assert.deepEqual(loaded, record);
  assert.equal(loadChanges(dir).length, 1);
});

test("applyRealTreeWrite: a new file has no before-blob, and rollback deletes it", () => {
  const dir = tmpProject();
  const record = applyRealTreeWrite(dir, "new-file.js", "export const x = 1;\n", "fix");
  assert.equal(record.beforePath, null);
  assert.ok(fs.existsSync(path.join(dir, "new-file.js")));

  const r = rollbackChange(dir, record.id);
  assert.equal(r.ok, true);
  assert.ok(!fs.existsSync(path.join(dir, "new-file.js")));
});

test("rollbackChange: restores prior content and is idempotent-safe (refuses double rollback)", () => {
  const dir = tmpProject();
  const record = applyRealTreeWrite(dir, "index.js", `export function greet(){ return "changed"; }\n`, "fix");
  const r1 = rollbackChange(dir, record.id);
  assert.equal(r1.ok, true);
  assert.match(fs.readFileSync(path.join(dir, "index.js"), "utf8"), /hi/);

  const r2 = rollbackChange(dir, record.id);
  assert.equal(r2.ok, false);
});

test("applyRealTreeWrite: refuses protected paths (.env) even with an explicit source", () => {
  const dir = tmpProject();
  assert.throws(() => applyRealTreeWrite(dir, ".env", "SECRET=1", "fix"), /protected path/);
  assert.throws(() => applyRealTreeWrite(dir, "secrets/creds.js", "x", "fix"), /protected path/);
});

test("applyRealTreeWrite: refuses path traversal outside the project root", () => {
  const dir = tmpProject();
  assert.throws(() => applyRealTreeWrite(dir, "../../etc/passwd", "x", "fix"));
});

test("audit: recordAudit redacts secrets and is retrievable by id", () => {
  const dir = tmpProject();
  const rec = recordAudit(dir, {
    command: "fix", initiator: "cli", finalStatus: "applied",
    contextSources: ["sk-ant-abcdefghijklmnopqrstuvwxyz1234567890"],
  });
  assert.ok(!JSON.stringify(rec).includes("sk-ant-abcdefghijklmnopqrstuvwxyz1234567890"));
  assert.equal(loadAudits(dir).length, 1);
  assert.ok(getAudit(dir, rec.id));
});
