/**
 * findingScoring.js — shared scoring helpers for anything that ranks queue
 * findings (handoff.js, solutions.js). One severity/priority scale and one
 * files-extraction rule, so the two never silently drift apart.
 */

const SEVERITY_SCORE = { high: 1.0, medium: 0.6, low: 0.3, info: 0.1 };

/** Unifies "check" findings (severity: high/medium/low) and modernize findings (a 0-1 priority) onto one scale. */
export function priorityOf(finding, item) {
  if (item.source === "check") return SEVERITY_SCORE[finding.severity] ?? 0;
  return finding.operationalImpact?.priority ?? item.priority ?? 0;
}

/** Modernize findings carry `files`; check (regression) findings carry it nested under `evidence`. */
export function filesOf(finding) {
  if (Array.isArray(finding.files)) return finding.files;
  if (Array.isArray(finding.evidence?.files)) return finding.evidence.files;
  return [];
}
