/**
 * grounding.js — the single shared mechanism any LLM-touching surface in
 * mapd uses to verify a model's output against the real data it was allowed
 * to draw from. Extracted from solutions.js's narrateSolutions (the first
 * place this pattern existed) so every new LLM surface routes through the
 * same check instead of reinventing it — or, as chat's grounded Q&A did
 * until now, not having a mechanical check at all, only a prompt asking the
 * model to self-qualify.
 *
 * Intentionally mechanical, not another LLM call: regex-extract concrete
 * claims (file paths, workflow IDs, finding IDs) from the text, check each
 * against the real ground-truth sets the caller provides, and report
 * exactly which claims verified and which didn't. Never a fuzzy judgment —
 * a claim either matches something real or it's a violation.
 */

import fs from "node:fs";
import path from "node:path";

function extractPathLikeTokens(text) {
  return text.match(/[\w./-]+\.(?:js|jsx|ts|tsx|mjs|cjs|json|md)\b/g) ?? [];
}
function extractWorkflowIds(text) {
  return text.match(/wf:[\w:./-]+/g) ?? [];
}
// mapd's finding IDs are 8-hex-char content hashes (id8() in review.js).
// Matched only as a bare 8-char hex token so normal prose hex-looking words
// don't false-positive as often (still possible, but rare, and callers only
// check this when they actually pass findingIds — see below).
function extractFindingIds(text) {
  return text.match(/\b[0-9a-f]{8}\b/g) ?? [];
}
function basenamesOf(files) {
  return new Set(files.map((f) => f.split("/").pop()));
}

const METADATA_FILES = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "tsconfig.json",
  "jsconfig.json",
  ".mapdrc",
  "README.md",
  "MAP.md",
];

/**
 * Grounding needs "files this answer may cite", not only "source files Map'd
 * parsed into the AST graph." package.json/tsconfig/README are real project
 * data Map'd consumes or documents, even though they are not JS/TS FileNodes.
 */
export function buildGroundingFileList(rootDir, graph) {
  const abs = path.resolve(rootDir);
  const files = new Set((graph.files ?? []).map((f) => f.file));
  for (const file of METADATA_FILES) {
    if (fs.existsSync(path.join(abs, file))) files.add(file);
  }
  return [...files].sort();
}

/**
 * `groundTruth`: { files?: string[], workflowIds?: string[], findingIds?: string[] }
 * Only claim types with a corresponding ground-truth array get checked at
 * all — omitting `findingIds` means finding-ID-shaped tokens are never
 * flagged, so a caller can't be falsely told something is "grounded" for a
 * claim type it never actually verified.
 *
 * Returns { grounded, violations: [{type, value}], checkedTypes }.
 */
export function verifyGrounding(text, groundTruth = {}) {
  const violations = [];
  const checkedTypes = [];
  let remaining = text;

  if (groundTruth.workflowIds) {
    checkedTypes.push("workflowIds");
    const valid = new Set(groundTruth.workflowIds);
    const found = extractWorkflowIds(remaining);
    for (const w of found) if (!valid.has(w)) violations.push({ type: "workflowId", value: w });
    // strip matched workflow IDs before file-token scanning so a workflow
    // ID's own trailing filename-looking segment isn't double-counted as an
    // unrelated bare file claim (a workflow ID often embeds an entry file).
    remaining = found.reduce((t, w) => t.split(w).join(" "), remaining);
  }

  if (groundTruth.findingIds) {
    checkedTypes.push("findingIds");
    const valid = new Set(groundTruth.findingIds);
    for (const id of extractFindingIds(remaining)) if (!valid.has(id)) violations.push({ type: "findingId", value: id });
  }

  if (groundTruth.files) {
    checkedTypes.push("files");
    const validFiles = new Set(groundTruth.files);
    const validBasenames = basenamesOf(groundTruth.files);
    for (const p of extractPathLikeTokens(remaining)) {
      if (!validFiles.has(p) && !validBasenames.has(p.split("/").pop())) violations.push({ type: "file", value: p });
    }
  }

  return { grounded: violations.length === 0, violations, checkedTypes };
}
