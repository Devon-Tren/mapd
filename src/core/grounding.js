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
import { GLOBALS } from "./graph.js";

// "Next.js", "Node.js"… are technology names, not file claims.
const TECH_NAMES = /^(?:next|node|nuxt|vue|react|express|three|d3|chart|moment|ember|backbone|angular|nest|deno|bun|solid|svelte|electron|socket\.io|p5|pixi|ml5|tf|brain|anime|video|highlight|marked|mermaid|alpine|preact|lit|remix|gatsby|astro|vite|webpack)\.js$/i;
function extractPathLikeTokens(text) {
  return (text.match(/[\w./-]+\.(?:js|jsx|ts|tsx|mjs|cjs|json|md)\b/g) ?? []).filter((t) => !TECH_NAMES.test(t));
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
  const verified = [];
  const checkedTypes = [];
  let remaining = text;

  if (groundTruth.workflowIds) {
    checkedTypes.push("workflowIds");
    const valid = new Set(groundTruth.workflowIds);
    const found = extractWorkflowIds(remaining);
    for (const w of found) {
      if (valid.has(w)) verified.push({ type: "workflow", value: w });
      else violations.push({ type: "workflowId", value: w });
    }
    // strip matched workflow IDs before file-token scanning so a workflow
    // ID's own trailing filename-looking segment isn't double-counted as an
    // unrelated bare file claim (a workflow ID often embeds an entry file).
    remaining = found.reduce((t, w) => t.split(w).join(" "), remaining);
  }

  if (groundTruth.findingIds) {
    checkedTypes.push("findingIds");
    const valid = new Set(groundTruth.findingIds);
    for (const id of extractFindingIds(remaining)) {
      if (valid.has(id)) verified.push({ type: "finding", value: id });
      else violations.push({ type: "findingId", value: id });
    }
  }

  if (groundTruth.files) {
    checkedTypes.push("files");
    const validFiles = new Set(groundTruth.files);
    const validBasenames = basenamesOf(groundTruth.files);
    for (const p of extractPathLikeTokens(remaining)) {
      if (!validFiles.has(p) && !validBasenames.has(p.split("/").pop())) violations.push({ type: "file", value: p });
      else verified.push({ type: "file", value: p });
    }
  }

  if (groundTruth.graph) {
    checkedTypes.push("relations", "symbols");
    const index = graphIndex(groundTruth.graph);
    for (const claim of extractRelationClaims(text, index)) {
      const ok = claim.verb === "calls" ? fileCalls(index, claim.file, claim.target) : fileImports(index, claim.file, claim.target);
      const value = `${claim.file} ${claim.verb} ${claim.target}`;
      if (ok) verified.push({ type: "relation", value });
      else violations.push({ type: "relation", value, detail: `no ${claim.verb === "calls" ? "call to" : "import of"} ${claim.target} in ${claim.file}` });
    }
    for (const sym of extractSymbolClaims(text)) {
      const head = sym.split(".")[0];
      if (index.symbols.has(sym) || index.symbols.has(sym.split(".").pop()) || GLOBALS.has(head) || MAPD_TERMS.has(sym)) verified.push({ type: "symbol", value: sym });
      else violations.push({ type: "symbol", value: sym, detail: "no function, export, or import by that name in the map" });
    }
  }

  return { grounded: violations.length === 0, violations, verified, checkedTypes };
}

/** One-line human summary of a verifyGrounding result — what was checked, and what failed. */
export function describeGrounding(check) {
  const counts = {};
  for (const v of check.verified ?? []) counts[v.type] = (counts[v.type] ?? 0) + 1;
  const ok = Object.entries(counts).map(([t, n]) => `${n} ${t}${n > 1 ? "s" : ""}`).join(", ");
  const bad = check.violations.map((v) => `${v.type} "${v.value}"${v.detail ? ` (${v.detail})` : ""}`);
  return { ok, bad };
}

// ── claims about code: relations ("x.js calls `foo`") and symbols (`foo()`) ──

const graphIndexCache = new WeakMap();
function graphIndex(graph) {
  let idx = graphIndexCache.get(graph);
  if (idx) return idx;
  const byFile = new Map((graph.files ?? []).map((f) => [f.file, f]));
  const byBasename = new Map();
  for (const f of byFile.keys()) {
    const b = f.split("/").pop();
    byBasename.set(b, byBasename.has(b) ? null : f); // null = ambiguous basename
  }
  const symbols = new Set();
  for (const f of byFile.values()) {
    for (const fn of f.functions ?? []) for (const part of String(fn.name).split(/\.|#/)) if (part && part !== "prototype") symbols.add(part);
    for (const e of f.exports ?? []) symbols.add(e);
    for (const imp of f.imports ?? []) { for (const n of imp.names ?? []) symbols.add(n); symbols.add(imp.source); }
  }
  idx = { byFile, byBasename, symbols };
  graphIndexCache.set(graph, idx);
  return idx;
}

function resolveFileClaim(index, token) {
  if (index.byFile.has(token)) return token;
  return index.byBasename.get(token.split("/").pop()) ?? null;
}

const lastSegment = (name) => String(name).replace(/\(\)$/, "").split(/\.|#/).pop();
const stemOf = (file) => file.split("/").pop().replace(/\.[^.]+$/, "");

function fileCalls(index, file, target) {
  const want = lastSegment(target);
  const node = index.byFile.get(file);
  return (node?.functions ?? []).some((fn) => (fn.calls ?? []).some((c) => lastSegment(c) === want));
}

function fileImports(index, file, target) {
  const node = index.byFile.get(file);
  const want = lastSegment(target);
  const targetStem = /\.[a-z]+$/i.test(target) ? stemOf(target) : null;
  return (node?.imports ?? []).some((imp) =>
    (imp.names ?? []).includes(want) || (targetStem && stemOf(imp.source ?? "") === targetStem) || imp.source === target);
}

// Third-person verb forms only: "call site", "import edge", "require()" are nouns, not claims.
const VERBS = { calls: "calls", invokes: "calls", imports: "imports", requires: "imports" };
// Map'd's own vocabulary shows up in answers about the map and is not a code symbol.
const MAPD_TERMS = new Set([
  "dynamicallyLoaded", "trulyOrphaned", "generatedArtifacts", "intentionalDormant", "heuristicUnverified",
  "parseIntegrity", "resolutionRate", "testPresence", "stability", "coverageOfRepo", "signalCoverage",
  "repoConfidence", "callResolutionRate", "importResolutionRate", "exportedSurface", "entryPoints",
]);
const NEGATION = /\b(?:not|never|no longer|doesn.?t|don.?t|isn.?t|without)\b/i;
const TOKEN = "`?([\\w./-]+\\.(?:js|jsx|ts|tsx|mjs|cjs))`?";

/**
 * "`a.js` calls `foo`", "a.js imports b.js" → { file, verb, target }. Only
 * sentences whose subject is a REAL mapped file are checkable; everything else
 * is left alone rather than guessed at. Negated sentences are skipped.
 */
function extractRelationClaims(text, index) {
  const claims = [];
  const re = new RegExp(`${TOKEN}[^.\\n\`]{0,40}?\\b(calls|invokes|imports|requires)\\b[^.\\n\`]{0,40}?\`([\\w$./-]+?)(?:\\(\\))?\``, "g");
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    if (NEGATION.test(sentence)) continue;
    for (const m of sentence.matchAll(re)) {
      const file = resolveFileClaim(index, m[1]);
      if (!file) continue; // an unknown file is already reported by the file check
      const verb = VERBS[m[2].toLowerCase()];
      if (verb === "calls" && /\.(?:js|jsx|ts|tsx|mjs|cjs)$/.test(m[3])) continue; // a file is imported, not called
      claims.push({ file, verb, target: m[3] });
    }
  }
  return claims;
}

/**
 * Backticked identifiers that are unmistakably code — called (`foo()`),
 * camelCase/PascalCase, or dotted members — never plain words, flags,
 * ALL_CAPS env vars, or file paths (files have their own check).
 */
function extractSymbolClaims(text) {
  const out = new Set();
  for (const m of text.matchAll(/`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(\(\))?`/g)) {
    const [, name, called] = m;
    if (/^[A-Z0-9_]+$/.test(name)) continue;
    if (/\.(?:js|jsx|ts|tsx|mjs|cjs|json|md)$/.test(name)) continue;
    const codeShaped = called || name.includes(".") || /[a-z][A-Z]/.test(name) || /^[A-Z][a-z]+[A-Z]/.test(name);
    if (codeShaped) out.add(name);
  }
  return [...out];
}
