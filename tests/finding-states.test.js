/**
 * tests/finding-states.test.js — the master prompt requires active, stale,
 * approved, resolved, dismissed, and historical finding states to be obvious.
 * States are DERIVED (status + report freshness), never stored: staleness can
 * change with every file save, so a persisted state would overclaim.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateOf, loadQueueWithStates, loadQueue } from "../src/core/review.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapd-states-"));
}

function writeFindings(dir, findings, generatedAt = new Date().toISOString()) {
  fs.mkdirSync(path.join(dir, ".mapd"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".mapd", "findings.json"), JSON.stringify({ generatedAt, findings }));
}

test("stateOf: maps every raw status onto the documented state vocabulary", () => {
  const item = (status) => ({ status, file: "/x/.mapd/findings.json" });
  assert.equal(stateOf(item("awaiting-approval")), "active");
  assert.equal(stateOf(item("awaiting-approval"), ["findings.json"]), "stale");
  assert.equal(stateOf(item("approved")), "approved");
  assert.equal(stateOf(item("approved-applied")), "resolved");
  assert.equal(stateOf(item("dismissed")), "dismissed");
  assert.equal(stateOf(item("rolled-back-after-apply")), "historical");
  assert.equal(stateOf(item("post-apply-failed-rollback-incomplete")), "historical");
});

test("stateOf: staleness only marks items whose OWN source report is stale", () => {
  const checkItem = { status: "awaiting-approval", file: "/x/.mapd/findings.json" };
  const modernizeItem = { status: "awaiting-approval", file: "/x/.mapd/modernize-medium.json" };
  assert.equal(stateOf(checkItem, ["modernize-medium.json"]), "active");
  assert.equal(stateOf(modernizeItem, ["modernize-medium.json"]), "stale");
});

test("loadQueueWithStates: a finding from a report older than the newest source file is stale, a fresh one is active", () => {
  const dir = tmpProject();
  // report written 60s in the past, source file written now → stale
  writeFindings(dir, [
    { severity: "high", kind: "workflow-removed", detail: "wf gone", evidence: { files: ["index.js"] }, status: "awaiting-approval" },
  ], new Date(Date.now() - 60_000).toISOString());
  fs.writeFileSync(path.join(dir, "index.js"), "export function hi(){ return 1; }\n");

  const { items, freshness } = loadQueueWithStates(dir);
  assert.equal(items.length, 1);
  assert.equal(items[0].state, "stale");
  assert.equal(freshness.stale, true);

  // regenerate the report after the source change → active (backdate the
  // source first so same-millisecond mtimes can't make this comparison racy)
  fs.utimesSync(path.join(dir, "index.js"), new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
  writeFindings(dir, [
    { severity: "high", kind: "workflow-removed", detail: "wf gone", evidence: { files: ["index.js"] }, status: "awaiting-approval" },
  ]);
  const refreshed = loadQueueWithStates(dir);
  assert.equal(refreshed.items[0].state, "active");
});

test("loadQueueWithStates: dismissed and applied findings surface their terminal states", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "index.js"), "export function hi(){ return 1; }\n");
  writeFindings(dir, [
    { severity: "high", kind: "a", detail: "one", status: "dismissed" },
    { severity: "low", kind: "b", detail: "two", status: "approved" },
  ]);
  const { items } = loadQueueWithStates(dir);
  const byKind = Object.fromEntries(items.map((i) => [i.kind, i.state]));
  assert.equal(byKind.a, "dismissed");
  assert.equal(byKind.b, "approved");
});

test("loadQueueWithStates: items carry the exact same fields as loadQueue plus state", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "index.js"), "export function hi(){ return 1; }\n");
  writeFindings(dir, [{ severity: "high", kind: "a", detail: "one", status: "awaiting-approval" }]);
  const plain = loadQueue(dir);
  const { items } = loadQueueWithStates(dir);
  assert.deepEqual({ ...items[0], state: undefined }, { ...plain[0], state: undefined });
  assert.ok(["active", "stale"].includes(items[0].state));
});
