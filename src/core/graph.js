/**
 * graph.js — Builds the project graph from parsed FileNodes and derives
 * workflow subgraphs. Fully deterministic.
 *
 * A "workflow" = the reachable call/import subgraph from a detected entry
 * point (bin script, main module, HTTP route registration, CLI command,
 * exported public API of the root package).
 */

import fs from "node:fs";
import path from "node:path";
import { detectFrameworkEntries } from "./frameworkEntries.js";
import { classifyUncoveredFiles, detectGeneratedFiles, applyAnnotations } from "./reachability.js";
import { createImportResolver } from "./importResolver.js";
import { createPolyglotResolver } from "./polyglot.js";

// Import resolution lives in importResolver.js — it resolves specifiers the
// way the project's own toolchain does (tsconfig paths, package.json
// imports/exports, TS-ESM extension rewriting), not just relative paths.

/** A test file is unreachable-from-entry-points by design, not dead code — shared with modernize.js's scoring. */
export const isTestFile = (f) => /(\.test\.|\.spec\.|__tests__\/|(^|\/)tests?\/)/.test(f);

const ROUTE_METHODS = new Set(["get", "post", "put", "delete", "patch", "use", "all"]);
const ROUTE_RECEIVERS = new Set(["app", "router", "server", "api", "fastify", "express"]);
const GLOBALS = new Set([
  "console", "JSON", "Math", "Object", "Array", "Promise", "Number", "String", "Date",
  "process", "Buffer", "Set", "Map", "RegExp", "Error", "Symbol", "Boolean", "URL",
  "fetch", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "parseInt",
  "parseFloat", "isNaN", "structuredClone", "queueMicrotask", "require", "import",
]);

/** tsconfig's outDir/rootDir, tolerating comments and trailing commas. */
function readBuildDirs(rootDir) {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    try {
      const raw = fs.readFileSync(path.join(rootDir, name), "utf8");
      const stripped = raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1")
        .replace(/,(\s*[}\]])/g, "$1");
      const co = JSON.parse(stripped).compilerOptions ?? {};
      const norm = (v) => (typeof v === "string" ? v.replace(/^\.\//, "").replace(/\/$/, "") : null);
      if (co.outDir) return { outDir: norm(co.outDir), rootDir: norm(co.rootDir) };
    } catch {
      // absent or unparseable — the conventional fallbacks still apply
    }
  }
  return { outDir: null, rootDir: null };
}

export function buildGraph(rootDir, parseResult, pkg, { annotations = {} } = {}) {
  const { files } = parseResult;
  const fileSet = new Set(files.map((f) => f.file.split(path.sep).join("/")));
  const byFile = new Map(files.map((f) => [f.file.split(path.sep).join("/"), f]));
  const resolver = createImportResolver(rootDir, fileSet, pkg);
  const polyglotResolver = createPolyglotResolver(fileSet);

  // ---- edges ----------------------------------------------------------
  const importEdges = []; // { from, to } | { from, external } | { from, unresolved }
  let resolvedImports = 0, totalInternalImports = 0;
  for (const f of files) {
    const from = f.file.split(path.sep).join("/");
    for (const imp of f.imports) {
      // heuristic-parsed files (polyglot.js) resolve with their own language's
      // rules; JS/TS files keep the toolchain-faithful resolver. Both are
      // existence-checked — an edge only exists if the target file does.
      const r = f.parserKind === "heuristic" ? polyglotResolver.resolve(f, imp.source) : resolver.resolve(from, imp.source);
      if (r.internal) { importEdges.push({ from, to: r.internal }); resolvedImports++; totalInternalImports++; }
      else if (r.internalMany) { for (const to of r.internalMany) importEdges.push({ from, to }); resolvedImports++; totalInternalImports++; }
      else if (r.unresolved) { importEdges.push({ from, unresolved: r.unresolved }); totalInternalImports++; }
      else importEdges.push({ from, external: r.external });
    }
  }

  // function-level call resolution (same-file + imported-name heuristic, both deterministic)
  const fnIndex = new Map(); // "file#fn" -> fn record
  const fnByName = new Map(); // exported name -> Set of "file#fn"
  for (const f of files) {
    const file = f.file.split(path.sep).join("/");
    for (const fn of f.functions) {
      const id = `${file}#${fn.name}`;
      fnIndex.set(id, { ...fn, file, id });
      if (fn.exported) {
        if (!fnByName.has(fn.name)) fnByName.set(fn.name, new Set());
        fnByName.get(fn.name).add(id);
      }
    }
  }

  const callEdges = [];
  let resolvedCalls = 0, totalCalls = 0, dynamicCalls = 0;
  for (const [id, fn] of fnIndex) {
    const fileNode = byFile.get(fn.file);
    const localNames = new Set(fileNode?.functions.map((x) => x.name));
    // names imported into this file, split by whether the source resolves
    // internally — and for internal ones, WHICH file each name came from, so
    // a call can resolve to that exact file instead of relying on the name
    // being globally unique across the whole project.
    const internalImported = new Set();
    const externalImported = new Set();
    const importedNameTarget = new Map(); // name -> the internal file it was imported from
    // heuristic-parsed files extract no calls, and their import specifiers are
    // not JS-resolvable — skip the per-function import pass entirely for them
    const fileImports = fileNode?.parserKind === "heuristic" ? [] : fileNode?.imports ?? [];
    for (const imp of fileImports) {
      const r = resolver.resolve(fn.file, imp.source);
      for (const n of imp.names) {
        if (r.internal) { internalImported.add(n); importedNameTarget.set(n, r.internal); }
        else externalImported.add(n);
      }
    }
    for (const call of fn.calls) {
      totalCalls++;
      const bare = call.split(".")[0];
      const thisMethodTarget = bare === "this" && fn.receiver ? `${fn.receiver}.prototype.${call.slice(5)}` : null;
      if (localNames.has(call)) {
        callEdges.push({ from: id, to: `${fn.file}#${call}`, resolution: "local" });
        resolvedCalls++;
      } else if (thisMethodTarget && localNames.has(thisMethodTarget)) {
        // this.method() inside another prototype method of the same class
        callEdges.push({ from: id, to: `${fn.file}#${thisMethodTarget}`, resolution: "local-receiver" });
        resolvedCalls++;
      } else if (internalImported.has(bare) && !call.includes(".")) {
        // Import-precise resolution: we know exactly which internal file this
        // name was imported from — resolve the call to that file directly if
        // it defines the function, instead of requiring the name to be
        // globally unique (which fails on common names like run/init that
        // several modules legitimately export).
        const target = importedNameTarget.get(bare);
        const targetDefines = byFile.get(target)?.functions.some((x) => x.name === bare);
        if (targetDefines) {
          callEdges.push({ from: id, to: `${target}#${bare}`, resolution: "cross-file" });
          resolvedCalls++;
        } else if (fnByName.has(bare) && fnByName.get(bare).size === 1) {
          // re-exported through a barrel file: the imported file doesn't
          // define it itself — fall back to the unique-global match
          callEdges.push({ from: id, to: [...fnByName.get(bare)][0], resolution: "cross-file" });
          resolvedCalls++;
        } else {
          callEdges.push({ from: id, to: null, unresolvedName: call, resolution: "unresolved" });
        }
      } else if (internalImported.has(bare) && fnByName.has(bare) && fnByName.get(bare).size === 1) {
        // dotted call on an internally-imported binding that happens to be a
        // uniquely-named function — preserved original behavior
        callEdges.push({ from: id, to: [...fnByName.get(bare)][0], resolution: "cross-file" });
        resolvedCalls++;
      } else if (externalImported.has(bare)) {
        callEdges.push({ from: id, to: null, external: bare, resolution: "external" });
        resolvedCalls++; // we know where it goes: an external package
      } else if (GLOBALS.has(bare)) {
        callEdges.push({ from: id, to: null, global: bare, resolution: "global" });
        resolvedCalls++;
      } else if (localNames.has(bare)) {
        // method call on a locally-defined value (e.g. program.command)
        callEdges.push({ from: id, to: `${fn.file}#${bare}`, resolution: "local-receiver" });
        resolvedCalls++;
      } else if (call.includes(".")) {
        // method on a runtime value — statically unresolvable by design, not a
        // resolver failure. Reported separately, excluded from the rate.
        callEdges.push({ from: id, to: null, dynamicReceiver: bare, resolution: "dynamic" });
        dynamicCalls++;
        totalCalls--; // not part of the statically-resolvable population
      } else {
        callEdges.push({ from: id, to: null, unresolvedName: call, resolution: "unresolved" });
      }
    }
  }

  // ---- entry points ----------------------------------------------------
  const entryPoints = [];

  /**
   * package.json points at BUILD OUTPUT ("bin": "dist/cli.js"), but the graph
   * contains SOURCE. Taking the declared path literally meant the real entry
   * point silently vanished: a TypeScript CLI whose bin is dist/cli.js scored
   * zero real entries, every workflow collapsed, and almost every file looked
   * unreachable. Map the declared path back to the source that produces it.
   */
  const SRC_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
  const BUILD_DIRS = ["dist", "build", "lib", "out", "output", "es", "esm", "cjs", ".output"];

  const toSource = (declared) => {
    if (fileSet.has(declared)) return declared;           // already source
    const noExt = declared.replace(/\.[cm]?[jt]sx?$/, "");
    const candidates = [];

    // tsconfig is authoritative when it says where output goes.
    const { outDir, rootDir: srcRoot } = readBuildDirs(rootDir);
    if (outDir && noExt.startsWith(outDir + "/")) {
      const rel = noExt.slice(outDir.length + 1);
      for (const base of [srcRoot, "src", "source", ""].filter((v) => v != null)) {
        candidates.push(base ? `${base}/${rel}` : rel);
      }
    }
    // Otherwise strip a conventional build directory and try the usual sources.
    const seg = noExt.split("/");
    if (seg.length > 1 && BUILD_DIRS.includes(seg[0])) {
      const rel = seg.slice(1).join("/");
      for (const base of ["src", "source", "lib", ""]) candidates.push(base ? `${base}/${rel}` : rel);
    }

    for (const c of candidates) {
      for (const ext of SRC_EXTS) {
        if (fileSet.has(c + ext)) return c + ext;
      }
      if (fileSet.has(c)) return c;
    }
    return null;
  };

  const addEntry = (file, kind, detail) => {
    const resolved = toSource(file);
    if (!resolved) return;
    // Declared twice (bin AND main pointing at the same build file) is one entry.
    if (entryPoints.some((e) => e.file === resolved && e.kind === kind)) return;
    entryPoints.push({
      file: resolved,
      kind,
      detail,
      // Keep the declaration visible so the mapping is auditable, not magic.
      ...(resolved === file ? {} : { declaredAs: file }),
    });
  };
  if (pkg?.bin) {
    const bins = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : pkg.bin;
    for (const [name, p] of Object.entries(bins)) addEntry(path.posix.normalize(p), "bin", name);
  }
  if (pkg?.main) addEntry(path.posix.normalize(pkg.main), "main", "package.json main");
  // npm scripts that launch a node file are entry points (e.g. "start": "node src/server.js")
  for (const [scriptName, cmd] of Object.entries(pkg?.scripts ?? {})) {
    const m = typeof cmd === "string" && cmd.match(/(?:^|\s)node\s+(?:--[^\s]+\s+)*([^\s]+\.(?:js|mjs|cjs))/);
    if (m) addEntry(path.posix.normalize(m[1]), "npm-script", scriptName);
  }
  // HTTP route registrations (express/fastify-style: app.get('/x', handler)),
  // excluding test files — a test calling app.get() exercises a route, it doesn't define one
  for (const f of files) {
    const file = f.file.split(path.sep).join("/");
    if (isTestFile(file)) continue;
    for (const fn of f.functions) {
      for (const call of fn.calls) {
        const [recv, method] = call.split(".");
        if (recv && method && ROUTE_RECEIVERS.has(recv) && ROUTE_METHODS.has(method)) {
          addEntry(file, "http-route-site", call);
          break;
        }
      }
    }
  }
  // NestJS-style @Get()/@Post()/etc. method decorators — a distinct routing
  // convention from the call-site heuristic above (verified in parser.js).
  for (const f of files) {
    const file = f.file.split(path.sep).join("/");
    for (const route of f.decoratorRoutes ?? []) {
      addEntry(file, "nestjs-route", `@${route.decorator} ${route.class ?? "?"}.${route.method ?? "?"}`);
    }
  }
  // Next.js file-based routing, Vite build entries, Electron preload scripts —
  // each verified against real AST/path structure, never guessed.
  for (const fe of detectFrameworkEntries(rootDir, files, fileSet)) {
    addEntry(fe.file, fe.kind, fe.detail);
  }
  // language-level entry markers from the heuristic adapters (python __main__
  // guard, go `package main` + func main, java `public static void main`,
  // shebangs, ...) — each verified against real file content in polyglot.js
  for (const f of files) {
    const file = f.file.split(path.sep).join("/");
    for (const hint of f.entryHints ?? []) addEntry(file, hint.kind, hint.detail);
  }
  // user-asserted entrypoints from .mapdrc project.annotations — the "tell
  // Map'd" lever for entry conventions no detector recognizes (any language).
  // Labeled as a user assertion, never as detected.
  for (const a of applyAnnotations(fileSet, annotations)) {
    if (a.classification === "entrypoint") addEntry(a.file, "user-annotation", `asserted entrypoint (.mapdrc "${a.pattern}")`);
  }
  // fallback: files nothing imports (roots of the import DAG)
  const importedFiles = new Set(importEdges.filter((e) => e.to).map((e) => e.to));
  if (entryPoints.length === 0) {
    for (const f of fileSet) if (!importedFiles.has(f)) addEntry(f, "import-root", "not imported by any file");
  }

  // ---- workflows: BFS over import edges from each entry point ----------
  const adjacency = new Map();
  for (const e of importEdges) {
    if (!e.to) continue;
    if (!adjacency.has(e.from)) adjacency.set(e.from, new Set());
    adjacency.get(e.from).add(e.to);
  }
  const workflows = [];
  const seenRoots = new Set();
  for (const ep of entryPoints) {
    if (seenRoots.has(ep.file)) continue;
    seenRoots.add(ep.file);
    const reached = new Set([ep.file]);
    const queue = [ep.file];
    while (queue.length) {
      const cur = queue.shift();
      for (const next of adjacency.get(cur) ?? []) {
        if (!reached.has(next)) { reached.add(next); queue.push(next); }
      }
    }
    const wfFns = [...reached].flatMap((file) =>
      (byFile.get(file)?.functions ?? []).map((fn) => `${file}#${fn.name}`));
    workflows.push({
      id: `wf:${ep.kind}:${ep.file}`,
      entry: ep,
      files: [...reached].sort(),
      functionCount: wfFns.length,
      exportedSurface: [...reached].flatMap((f) => byFile.get(f)?.exports ?? []).sort(),
    });
  }

  // reachability: files reached by no workflow, excluding test files (unreachable
  // from entry points is their normal state, not dead code) — then split further:
  // static tracing genuinely cannot see runtime directory-scan plugin loaders or
  // test-runner glob discovery, so those are their own classification, not
  // silently lumped in with actual orphans. See reachability.js.
  const covered = new Set(workflows.flatMap((w) => w.files));
  const uncovered = [...fileSet].filter((f) => !covered.has(f) && !isTestFile(f));
  // Generated-file status is computed project-wide — a bundler output is
  // generated whether or not something else in the project reaches it, so
  // modernize.js can exclude it from scanning regardless of reachability
  // (this is what `graph.generatedFiles` is for, distinct from
  // `reachability.generatedArtifacts` below, which is scoped to just the
  // uncovered subset for the orphan-cluster exclusion count).
  const generatedFiles = detectGeneratedFiles(rootDir, fileSet, pkg, annotations);
  const { generatedArtifacts, dynamicallyLoaded, intentionalDormant, heuristicUnverified, trulyOrphaned } =
    classifyUncoveredFiles(rootDir, files, fileSet, uncovered, generatedFiles, annotations);
  const orphans = trulyOrphaned;

  return {
    generatedAt: new Date().toISOString(),
    root: rootDir,
    stats: {
      fileCount: files.length,
      parsedCleanly: files.filter((f) => f.parsed && f.parseErrors === 0).length,
      parsedWithRecovery: files.filter((f) => f.parsed && f.parseErrors > 0).length,
      unparsed: parseResult.skipped.length,
      unsupportedLanguageFiles: parseResult.unsupported.length,
      heuristicFileCount: files.filter((f) => f.parserKind === "heuristic").length,
      totalLoc: files.reduce((a, f) => a + f.loc, 0),
      importResolutionRate: totalInternalImports ? resolvedImports / totalInternalImports : 1,
      callResolutionRate: totalCalls ? resolvedCalls / totalCalls : 1,
      totalCalls,
      resolvedCalls,
      dynamicCalls,
    },
    files: files.map((f) => ({ ...f, file: f.file.split(path.sep).join("/") })),
    importEdges,
    callEdges,
    entryPoints,
    workflows,
    orphans,
    generatedFiles,
    reachability: { generatedArtifacts, dynamicallyLoaded, intentionalDormant, heuristicUnverified, trulyOrphaned },
    unsupported: parseResult.unsupported,
  };
}

export function loadPkg(rootDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Detects circular import dependencies as strongly-connected components (SCCs)
 * of size > 1 over the resolved-internal import graph (Tarjan's algorithm,
 * implemented iteratively to avoid stack-overflow risk on large real-world
 * codebases with deep import chains). A file that imports itself directly
 * (a true SCC of size 1 with a self-edge) also counts as a cycle.
 *
 * Purely graph-derived and deterministic — the same cycle is reported every
 * time for the same import graph, never a guess.
 */
export function detectCircularDependencies(graph) {
  const adjacency = new Map();
  for (const f of graph.files) adjacency.set(f.file, []);
  for (const e of graph.importEdges) {
    if (!e.to) continue;
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    adjacency.get(e.from).push(e.to);
  }

  let index = 0;
  const indices = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];

  for (const start of adjacency.keys()) {
    if (indices.has(start)) continue;

    const callStack = [{ node: start, neighbors: adjacency.get(start) ?? [], i: 0 }];
    indices.set(start, index);
    lowlink.set(start, index);
    index++;
    stack.push(start);
    onStack.add(start);

    while (callStack.length) {
      const frame = callStack[callStack.length - 1];
      if (frame.i < frame.neighbors.length) {
        const w = frame.neighbors[frame.i++];
        if (!indices.has(w)) {
          indices.set(w, index);
          lowlink.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          callStack.push({ node: w, neighbors: adjacency.get(w) ?? [], i: 0 });
        } else if (onStack.has(w)) {
          lowlink.set(frame.node, Math.min(lowlink.get(frame.node), indices.get(w)));
        }
      } else {
        callStack.pop();
        if (callStack.length) {
          const parent = callStack[callStack.length - 1];
          lowlink.set(parent.node, Math.min(lowlink.get(parent.node), lowlink.get(frame.node)));
        }
        if (lowlink.get(frame.node) === indices.get(frame.node)) {
          const component = [];
          let w;
          do {
            w = stack.pop();
            onStack.delete(w);
            component.push(w);
          } while (w !== frame.node);
          if (component.length > 1 || (adjacency.get(frame.node) ?? []).includes(frame.node)) {
            sccs.push(component.sort());
          }
        }
      }
    }
  }

  return sccs.sort((a, b) => a[0].localeCompare(b[0]));
}

const PACKAGE_MANAGER_LOCKFILES = [
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "package-lock.json", manager: "npm" },
  { file: "bun.lockb", manager: "bun" },
];

/**
 * Detects which package manager a project actually uses from its lockfile.
 * Never assumes npm — falls back to `{manager:"npm", lockfile:null}` only as
 * an explicit last resort when no lockfile exists at all, since some command
 * has to be attempted; callers should treat `lockfile:null` as "unverified."
 */
export function detectPackageManager(rootDir) {
  for (const { file, manager } of PACKAGE_MANAGER_LOCKFILES) {
    if (fs.existsSync(path.join(rootDir, file))) return { manager, lockfile: file };
  }
  return { manager: "npm", lockfile: null };
}

/** `run` args differ slightly across package managers (yarn/bun omit the literal "run" for scripts, but accept it too — kept uniform here since all four accept `<pm> run <script>`). */
export function packageManagerRunArgs(manager, scriptName) {
  if (scriptName === "test") return manager === "yarn" || manager === "bun" ? ["test"] : ["test"];
  return ["run", scriptName];
}
