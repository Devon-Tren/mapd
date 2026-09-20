/**
 * tests/evidence.test.js — `mapd evidence <id>`: every meaningful claim must
 * be able to show the deterministic data behind it. The evidence view only
 * assembles what reports/proposals/graph/config already recorded — nothing
 * inferred, nothing fabricated, and an unknown ID returns null rather than
 * a guessed view.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFindingEvidence, renderFindingEvidence } from "../src/core/evidence.js";
import { loadQueue } from "../src/core/review.js";

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-evidence-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), `import { helper } from "./lib.js";\nexport function main(){ return helper(); }\n`);
  fs.writeFileSync(path.join(dir, "lib.js"), `export function helper(){ return 1; }\n`);
  backdate(dir);
  return dir;
}

/** Push every fixture file's mtime 10s into the past so a report written "now" is unambiguously fresh. */
function backdate(dir) {
  const past = new Date(Date.now() - 10_000);
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isFile()) fs.utimesSync(p, past, past);
  }
}

function writeFindings(dir, findings) {
  fs.mkdirSync(path.join(dir, ".mapd"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".mapd", "findings.json"), JSON.stringify({ generatedAt: new Date().toISOString(), findings }));
}

test("buildFindingEvidence: unknown ID returns null, never a fabricated view", () => {
  const dir = tmpProject();
  assert.equal(buildFindingEvidence(dir, "deadbeef"), null);
});

test("buildFindingEvidence: a check finding's evidence includes graph-backed file context and freshness", () => {
  const dir = tmpProject();
  writeFindings(dir, [
    { severity: "high", kind: "confidence-drop", detail: "confidence fell", evidence: { files: ["lib.js"] }, status: "awaiting-approval" },
  ]);
  const id = loadQueue(dir)[0].id;
  const data = buildFindingEvidence(dir, id);

  assert.equal(data.evidenceType, "finding");
  assert.equal(data.state, "active");
  assert.equal(data.report.stale, false);
  assert.equal(data.severity, "high");
  assert.ok(data.priority > 0);
  assert.equal(data.files.length, 1);
  assert.equal(data.files[0].file, "lib.js");
  assert.equal(data.files[0].classification, "reachable");
  assert.ok(data.files[0].workflows.length >= 1, "lib.js is imported from the entry, so it must have workflow membership");
  assert.equal(data.proposal, null, "no fix proposal exists yet — must be reported absent, not invented");

  const text = renderFindingEvidence(data);
  assert.match(text, /lib\.js/);
  assert.match(text, /state: active/);
  assert.match(text, /fix proposal: none yet/);
});

test("buildFindingEvidence: user annotations on evidence files are surfaced as assertions", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, ".mapdrc"), JSON.stringify({ project: { annotations: { "lib.js": "dynamically-loaded" } } }));
  backdate(dir);
  writeFindings(dir, [
    { severity: "medium", kind: "x", detail: "d", evidence: { files: ["lib.js"] }, status: "awaiting-approval" },
  ]);
  const id = loadQueue(dir)[0].id;
  const data = buildFindingEvidence(dir, id);
  assert.equal(data.userAnnotations.length, 1);
  assert.equal(data.userAnnotations[0].classification, "dynamically-loaded");
  assert.match(renderFindingEvidence(data), /user annotations \(asserted in \.mapdrc, not auto-detected\)/);
});

test("buildFindingEvidence: a stale report is disclosed on the evidence view itself", () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, ".mapd"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".mapd", "findings.json"), JSON.stringify({
    generatedAt: new Date(Date.now() - 60_000).toISOString(),
    findings: [{ severity: "low", kind: "y", detail: "old", evidence: { files: ["index.js"] }, status: "awaiting-approval" }],
  }));
  fs.writeFileSync(path.join(dir, "index.js"), `export function main(){ return 2; }\n`); // newer than the report

  const id = loadQueue(dir)[0].id;
  const data = buildFindingEvidence(dir, id);
  assert.equal(data.report.stale, true);
  assert.equal(data.state, "stale");
  assert.match(renderFindingEvidence(data), /STALE/);
});

test("buildFindingEvidence: a saved fix proposal's recorded gate history is included, not re-run", () => {
  const dir = tmpProject();
  writeFindings(dir, [
    { severity: "high", kind: "z", detail: "needs fix", evidence: { files: ["lib.js"] }, status: "awaiting-approval" },
  ]);
  const id = loadQueue(dir)[0].id;
  fs.mkdirSync(path.join(dir, ".mapd", "proposals"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".mapd", "proposals", `${id}.json`), JSON.stringify({
    findingId: id, status: "awaiting-approval", stopReason: "gates-passed",
    filesPatch: { "lib.js": "export function helper(){ return 2; }\n" },
    attempts: [{ attempt: 1, passed: true, gates: [{ gate: "parse", passed: true }] }],
  }));
  const data = buildFindingEvidence(dir, id);
  assert.equal(data.proposal.status, "awaiting-approval");
  assert.equal(data.proposal.attempts.length, 1);
  assert.deepEqual(data.proposal.files, ["lib.js"]);
});
