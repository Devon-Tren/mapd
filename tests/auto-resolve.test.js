/**
 * tests/auto-resolve.test.js — the finding lifecycle closes itself.
 * saveFindings merges against the previous report: open findings that no
 * longer reproduce become "resolved" WITH evidence (never silently dropped),
 * human dismissals are preserved for findings that still reproduce (no
 * re-nagging), and terminal entries stay visible as audit trail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveFindings } from "../src/core/regression.js";
import { stateOf } from "../src/core/review.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapd-autoresolve-"));
}

const readReport = (dir) => JSON.parse(fs.readFileSync(path.join(dir, ".mapd", "findings.json"), "utf8"));
const finding = (kind, detail, status = "awaiting-approval") => ({ severity: "high", kind, detail, evidence: {}, status });

test("an open finding that no longer reproduces is carried as resolved with re-check evidence", () => {
  const dir = tmpProject();
  saveFindings(dir, [finding("export-removed", "helper gone")]);
  const second = saveFindings(dir, []); // clean re-check

  assert.equal(second.resolvedNow, 1);
  const rep = readReport(dir);
  assert.equal(rep.findings.length, 1);
  assert.equal(rep.findings[0].status, "resolved");
  assert.equal(rep.findings[0].resolved.by, "mapd check");
  assert.match(rep.findings[0].resolved.reason, /not reproduced/);
  assert.equal(stateOf({ status: "resolved", file: path.join(dir, ".mapd", "findings.json") }), "resolved");
});

test("a still-reproducing finding a human dismissed keeps its dismissal — Map'd does not re-nag", () => {
  const dir = tmpProject();
  saveFindings(dir, [finding("export-removed", "helper gone")]);
  const rep1 = readReport(dir);
  rep1.findings[0].status = "dismissed";
  rep1.findings[0].dismissed = { at: "2026-07-01T00:00:00Z", by: "mapd review", reason: "intentional" };
  fs.writeFileSync(path.join(dir, ".mapd", "findings.json"), JSON.stringify(rep1));

  saveFindings(dir, [finding("export-removed", "helper gone")]); // reproduces again
  const rep2 = readReport(dir);
  assert.equal(rep2.findings.length, 1);
  assert.equal(rep2.findings[0].status, "dismissed");
  assert.equal(rep2.findings[0].dismissed.reason, "intentional");
});

test("new findings, resolutions, and prior terminal entries coexist in one report", () => {
  const dir = tmpProject();
  saveFindings(dir, [finding("a", "one"), finding("b", "two")]);
  // "a" resolves; "c" is new
  const r = saveFindings(dir, [finding("c", "three")]);
  assert.equal(r.resolvedNow, 2); // both a and b resolved
  const rep = readReport(dir);
  const byKind = Object.fromEntries(rep.findings.map((f) => [f.kind, f.status]));
  assert.equal(byKind.a, "resolved");
  assert.equal(byKind.b, "resolved");
  assert.equal(byKind.c, "awaiting-approval");

  // a later clean check keeps the resolved entries as audit trail
  saveFindings(dir, []);
  const rep2 = readReport(dir);
  assert.equal(rep2.findings.filter((f) => f.status === "resolved").length, 3);
});

test("first run with no previous report behaves exactly as before (no resolution, no carry-over)", () => {
  const dir = tmpProject();
  const r = saveFindings(dir, [finding("a", "one")]);
  assert.equal(r.resolvedNow, 0);
  assert.equal(readReport(dir).findings.length, 1);
});
