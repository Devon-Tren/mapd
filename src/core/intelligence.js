/**
 * intelligence.js — the single source of truth for "build me a scored map of
 * this project," shared by cli.js, chat/, mcp/, and fix.js. Extracted
 * verbatim from cli.js's original inline `buildScoredGraph` helper so every
 * consumer sees identical results from identical inputs.
 */

import fs from "node:fs";
import path from "node:path";
import { parseProject } from "./parser.js";
import { buildGraph, loadPkg } from "./graph.js";
import { scoreGraph } from "./confidence.js";
import { loadConfig } from "../config/index.js";
import { loadPersistentParseCache, savePersistentParseCache } from "./parseCache.js";

export function buildScoredGraph(rootDir, { cache } = {}) {
  const abs = path.resolve(rootDir);
  if (!fs.existsSync(abs)) throw new Error(`project root does not exist: ${abs}`);
  if (!fs.statSync(abs).isDirectory()) throw new Error(`project root is not a directory: ${abs}`);
  const config = loadConfig(abs);
  const parseCache = cache ?? (config.mapping?.cache === false ? null : loadPersistentParseCache(abs, config));
  const parsed = parseProject(abs, {
    cache: parseCache,
    // Normal Map'd surfaces are governed by .mapdrc project.include/exclude.
    // The low-level parser still keeps its historical defaults for direct
    // callers/tests that do not go through buildScoredGraph.
    ignore: new Set(),
    include: config.project?.include ?? [],
    exclude: config.project?.exclude ?? [],
    maxFileSizeBytes: config.mapping?.maxFileSizeBytes ?? Infinity,
    polyglot: config.mapping?.polyglot !== false,
  });
  if (!cache && config.mapping?.cache !== false) savePersistentParseCache(abs, config, parseCache);
  // .mapdrc project.annotations: user-asserted generated/dynamically-loaded
  // classifications flow into reachability through here, so every consumer
  // (cli/chat/mcp/handoff/solutions) sees them without extra plumbing.
  const annotations = config.project?.annotations ?? {};
  const graph = buildGraph(abs, parsed, loadPkg(abs), { annotations });
  return scoreGraph(abs, graph);
}

export function findFileNode(graph, relFile) {
  return graph.files.find((f) => f.file === relFile) ?? null;
}

/** Keyword-overlap search over function names/files — used by retrieval and chat. */
export function searchFunctions(graph, query) {
  const terms = tokenize(query);
  const phrase = String(query ?? "").toLowerCase().trim();
  if (!terms.length) return [];

  const workflowIdsByFile = new Map();
  for (const wf of graph.workflows ?? []) {
    for (const file of wf.files) {
      if (!workflowIdsByFile.has(file)) workflowIdsByFile.set(file, []);
      workflowIdsByFile.get(file).push(wf.id);
    }
  }

  const hits = [];
  for (const file of graph.files) {
    const fileWorkflows = workflowIdsByFile.get(file.file) ?? [];
    const fileFields = [
      { text: file.file, weight: 5, label: "file" },
      { text: path.posix.basename(file.file), weight: 5, label: "basename" },
      { text: (file.exports ?? []).join(" "), weight: 4, label: "exports" },
      { text: (file.imports ?? []).flatMap((i) => [i.source, ...(i.names ?? [])]).join(" "), weight: 2, label: "imports" },
      { text: fileWorkflows.join(" "), weight: 2, label: "workflow" },
    ];
    for (const fn of file.functions) {
      const fields = [
        { text: fn.name, weight: 7, label: "function" },
        { text: fn.exported ? "export exported public api" : "", weight: 1, label: "exported" },
        { text: (fn.calls ?? []).join(" "), weight: 3, label: "calls" },
        ...fileFields,
      ];
      const scored = scoreFields(fields, terms, phrase);
      if (scored.score > 0) {
        hits.push({
          file: file.file,
          function: fn.name,
          score: scored.score,
          exported: fn.exported,
          loc: fn.loc,
          workflows: fileWorkflows,
          matches: scored.matches,
        });
      }
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}

function tokenize(text) {
  return String(text ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_#./-]+/)
    .flatMap((t) => t.split(/[./-]+/))
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function scoreFields(fields, terms, phrase) {
  const matches = [];
  let score = 0;
  for (const field of fields) {
    const text = String(field.text ?? "").toLowerCase();
    if (!text) continue;
    if (phrase && phrase.length >= 3 && text.includes(phrase)) {
      score += field.weight * 4;
      matches.push(field.label);
    }
    const fieldTokens = tokenize(text);
    for (const term of terms) {
      const exact = fieldTokens.filter((t) => t === term).length;
      const partial = exact ? 0 : fieldTokens.filter((t) => t.includes(term) || term.includes(t)).length;
      if (exact || partial) {
        score += field.weight * (exact * 2 + partial);
        if (!matches.includes(field.label)) matches.push(field.label);
      }
    }
  }
  return { score, matches };
}

export function buildTaskContext(graph, query, { maxHits = 8, maxFiles = 8 } = {}) {
  const hits = searchFunctions(graph, query).slice(0, maxHits);
  const hitFiles = [...new Set(hits.map((h) => h.file))].slice(0, maxFiles);
  const workflows = graph.workflows
    .filter((wf) => wf.files.some((f) => hitFiles.includes(f)))
    .map((wf) => ({
      id: wf.id,
      entry: wf.entry,
      fileCount: wf.files.length,
      functionCount: wf.functionCount,
      confidence: wf.confidence?.score,
      matchedFiles: wf.files.filter((f) => hitFiles.includes(f)),
    }));
  const files = hitFiles.map((rel) => {
    const node = findFileNode(graph, rel);
    return {
      file: rel,
      parsed: node?.parsed ?? false,
      loc: node?.loc ?? 0,
      exports: node?.exports ?? [],
      imports: (node?.imports ?? []).map((i) => ({ source: i.source, names: i.names ?? [] })),
      functions: (node?.functions ?? []).slice(0, 20).map((fn) => ({
        name: fn.name,
        exported: fn.exported,
        async: fn.async,
        loc: fn.loc,
        calls: (fn.calls ?? []).slice(0, 20),
      })),
    };
  });
  const caveats = [];
  if ((graph.stats?.callResolutionRate ?? 1) < 0.9) {
    caveats.push(`Call resolution is ${(graph.stats.callResolutionRate * 100).toFixed(1)}%; dynamic or unresolved calls may hide relationships.`);
  }
  if (graph.unsupported?.length) {
    caveats.push(`${graph.unsupported.length} unsupported-language file(s) were not parsed.`);
  }
  return {
    query,
    summary: getRepoStatusSummary(graph),
    hits,
    files,
    workflows,
    caveats,
  };
}

export function getWorkflowSummaries(graph) {
  return graph.workflows.map((wf) => ({
    id: wf.id, entry: wf.entry, fileCount: wf.files.length,
    functionCount: wf.functionCount, confidence: wf.confidence.score,
  }));
}

export function getRepoStatusSummary(graph) {
  return {
    fileCount: graph.stats.fileCount,
    totalLoc: graph.stats.totalLoc,
    workflowCount: graph.workflows.length,
    repoConfidence: graph.repoConfidence,
    callResolutionRate: graph.stats.callResolutionRate,
    orphanCount: graph.orphans.length,
  };
}

/** Shared by chat's startup banner and handoff.js's prompt header. */
export function detectStack(pkg, graph) {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const frameworks = [];
  if (deps.next) frameworks.push("Next.js");
  else if (deps.react) frameworks.push("React");
  if (deps.express) frameworks.push("Express");
  const hasTs = graph.files.some((f) => /\.tsx?$/.test(f.file));
  return { languages: [hasTs ? "TypeScript" : null, "JavaScript"].filter(Boolean), frameworks };
}
