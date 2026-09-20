/**
 * tests/staleness.test.js — reports written by `mapd check`/`mapd modernize`
 * are re-read by review/handoff/solutions on every later run; nothing
 * previously compared their age against the current tree, so a finding
 * already fixed kept being presented as current. checkReportFreshness must
 * disclose that explicitly, never silently trust an old report.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkReportFreshness } from "../src/core/staleness.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapd-staleness-"));
}

test("checkReportFreshness: no reports on disk yet -> checked:false, not stale", () => {
  const dir = tmpProject();
  const result = checkReportFreshness(dir);
  assert.equal(result.checked, false);
  assert.equal(result.stale, false);
});

test("checkReportFreshness: a report generated after the newest source file is fresh", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "index.js"), "export function hi(){ return 1; }\n");
  fs.mkdirSync(path.join(dir, ".mapd"), { recursive: true });
  // give the filesystem a moment of separation so timestamps are unambiguous
  const past = new Date(Date.now() - 5000).toISOString();
  fs.utimesSync(path.join(dir, "index.js"), new Date(Date.now() - 10000), new Date(Date.now() - 10000));
  fs.writeFileSync(path.join(dir, ".mapd", "findings.json"), JSON.stringify({ generatedAt: new Date().toISOString(), findings: [] }));
  void past;
  const result = checkReportFreshness(dir);
  assert.equal(result.checked, true);
  assert.equal(result.stale, false);
});

test("checkReportFreshness: a source file changed after the report was generated -> stale, names the report", () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, ".mapd"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".mapd", "findings.json"), JSON.stringify({ generatedAt: new Date(Date.now() - 60_000).toISOString(), findings: [] }));
  fs.writeFileSync(path.join(dir, "index.js"), "export function hi(){ return 1; }\n"); // written just now, after the report

  const result = checkReportFreshness(dir);
  assert.equal(result.checked, true);
  assert.equal(result.stale, true);
  assert.deepEqual(result.staleReports, ["findings.json"]);
});

test("checkReportFreshness: only the actually-stale report is named when multiple reports exist at different ages", () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, ".mapd"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.js"), "export function hi(){ return 1; }\n");
  fs.utimesSync(path.join(dir, "index.js"), new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));

  fs.writeFileSync(path.join(dir, ".mapd", "findings.json"), JSON.stringify({ generatedAt: new Date(Date.now() - 60_000).toISOString(), findings: [] })); // older than source -> stale
  fs.writeFileSync(path.join(dir, ".mapd", "modernize-medium.json"), JSON.stringify({ generatedAt: new Date().toISOString(), findings: [] })); // newer than source -> fresh

  const result = checkReportFreshness(dir);
  assert.equal(result.stale, true);
  assert.deepEqual(result.staleReports, ["findings.json"]);
});

test("checkReportFreshness: a malformed report (no generatedAt) is skipped, not crashed on", () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, ".mapd"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".mapd", "findings.json"), JSON.stringify({ findings: [] }));
  const result = checkReportFreshness(dir);
  assert.equal(result.checked, false);
});
