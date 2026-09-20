/**
 * retry.js — general-purpose retry engine with structured gate feedback.
 * Used by fix.js (mapd fix), and available to chat/mcp/modernize proposal
 * flows for the same gate-fail -> structured-feedback -> retry loop.
 *
 * The deterministic gates remain the final judge — this module never lets an
 * attempt mark itself successful; success is `gates.every(g => g.passed)`.
 *
 * Stopping rules: all gates pass; maxAttempts reached; the same set of failed
 * gates repeats with no new information (no point burning another attempt).
 */

/** Turn one attempt's failed gates into one deterministic feedback sentence. */
export function buildRetryFeedback(gateResults) {
  const failed = gateResults.filter((g) => !g.passed);
  if (!failed.length) return null;
  const parts = failed.map((g) => {
    const bits = [];
    if (g.missing?.length) bits.push(`missing: ${g.missing.join(", ")}`);
    if (g.exitCode != null) bits.push(`exit code ${g.exitCode}`);
    if (g.stderr) bits.push(`stderr: ${g.stderr.slice(0, 300).trim()}`);
    return `${g.gate} failed${bits.length ? ` (${bits.join("; ")})` : ""}`;
  });
  return `${parts.join(". ")}. Do not repeat the same mistake — address exactly this feedback.`;
}

function failedGateSignature(gateResults) {
  return gateResults.filter((g) => !g.passed).map((g) => g.gate).sort().join(",");
}

/**
 * `attemptFn({attempt, feedback})` must return `{ gates, ...rest }`.
 * Returns `{ success, attempts, finalAttempt, stopReason }`.
 * `stopReason` is one of: "passed", "max-attempts", "repeated-failure".
 */
export async function runWithRetry({ attemptFn, maxAttempts = 2, onAttemptResult } = {}) {
  const attempts = [];
  let previousFeedback = null;
  let previousSignature = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await attemptFn({ attempt, feedback: previousFeedback });
    const gates = result.gates ?? [];
    const passed = gates.length > 0 && gates.every((g) => g.passed);
    const feedbackForRetry = passed ? null : buildRetryFeedback(gates);
    const record = { attempt, gates, passed, feedbackForRetry, result };
    attempts.push(record);
    onAttemptResult?.(record);

    if (passed) return { success: true, attempts, finalAttempt: record, stopReason: "passed" };

    const signature = failedGateSignature(gates);
    if (previousSignature !== null && signature === previousSignature && signature !== "") {
      return { success: false, attempts, finalAttempt: record, stopReason: "repeated-failure" };
    }
    previousSignature = signature;
    previousFeedback = feedbackForRetry;
  }

  return { success: false, attempts, finalAttempt: attempts[attempts.length - 1], stopReason: "max-attempts" };
}
