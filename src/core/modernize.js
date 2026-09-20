/**
 * modernize.js — Function 3: modernization / optimization scan.
 *
 * "More deterministic, not hallucinating" is implemented as three detector
 * tiers, all rule-based; the LLM only *elaborates* findings into proposals
 * (heavy mode, optional) and cannot create or score them.
 *
 * MODES are breadth knobs, not intelligence knobs:
 *   light  — dependency tier only (fast; safe for every push)
 *   medium — + code-pattern tier on the largest workflows (top 3 by file count)
 *   heavy  — + code-pattern tier on ALL workflows + architecture tier
 *            (+ --propose drafts LLM migration plans per finding)
 *
 * OPERATIONAL IMPACT is derived per finding:
 *   reach      occurrences / touched files, normalized against repo size
 *   certainty  detector-defined: curated table = 1.0 (deprecated by upstream,
 *              a fact), npm-outdated = 0.9 (registry-measured), AST pattern
 *              = 1.0 for occurrence (the pattern IS there) scaled by whether
 *              replacement is behavior-identical (table constant per rule)
 *   safety     test presence over touched files (how safely can we change it)
 *   impact = reach × certainty; priority = impact × (0.5 + 0.5 × safety)
 * Constants are per-rule policy, documented inline — never per-run guesses.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { detectCircularDependencies, isTestFile } from "./graph.js";
import { mergeFindingLifecycle } from "./regression.js";

/* ---------------- Tier 1: dependency health ---------------- */

// Curated table: upstream-deprecated or community-superseded packages.
// certainty 1.0 = deprecation/supersession is a published fact, not an opinion.
export const LEGACY_DEPS = {
  request:      { replacement: "undici / native fetch", reason: "deprecated by maintainers (Feb 2020)", kind: "deprecated" },
  moment:       { replacement: "dayjs / date-fns / Temporal", reason: "in maintenance mode per project docs", kind: "maintenance-mode" },
  "node-sass":  { replacement: "sass (dart-sass)", reason: "deprecated in favor of dart-sass", kind: "deprecated" },
  "babel-eslint": { replacement: "@babel/eslint-parser", reason: "renamed/superseded", kind: "superseded" },
  tslint:       { replacement: "eslint + typescript-eslint", reason: "deprecated by Palantir", kind: "deprecated" },
  "left-pad":   { replacement: "String.prototype.padStart", reason: "native replacement exists", kind: "native-replacement" },
  mkdirp:       { replacement: "fs.mkdir({recursive:true})", reason: "native replacement exists", kind: "native-replacement" },
  rimraf:       { replacement: "fs.rm({recursive:true,force:true})", reason: "native replacement exists (Node 14.14+)", kind: "native-replacement" },
  "body-parser": { replacement: "express.json()/express.urlencoded()", reason: "bundled into Express 4.16+", kind: "bundled" },
  bluebird:     { replacement: "native Promise", reason: "native promises match performance/features", kind: "native-replacement" },
  underscore:   { replacement: "native array/object methods or lodash-es", reason: "largely superseded", kind: "superseded" },
  q:            { replacement: "native Promise", reason: "native replacement exists", kind: "native-replacement" },
};

function depFindings(rootDir, pkg, { checkRegistry = true, registryTimeoutMs = 2000 } = {}) {
  const findings = [];
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  for (const [name, meta] of Object.entries(LEGACY_DEPS)) {
    if (deps[name]) {
      findings.push({
        tier: "dependency", rule: `legacy-dep:${name}`,
        detail: `\`${name}\` — ${meta.reason}. Suggested replacement: ${meta.replacement}.`,
        certainty: 1.0, occurrences: 1, files: ["package.json"], suggestion: meta.replacement,
      });
    }
  }
  // registry-measured staleness (best effort; offline → signal skipped, reported)
  if (!checkRegistry) {
    findings.push({ tier: "dependency", rule: "registry-skipped", informational: true,
      detail: "npm outdated skipped by configuration — registry staleness signal skipped.", certainty: 1.0, occurrences: 0, files: [] });
    return findings;
  }
  try {
    const out = execSync("npm outdated --json", { cwd: rootDir, stdio: ["ignore", "pipe", "ignore"], timeout: registryTimeoutMs }).toString();
    const outdated = out.trim() ? JSON.parse(out) : {};
    const majors = Object.entries(outdated).filter(([, v]) =>
      v.current && v.latest && v.current.split(".")[0] !== v.latest.split(".")[0]);
    if (majors.length) {
      findings.push({
        tier: "dependency", rule: "major-versions-behind",
        detail: `${majors.length} dependencies a major version behind: ${majors.map(([k, v]) => `${k} (${v.current}→${v.latest})`).join(", ")}.`,
        certainty: 0.9, occurrences: majors.length, files: ["package.json"],
        suggestion: "staged major upgrades, largest-risk first",
      });
    }
  } catch {
    findings.push({ tier: "dependency", rule: "registry-unavailable", informational: true,
      detail: "npm outdated unavailable (offline or no registry access) — staleness signal skipped.", certainty: 1.0, occurrences: 0, files: [] });
  }
  return findings;
}

/* ---------------- Tier 2: code patterns (from the map — zero extra parsing) ---------------- */

// Each rule reads FileNode data the parser already extracted.
// behaviorSafe: replacement is semantically identical (raises certainty of benefit).
const PATTERN_RULES = [
  {
    rule: "var-declarations", behaviorSafe: true,
    detect: (f) => f.varCount,
    detail: (n) => `${n} \`var\` declaration(s) — migrate to let/const for block scoping.`,
    suggestion: "let/const migration (codemod-able)",
  },
  {
    rule: "promise-then-chains", behaviorSafe: false,
    detect: (f) => f.functions.reduce((a, fn) => a + fn.calls.filter((c) => c.endsWith(".then") || c.endsWith(".catch")).length, 0),
    detail: (n) => `${n} .then/.catch chain site(s) — candidates for async/await.`,
    suggestion: "async/await refactor",
  },
  {
    rule: "deprecated-node-api", behaviorSafe: false,
    detect: (f) => f.functions.reduce((a, fn) => a + fn.calls.filter((c) =>
      ["url.parse", "fs.exists", "util.isArray", "querystring.parse"].includes(c)).length, 0),
    detail: (n) => `${n} call(s) to deprecated Node APIs (url.parse / fs.exists / util.isArray / querystring.parse).`,
    suggestion: "WHATWG URL, fs.access/existsSync, Array.isArray, URLSearchParams",
  },
  {
    // A .cjs extension is Node's explicit, unconditional CommonJS opt-out —
    // Node treats it as CommonJS regardless of package.json's "type" field,
    // so there is no real format ambiguity or interop risk there (unlike a
    // plain .js/.mjs file, where Node has to guess from "type" and a mismatch
    // is a genuine bug). Only flag the genuinely ambiguous case.
    rule: "cjs-in-esm-project", behaviorSafe: false, projectLevel: true,
    detect: (f, pkg) => (pkg?.type === "module" && f.moduleType === "script" && !f.file.endsWith(".cjs") ? 1 : 0),
    detail: (n) => `${n} ambiguous CommonJS file(s) (.js/.mjs using require()/module.exports, not .cjs) inside an ` +
      `ESM ("type":"module") package — Node must guess the format here, real interop risk. ` +
      `(.cjs files are Node's explicit CommonJS opt-out and are excluded — no ambiguity there.)`,
    suggestion: "convert to ESM imports/exports, or rename to .cjs to make the CommonJS choice explicit",
  },
];

function patternFindings(graph, pkg, scopeFiles, generatedSet) {
  const findings = [];
  // Generated files (bundler output, etc.) are excluded from every rule here
  // — a var-declarations/promise-chain/CJS finding pointing at a build
  // artifact tells you to hand-edit something that gets silently overwritten
  // on the next build. The real fix target is the authored source the
  // bundler reads from, which — being hand-written — gets scanned normally.
  const inScope = graph.files.filter((f) => scopeFiles.has(f.file) && !generatedSet.has(f.file));
  for (const rule of PATTERN_RULES) {
    let occurrences = 0;
    const files = [];
    for (const f of inScope) {
      const n = rule.detect(f, pkg) || 0;
      if (n > 0) { occurrences += n; files.push(f.file); }
    }
    if (occurrences > 0) {
      findings.push({
        tier: "code-pattern", rule: rule.rule,
        detail: rule.detail(occurrences),
        certainty: 1.0, // occurrence is a fact; benefit certainty encoded in behaviorSafe
        behaviorSafe: rule.behaviorSafe,
        occurrences, files, suggestion: rule.suggestion,
      });
    }
  }
  return findings;
}

/* ---------------- Tier 3: architecture (heavy only) ---------------- */

function architectureFindings(graph) {
  const findings = [];
  const totalFiles = graph.files.length;

  // monolith workflow: one workflow covering >70% of a repo with 12+ files
  for (const wf of graph.workflows) {
    if (totalFiles >= 12 && wf.files.length / totalFiles > 0.7) {
      findings.push({
        tier: "architecture", rule: "monolithic-workflow",
        detail: `Workflow ${wf.id} spans ${wf.files.length}/${totalFiles} files (${Math.round(100 * wf.files.length / totalFiles)}%) — module-boundary or service-split candidate.`,
        certainty: 1.0, occurrences: 1, files: wf.files,
        suggestion: "extract sub-workflows along import-cluster boundaries",
      });
    }
  }
  // unclassified reachability: orphans beyond noise. graph.orphans already
  // excludes files classified as generated artifacts or dynamically-loaded
  // (see reachability.js) — what's left needs human classification, it is
  // NOT asserted to be dead code. Leading with "dead code" overclaims
  // certainty the static graph doesn't have; leading with "needs
  // classification" matches what's actually known.
  if (graph.orphans.length >= 3) {
    // Orphan status is only as trustworthy as the call graph it's derived from:
    // a low call-resolution rate (CJS require() indirection, dynamic dispatch,
    // etc.) means real callers can be missed, producing false "orphan" claims.
    // Disclose that on the finding itself rather than only as a top-level stat.
    const resolutionRate = graph.stats.callResolutionRate;
    const lowConfidence = resolutionRate < 0.9;
    const excludedCount = (graph.reachability?.generatedArtifacts.length ?? 0) + (graph.reachability?.dynamicallyLoaded.length ?? 0);
    findings.push({
      tier: "architecture", rule: "orphan-cluster",
      detail: `${graph.orphans.length} file(s) need classification — unreachable from any statically-traced entry ` +
        "point. This is NOT a dead-code claim: verify each one (audit queue, not a deletion queue) before deleting or wiring in." +
        (excludedCount > 0
          ? ` (${excludedCount} other file(s) were already excluded from this count as generated artifacts or ` +
            "dynamically-loaded — real evidence for each is in the project's reachability data, not asserted blindly.)"
          : "") +
        (lowConfidence
          ? ` CAVEAT: call resolution is only ${(resolutionRate * 100).toFixed(1)}% — some of these may have real ` +
            "callers the static analysis couldn't trace (e.g. dynamic require()/CJS indirection); verify before deleting."
          : ""),
      certainty: lowConfidence ? Number((0.5 + 0.5 * resolutionRate).toFixed(2)) : 1.0,
      occurrences: graph.orphans.length, files: graph.orphans,
      suggestion: "delete, or register the missing entry point",
    });
  }
  // low-confidence workflow: derived score under 0.4 flags fragile territory
  for (const wf of graph.workflows) {
    if (wf.confidence && wf.confidence.score < 0.4) {
      findings.push({
        tier: "architecture", rule: "fragile-workflow",
        detail: `Workflow ${wf.id} derived confidence ${wf.confidence.score} — weakest signals: ${
          Object.entries(wf.confidence.signals).filter(([, s]) => s.value !== null && s.value < 0.5).map(([k]) => k).join(", ") || "n/a"}.`,
        certainty: 1.0, occurrences: 1, files: wf.files,
        suggestion: "raise the named signals before modernizing on top of this workflow",
      });
    }
  }
  // circular import dependencies: purely graph-derived (Tarjan SCCs over the
  // resolved import graph) — a structural fact, not a heuristic guess.
  for (const cycle of detectCircularDependencies(graph)) {
    findings.push({
      tier: "architecture", rule: "circular-dependency",
      detail: `${cycle.length} file(s) mutually depend on each other in an import cycle: ${cycle.join(" -> ")}.`,
      certainty: 1.0, occurrences: cycle.length, files: cycle,
      suggestion: "extract the shared interface into a separate module both sides can import without importing each other",
    });
  }
  // duplicate/near-duplicate functions: grouped by AST shape-hash (parser.js),
  // which normalizes local variable names and literal values but keeps
  // control-flow shape and called-function/property names literal — an exact
  // structural match under that normalization, not a fuzzy guess. Generated
  // files are excluded — repeated shapes inside a single bundler output are
  // an artifact of the build, not hand-duplicated code worth consolidating.
  const generatedSet = new Set(graph.generatedFiles.map((g) => g.file));
  const shapeGroups = new Map();
  for (const f of graph.files) {
    if (generatedSet.has(f.file)) continue;
    for (const fn of f.functions) {
      if (!fn.shapeHash) continue;
      if (!shapeGroups.has(fn.shapeHash)) shapeGroups.set(fn.shapeHash, []);
      shapeGroups.get(fn.shapeHash).push({ file: f.file, name: fn.name });
    }
  }
  for (const members of shapeGroups.values()) {
    if (members.length < 2) continue;
    const files = [...new Set(members.map((m) => m.file))];
    findings.push({
      tier: "architecture", rule: "duplicate-functions",
      detail: `${members.length} structurally identical function(s) (same logic; variable names and literal values ignored): ${
        members.map((m) => `${m.file}#${m.name}`).join(", ")}.`,
      certainty: 1.0, occurrences: members.length, files,
      suggestion: "extract the shared logic into one function every call site imports",
    });
  }
  return findings;
}

/* ---------------- Impact scoring + orchestration ---------------- */

// Test-only files never ship — a finding confined entirely to test scaffolding
// (e.g. a fixture helper duplicated across 11 *.test.js files) is real
// maintenance debt, but it is categorically lower-stakes than the same
// pattern in production code, and a rule like duplicate-functions scans all
// files without distinguishing them. Without this, raw file-count/occurrence
// breadth in test files can outweigh a smaller finding in real, connected
// production code purely because it touches more files — verified against
// mapd's own self-scan, where an 11-file test-fixture duplicate outranked a
// 2-file production duplicate with real workflow blast radius. Weighting
// (not excluding) keeps large-scale test-suite disrepair visible, just far
// less urgent than anything touching shipped code.
const TEST_FILE_OPERATIONAL_WEIGHT = 0.15;

function operationalWeight(file) { return isTestFile(file) ? TEST_FILE_OPERATIONAL_WEIGHT : 1; }

function hasTestFor(allFiles, file) {
  const base = path.posix.basename(file).replace(/\.(js|ts|jsx|tsx|mjs|cjs)$/, "");
  return allFiles.some((f) => /(\.test\.|\.spec\.|__tests__\/|tests?\/)/.test(f) && f.includes(base));
}

function scoreFinding(finding, graph) {
  if (finding.informational) return finding;
  const repoFiles = Math.max(1, graph.files.length);
  const weightedFileCount = finding.files.reduce((a, f) => a + operationalWeight(f), 0);
  const avgWeight = finding.files.length ? weightedFileCount / finding.files.length : 1;
  const reach = Math.min(1, weightedFileCount / repoFiles + (finding.occurrences * avgWeight) / (repoFiles * 5));
  const allFiles = graph.files.map((f) => f.file);
  const tested = finding.files.filter((f) => f === "package.json" || hasTestFor(allFiles, f)).length;
  const safety = finding.files.length ? tested / finding.files.length : 1;
  const impact = reach * finding.certainty;
  finding.operationalImpact = {
    reach: Number(reach.toFixed(3)),
    certainty: finding.certainty,
    safety: Number(safety.toFixed(3)),
    impact: Number(impact.toFixed(3)),
    priority: Number((impact * (0.5 + 0.5 * safety)).toFixed(3)),
    method: "impact-composite-v2 (reach×certainty on operationally-weighted files/occurrences — test-only files count for less, they don't ship — priority damped by test safety)",
  };
  return finding;
}

function timed(profile, name, fn) {
  if (!profile) return fn();
  const startedAt = performance.now();
  try {
    return fn();
  } finally {
    profile.steps.push({ name, durationMs: Number((performance.now() - startedAt).toFixed(2)) });
  }
}

export function runModernizationScan(rootDir, graph, pkg, mode = "medium", {
  profile: withProfile = false,
  checkRegistry = true,
  registryTimeoutMs = 2000,
} = {}) {
  const findings = [];
  const startedAt = performance.now();
  const profile = withProfile ? { steps: [] } : null;

  findings.push(...timed(profile, "dependency-health", () => depFindings(rootDir, pkg, { checkRegistry, registryTimeoutMs }))); // all modes

  if (mode === "medium" || mode === "heavy") {
    findings.push(...timed(profile, "code-patterns", () => {
      const wfs = [...graph.workflows].sort((a, b) => b.files.length - a.files.length);
      const scoped = mode === "heavy" ? wfs : wfs.slice(0, 3);
      const scopeFiles = new Set(scoped.flatMap((w) => w.files));
      if (mode === "heavy") for (const o of graph.orphans) scopeFiles.add(o);
      const generatedSet = new Set(graph.generatedFiles.map((g) => g.file));
      return patternFindings(graph, pkg, scopeFiles, generatedSet);
    }));
  }
  if (mode === "heavy") findings.push(...timed(profile, "architecture", () => architectureFindings(graph)));

  timed(profile, "score-and-sort", () => {
    for (const f of findings) scoreFinding(f, graph);
    findings.sort((a, b) => (b.operationalImpact?.priority ?? -1) - (a.operationalImpact?.priority ?? -1));
  });

  const report = {
    generatedAt: new Date().toISOString(), mode,
    findings: findings.map((f) => ({ ...f, status: f.informational ? "info" : "awaiting-approval" })),
  };
  if (profile) {
    profile.totalMs = Number((performance.now() - startedAt).toFixed(2));
    report.profile = profile;
  }
  return report;
}

/**
 * Persist a modernization report, merging its findings against the previous
 * report for this mode through the same lifecycle rules as `mapd check`
 * (regression.js mergeFindingLifecycle): unreproduced open findings become
 * "resolved" with evidence, human dismissals are preserved, terminal entries
 * stay as audit trail. Mutates report.findings to the merged set so every
 * consumer (cli/chat/mcp) sees the same lifecycle-aware report.
 * Returns { path, resolvedNow }.
 */
export function saveModernizationReport(rootDir, report) {
  const p = path.join(rootDir, ".mapd", `modernize-${report.mode}.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });

  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(p, "utf8")); } catch { /* first run for this mode */ }

  const { findings, resolvedNow } = mergeFindingLifecycle(
    report.findings, prev?.findings, (f) => `${f.rule}:${f.detail}`, `mapd modernize ${report.mode}`,
  );
  report.findings = findings;
  fs.writeFileSync(p, JSON.stringify(report, null, 2));
  return { path: p, resolvedNow };
}
