/**
 * tests/retry.test.js — retry engine stopping rules and gate-feedback shape.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithRetry, buildRetryFeedback } from "../src/core/retry.js";

test("buildRetryFeedback: null when all gates passed", () => {
  assert.equal(buildRetryFeedback([{ gate: "G1-parses-cleanly", passed: true }]), null);
});

test("buildRetryFeedback: names the failed gate and missing symbols deterministically", () => {
  const fb = buildRetryFeedback([
    { gate: "G1-parses-cleanly", passed: true },
    { gate: "G2-export-union-preserved", passed: false, missing: ["farewell"] },
  ]);
  assert.match(fb, /G2-export-union-preserved failed/);
  assert.match(fb, /missing: farewell/);
});

test("runWithRetry: stops immediately when the first attempt passes all gates", async () => {
  let calls = 0;
  const r = await runWithRetry({
    maxAttempts: 2,
    attemptFn: async () => { calls++; return { gates: [{ gate: "G1-parses-cleanly", passed: true }] }; },
  });
  assert.equal(r.success, true);
  assert.equal(r.stopReason, "passed");
  assert.equal(calls, 1);
});

test("runWithRetry: retries once with feedback, then exhausts at maxAttempts", async () => {
  const feedbacksSeen = [];
  const r = await runWithRetry({
    maxAttempts: 2,
    attemptFn: async ({ attempt, feedback }) => {
      feedbacksSeen.push(feedback);
      // fail differently each time so it's not treated as a repeated-failure stop
      return { gates: [{ gate: `G-fail-${attempt}`, passed: false }] };
    },
  });
  assert.equal(r.success, false);
  assert.equal(r.stopReason, "max-attempts");
  assert.equal(r.attempts.length, 2);
  assert.equal(feedbacksSeen[0], null, "first attempt gets no prior feedback");
  assert.match(feedbacksSeen[1], /G-fail-1 failed/, "second attempt receives the first attempt's feedback");
});

test("runWithRetry: stops early on repeated-failure when the same gate fails twice with no new info", async () => {
  let calls = 0;
  const r = await runWithRetry({
    maxAttempts: 5,
    attemptFn: async () => {
      calls++;
      return { gates: [{ gate: "G2-export-union-preserved", passed: false, missing: ["x"] }] };
    },
  });
  assert.equal(r.success, false);
  assert.equal(r.stopReason, "repeated-failure");
  assert.equal(calls, 2, "should not burn all 5 attempts once the same failure repeats");
});

test("runWithRetry: maxAttempts=1 means a single attempt, no retry", async () => {
  let calls = 0;
  const r = await runWithRetry({
    maxAttempts: 1,
    attemptFn: async () => { calls++; return { gates: [{ gate: "G1-parses-cleanly", passed: false }] }; },
  });
  assert.equal(calls, 1);
  assert.equal(r.stopReason, "max-attempts");
});
