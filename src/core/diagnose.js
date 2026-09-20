/**
 * diagnose.js — Map'd's self-awareness report.
 *
 * This is deliberately deterministic: it does not ask a provider to judge the
 * repo. It inspects the graph, package scripts, confidence signals, runtime
 * blind spots, and env-variable contract, then says where Map'd's
 * understanding is strong or incomplete.
 */

import fs from "node:fs";
import path from "node:path";
import { buildScoredGraph } from "./intelligence.js";
import { loadPkg } from "./graph.js";
import { loadConfig } from "../config/index.js";

const RUNTIME_SCRIPT_NAMES = new Set(["start", "dev", "serve", "preview", "server", "worker", "electron", "desktop"]);
const NON_RUNTIME_SCRIPT_NAMES = new Set(["test", "lint", "typecheck", "type-check", "build", "coverage", "format", "prettier"]);
const RUNTIME_SCRIPT_RE = /\b(node|tsx|ts-node|vite|next|nuxt|astro|remix|electron|nodemon|webpack-dev-server)\b/i;
const ENV_DOT_RE = /\bprocess\.env\.([A-Z_][A-Z0-9_]*)\b/g;
const ENV_BRACKET_RE = /\bprocess\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g;
const ENV_DYNAMIC_RE = /\bprocess\.env\[[^\]'"][^\]]*\]/g;
const ENV_DESTRUCTURE_RE = /\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*process\.env\b/g;

function sortedEntries(obj = {}) {
  return Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));
}

function scriptLooksRuntime(name, command) {
  const lower = String(name ?? "").toLowerCase();
  if (NON_RUNTIME_SCRIPT_NAMES.has(lower) || lower.startsWith("test:") || lower.startsWith("lint:")) return false;
  if (RUNTIME_SCRIPT_NAMES.has(lower) || lower.endsWith(":dev") || lower.endsWith(":start")) return true;
  return RUNTIME_SCRIPT_RE.test(String(command ?? ""));
}

function collectRuntimeScripts(pkg, graph) {
  const mappedNpmScripts = new Set((graph.entryPoints ?? [])
    .filter((e) => e.kind === "npm-script")
    .map((e) => e.detail));
  return sortedEntries(pkg?.scripts ?? {})
    .filter(([name, command]) => scriptLooksRuntime(name, command))
    .map(([name, command]) => ({
      name,
      command,
      mappedAsEntry: mappedNpmScripts.has(name),
    }));
}

function addEnvKey(map, key, file) {
  if (!key) return;
  const item = map.get(key) ?? { key, files: new Set(), count: 0 };
  item.files.add(file);
  item.count++;
  map.set(key, item);
}

function collectEnvReads(rootDir, graph) {
  const abs = path.resolve(rootDir);
  const keys = new Map();
  const dynamic = [];
  for (const f of graph.files ?? []) {
    let source = "";
    try { source = fs.readFileSync(path.join(abs, f.file), "utf8"); } catch { continue; }

    for (const re of [ENV_DOT_RE, ENV_BRACKET_RE]) {
      re.lastIndex = 0;
      for (const m of source.matchAll(re)) addEnvKey(keys, m[1], f.file);
    }

    ENV_DESTRUCTURE_RE.lastIndex = 0;
    for (const m of source.matchAll(ENV_DESTRUCTURE_RE)) {
      for (const raw of m[1].split(",")) {
        const key = raw.trim().split(/[:=]/)[0]?.trim();
        if (/^[A-Z_][A-Z0-9_]*$/.test(key)) addEnvKey(keys, key, f.file);
      }
    }

    ENV_DYNAMIC_RE.lastIndex = 0;
    const dynamicCount = [...source.matchAll(ENV_DYNAMIC_RE)].length;
    if (dynamicCount) dynamic.push({ file: f.file, count: dynamicCount });
  }

  return {
    keys: [...keys.values()]
      .map((v) => ({ key: v.key, count: v.count, files: [...v.files].sort() }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    dynamic,
    hasExampleFile: fs.existsSync(path.join(abs, ".env.example")),
  };
}

function signalIssues(confidence) {
  return Object.entries(confidence?.signals ?? {})
    .filter(([, s]) => s.unavailable || s.value == null || s.value < 0.7)
    .map(([name, s]) => ({
      signal: name,
      value: s.value ?? null,
      unavailable: !!s.unavailable,
      weight: s.weight,
    }));
}

function collectWeakWorkflows(graph, threshold, top) {
  return [...(graph.workflows ?? [])]
    .filter((wf) => (wf.confidence?.score ?? 1) < threshold || signalIssues(wf.confidence).length)
    .sort((a, b) => (a.confidence?.score ?? 1) - (b.confidence?.score ?? 1) || a.id.localeCompare(b.id))
    .slice(0, top)
    .map((wf) => ({
      id: wf.id,
      entry: wf.entry,
      fileCount: wf.files.length,
      score: wf.confidence?.score ?? null,
      signalCoverage: wf.confidence?.signalCoverage ?? null,
      weakSignals: signalIssues(wf.confidence),
    }));
}

function collectCallExamples(graph, resolution, top) {
  return (graph.callEdges ?? [])
    .filter((e) => e.resolution === resolution)
    .slice(0, top)
    .map((e) => ({
      from: e.from,
      name: e.unresolvedName ?? e.dynamicReceiver ?? null,
    }));
}

function buildRecommendations({ graph, weakWorkflows, runtimeScripts, env, unresolvedImports, unresolvedCalls, dynamicCalls, threshold }) {
  const recs = [];
  if ((graph.repoConfidence ?? 1) < threshold) {
    recs.push("Raise repo confidence by adding tests or entry-point coverage for the weakest workflows first.");
  }
  if (weakWorkflows.some((wf) => wf.weakSignals.some((s) => s.signal === "testPresence"))) {
    recs.push("Add tests near low-testPresence workflow files; Map'd cannot infer behavior that tests never exercise.");
  }
  if ((graph.stats?.callResolutionRate ?? 1) < 0.9 || unresolvedCalls.length || dynamicCalls.length) {
    recs.push("For dynamic call paths, add integration tests or annotations around plugin/runtime dispatch so static findings stay properly caveated.");
  }
  if (unresolvedImports.length) {
    recs.push("Fix unresolved imports or extend resolver configuration; broken aliases lower trust before any AI reasoning begins.");
  }
  if (runtimeScripts.some((s) => !s.mappedAsEntry)) {
    recs.push("Make runtime scripts map-friendly by pointing them at explicit entry files, or add annotations for framework/runtime entry conventions.");
  }
  if (env.keys.length && !env.hasExampleFile) {
    recs.push("Add a .env.example documenting required keys; Map'd reports env names only and never reads secret values.");
  }
  if (graph.unsupported?.length) {
    recs.push("Add parser support or exclude/annotate unsupported languages so Map'd does not overstate its coverage.");
  }
  if (graph.stats?.heuristicFileCount) {
    recs.push("Non-JS/TS files are mapped heuristically (regex-tier imports/functions, half confidence credit). " +
      "Annotate real entry points with `mapd annotate add <pattern> entrypoint` so their workflows form, " +
      "or set .mapdrc mapping.polyglot=false to exclude them from the map entirely.");
  }
  if (!recs.length) recs.push("No major understanding blockers detected by the deterministic diagnosis pass.");
  return recs;
}

export function buildDiagnosis(rootDir, { top = 5 } = {}) {
  const abs = path.resolve(rootDir);
  const graph = buildScoredGraph(abs);
  const pkg = loadPkg(abs);
  const config = loadConfig(abs);
  const threshold = config.mapping?.confidenceThreshold ?? 0.8;
  const limit = Math.max(1, Number.parseInt(top, 10) || 5);

  const weakWorkflows = collectWeakWorkflows(graph, threshold, limit);
  const runtimeScripts = collectRuntimeScripts(pkg, graph);
  const env = collectEnvReads(abs, graph);
  const unresolvedImports = (graph.importEdges ?? []).filter((e) => e.unresolved).slice(0, limit);
  const unresolvedCalls = collectCallExamples(graph, "unresolved", limit);
  const dynamicCalls = collectCallExamples(graph, "dynamic", limit);

  return {
    root: abs,
    generatedAt: new Date().toISOString(),
    summary: {
      fileCount: graph.stats.fileCount,
      workflowCount: graph.workflows.length,
      repoConfidence: graph.repoConfidence,
      confidenceThreshold: threshold,
      callResolutionRate: graph.stats.callResolutionRate,
      importResolutionRate: graph.stats.importResolutionRate,
      orphanCount: graph.orphans.length,
      unsupportedLanguageFiles: graph.stats.unsupportedLanguageFiles,
      heuristicFileCount: graph.stats.heuristicFileCount ?? 0,
      unparsed: graph.stats.unparsed,
    },
    confidence: {
      weakWorkflowCount: weakWorkflows.length,
      weakWorkflows,
    },
    runtime: {
      entryPoints: graph.entryPoints,
      runtimeScripts,
      unmappedRuntimeScripts: runtimeScripts.filter((s) => !s.mappedAsEntry),
      dynamicCallCount: graph.stats.dynamicCalls,
      dynamicCalls,
      unresolvedCalls,
      unresolvedImports,
      dynamicallyLoadedFiles: graph.reachability?.dynamicallyLoaded ?? [],
    },
    env,
    coverageGaps: {
      orphans: graph.orphans.slice(0, limit),
      generatedFiles: (graph.generatedFiles ?? []).slice(0, limit),
      unsupported: (graph.unsupported ?? []).slice(0, limit),
      heuristicUnverified: (graph.reachability?.heuristicUnverified ?? []).slice(0, limit),
    },
    recommendations: buildRecommendations({ graph, weakWorkflows, runtimeScripts, env, unresolvedImports, unresolvedCalls, dynamicCalls, threshold }),
  };
}

function signalText(signals) {
  if (!signals.length) return "no weak signals";
  return signals.map((s) => `${s.signal}=${s.unavailable ? "unavailable" : s.value}`).join(", ");
}

export function renderDiagnosis(data) {
  const lines = [];
  lines.push(`Map'd diagnosis — ${data.root}`);
  lines.push(`files: ${data.summary.fileCount}  workflows: ${data.summary.workflowCount}  confidence: ${data.summary.repoConfidence}  call resolution: ${(data.summary.callResolutionRate * 100).toFixed(1)}%`);
  if (data.summary.heuristicFileCount) {
    lines.push(`heuristic-parsed (non-JS/TS) files: ${data.summary.heuristicFileCount} — mapped with regex-tier extraction, half confidence credit; orphan claims about them are never asserted`);
  }

  lines.push("");
  lines.push("Confidence blockers");
  if (!data.confidence.weakWorkflows.length) {
    lines.push("  none above the configured threshold");
  } else {
    for (const wf of data.confidence.weakWorkflows) {
      lines.push(`  ${wf.id}  score ${wf.score}  (${wf.fileCount} files; ${signalText(wf.weakSignals)})`);
    }
  }

  lines.push("");
  lines.push("Runtime blind spots");
  if (!data.runtime.unmappedRuntimeScripts.length && !data.runtime.unresolvedCalls.length && !data.runtime.unresolvedImports.length && !data.runtime.dynamicCalls.length) {
    lines.push("  no major runtime blind spots detected");
  } else {
    for (const s of data.runtime.unmappedRuntimeScripts) lines.push(`  unmapped script "${s.name}": ${s.command}`);
    for (const e of data.runtime.unresolvedImports) lines.push(`  unresolved import from ${e.from}: ${e.unresolved}`);
    for (const c of data.runtime.unresolvedCalls) lines.push(`  unresolved call from ${c.from}: ${c.name}`);
    for (const c of data.runtime.dynamicCalls) lines.push(`  dynamic receiver from ${c.from}: ${c.name}`);
  }

  lines.push("");
  lines.push("Env contract");
  if (!data.env.keys.length && !data.env.dynamic.length) {
    lines.push("  no process.env reads detected");
  } else {
    for (const key of data.env.keys) lines.push(`  ${key.key}  (${key.count} read${key.count === 1 ? "" : "s"} in ${key.files.join(", ")})`);
    for (const item of data.env.dynamic) lines.push(`  dynamic process.env[...] read in ${item.file} (${item.count})`);
    lines.push(`  .env.example: ${data.env.hasExampleFile ? "present" : "missing"}`);
  }

  lines.push("");
  lines.push("Next actions");
  for (const rec of data.recommendations) lines.push(`  - ${rec}`);
  return lines.join("\n");
}
