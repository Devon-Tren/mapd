/**
 * configLint.js — `mapd config lint`. Catches configuration that quietly lies
 * to you: an annotation on a file you also excluded (so it never takes effect),
 * an annotation whose glob matches nothing (a stale path), a glob broad enough
 * to sweep in files you never meant, a dead exclude that matches nothing, and
 * manual assertions with no attribution (who said this, why, when).
 *
 * Every finding carries a concrete suggested patch. Deterministic: it reads the
 * resolved config, the real on-disk file list, and the scored graph — no guesses.
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/index.js";
import { DEFAULTS } from "../config/schema.js";
import { buildScoredGraph } from "./intelligence.js";
import { globToRegex } from "./reachability.js";
import { bold, dim, red, green, yellow, cyan } from "./theme.js";

/** Minimal recursive source walk (posix-relative), skipping the dirs a parser never reads. */
function listDiskFiles(rootDir) {
  const SKIP = new Set(["node_modules", ".git", ".mapd"]);
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".mapdrc") { if (SKIP.has(e.name)) continue; }
      if (SKIP.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), childRel);
      else out.push(childRel);
    }
  };
  walk(rootDir, "");
  return out;
}

const DEFAULT_EXCLUDES = new Set(DEFAULTS.project.exclude);

/** Attribution fields present on an object-form annotation value. */
function attribution(raw) {
  if (!raw || typeof raw !== "object") return [];
  return ["reason", "source", "date"].filter((k) => raw[k]);
}

export function lintConfig(rootDir) {
  const abs = path.resolve(rootDir);
  const config = loadConfig(abs);
  const graph = buildScoredGraph(abs);

  const graphFiles = graph.files.map((f) => f.file);
  const graphSet = new Set(graphFiles);
  const diskFiles = listDiskFiles(abs);
  const excludedFiles = diskFiles.filter((f) => !graphSet.has(f)); // on disk but dropped by excludes/ignores
  const wfFiles = new Set(graph.workflows.flatMap((w) => w.files));

  const annotations = config.project?.annotations ?? {};
  const excludes = config.project?.exclude ?? [];

  const findings = [];
  const add = (level, code, message, patch) => findings.push({ level, code, message, suggestedPatch: patch });

  const matchIn = (list, pattern) => { const re = globToRegex(pattern); return list.filter((f) => re.test(f)); };

  for (const [pattern, raw] of Object.entries(annotations)) {
    const classification = typeof raw === "string" ? raw : raw?.classification;
    const inGraph = matchIn(graphFiles, pattern);
    const inExcluded = matchIn(excludedFiles, pattern);

    if (inGraph.length === 0 && inExcluded.length > 0) {
      add("error", "excluded-but-annotated",
        `annotation "${pattern}" (${classification}) only matches files that project.exclude removed from the map (${inExcluded.slice(0, 3).join(", ")}${inExcluded.length > 3 ? ", …" : ""}) — the annotation can never take effect.`,
        `remove the annotation, or stop excluding those files (a file cannot be both excluded and, e.g., an entrypoint).`);
    } else if (inGraph.length === 0) {
      add("warn", "stale-annotation",
        `annotation "${pattern}" (${classification}) matches no current file — a stale or mistyped path.`,
        `remove it: \`mapd annotate remove ${pattern}\`, or fix the glob.`);
    }

    if (inGraph.length > 1 && graphFiles.length >= 5 && inGraph.length / graphFiles.length > 0.4) {
      add("warn", "over-broad-annotation",
        `annotation "${pattern}" (${classification}) matches ${inGraph.length}/${graphFiles.length} files — far broader than a targeted assertion.`,
        `narrow the glob to the specific file(s) or directory you mean.`);
    }

    if (classification && typeof raw === "string") {
      add("advice", "unattributed-annotation",
        `annotation "${pattern}" (${classification}) has no attribution — who asserted it, why, and when.`,
        `record it as { "classification": "${classification}", "reason": "…", "source": "you/PR", "date": "${new Date().toISOString().slice(0, 10)}" }.`);
    } else if (raw && typeof raw === "object" && attribution(raw).length < 3) {
      const missing = ["reason", "source", "date"].filter((k) => !raw[k]);
      add("advice", "partial-attribution",
        `annotation "${pattern}" is missing attribution field(s): ${missing.join(", ")}.`,
        `add the missing field(s) so the manual assertion is auditable.`);
    }
  }

  // User-added excludes (beyond the shipped defaults) that match nothing on disk.
  for (const pattern of excludes) {
    if (DEFAULT_EXCLUDES.has(pattern)) continue;
    if (matchIn(diskFiles, pattern).length === 0) {
      add("warn", "dead-exclude",
        `project.exclude "${pattern}" matches no file on disk — a stale or ineffective exclude.`,
        `remove it from project.exclude.`);
    }
  }

  // An exclude that removes files which ARE reached by a workflow is almost
  // always a mistake (you're hiding live code from the map). Detect via the
  // set difference: excluded files whose basename still appears wired in.
  for (const pattern of excludes) {
    if (DEFAULT_EXCLUDES.has(pattern)) continue;
    const excludedHit = matchIn(excludedFiles, pattern).filter((f) => wfFiles.has(f));
    if (excludedHit.length) {
      add("error", "excludes-live-code", `project.exclude "${pattern}" removes files a workflow still reaches: ${excludedHit.slice(0, 3).join(", ")}.`,
        `stop excluding them, or annotate them intentional-dormant if they really are dead.`);
    }
  }

  const errors = findings.filter((f) => f.level === "error").length;
  const warnings = findings.filter((f) => f.level === "warn").length;
  return {
    ok: errors === 0,
    counts: { error: errors, warn: warnings, advice: findings.filter((f) => f.level === "advice").length },
    findings,
  };
}

export function renderConfigLint(result) {
  const glyph = { error: red("✗"), warn: yellow("⚠"), advice: cyan("i") };
  const lines = [`\n${bold("config lint")}`];
  if (!result.findings.length) { lines.push(green("  No configuration problems found.")); return lines.join("\n"); }
  for (const f of result.findings) {
    lines.push(`  ${glyph[f.level]} ${bold(f.code)}  ${f.message}`);
    lines.push(dim(`      patch: ${f.suggestedPatch}`));
  }
  const c = result.counts;
  lines.push(`\n  ${c.error ? red(`${c.error} error(s)`) : green("0 errors")}, ${c.warn} warning(s), ${c.advice} advisory(ies).`);
  return lines.join("\n");
}
