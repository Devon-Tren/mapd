/**
 * tests/review.test.js — approval queue behavior.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadQueue, pending, transition } from "../src/core/review.js";

function projWithReports() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-rev-"));
  fs.mkdirSync(path.join(dir, ".mapd", "integration"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".mapd", "findings.json"), JSON.stringify({
    findings: [{ kind: "export-removed", severity: "high", detail: "removed x", status: "awaiting-approval" }],
  }));
  fs.writeFileSync(path.join(dir, ".mapd", "integration", "report-feature.json"), JSON.stringify({
    branch: "feature",
    conflicts: [{
      file: "greet.js",
      proposal: {
        mergedSource: "export function greet(n){ return n; }\nexport function farewell(n){ return n; }\n",
        status: "awaiting-approval",
        resolutionScore: { score: 0.9 },
        gates: [{ gate: "G1-parses-cleanly", passed: true }],
      },
    }],
  }));
  return dir;
}

test("queue lists pending items with stable content-derived IDs", () => {
  const dir = projWithReports();
  const q1 = pending(loadQueue(dir));
  const q2 = pending(loadQueue(dir));
  assert.equal(q1.length, 2);
  assert.deepEqual(q1.map((i) => i.id).sort(), q2.map((i) => i.id).sort());
});

test("dismiss removes from queue but keeps the item with reason (audit trail)", () => {
  const dir = projWithReports();
  const item = pending(loadQueue(dir)).find((i) => i.source === "check");
  const r = transition(dir, item, "dismiss", "intentional API removal");
  assert.ok(r.ok);
  assert.equal(pending(loadQueue(dir)).filter((i) => i.source === "check").length, 0);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, ".mapd", "findings.json"), "utf8"));
  assert.equal(raw.findings[0].status, "dismissed");
  assert.equal(raw.findings[0].dismissed.reason, "intentional API removal");
});

test("approving an integration proposal writes the merged file; double-approve is refused", () => {
  const dir = projWithReports();
  const item = pending(loadQueue(dir)).find((i) => i.source.startsWith("integrate:"));
  const r = transition(dir, item, "approve");
  assert.ok(r.ok);
  const written = fs.readFileSync(path.join(dir, "greet.js"), "utf8");
  assert.ok(written.includes("farewell"));
  // second approve on the same item must be refused — status moved on
  const again = transition(dir, loadQueue(dir).find((i) => i.id === item.id), "approve");
  assert.equal(again.ok, false);
});
