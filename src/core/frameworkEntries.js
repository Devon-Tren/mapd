/**
 * frameworkEntries.js — framework-specific entry-point detection beyond the
 * generic bin/main/npm-script/route-call-site heuristics in graph.js.
 *
 * DESIGN RULE (same as parser.js): every detector here either verifies its
 * finding against real AST structure and confirms the resolved file actually
 * exists in the project, or it detects nothing. No pattern here guesses at a
 * file that might exist — a miss is acceptable, a fabricated entry is not.
 */

import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import fs from "node:fs";
import path from "node:path";

const traverse = _traverse.default ?? _traverse;

const BABEL_OPTS = { sourceType: "unambiguous", errorRecovery: true, plugins: ["typescript", "jsx", "decorators-legacy"] };

/**
 * Resolves `relSpec` against `dirPosix` and returns the matching project file
 * only if it actually exists in `fileSet` — this existence check, not a
 * leading-dot requirement, is what prevents fabricating an entry. A bare
 * relative filename (e.g. "preload.js", as produced by `path.join(__dirname,
 * "preload.js")`) is just as valid a spec here as "./preload.js"; both are
 * relative to `dirPosix` either way.
 */
function resolveFromDir(dirPosix, relSpec, fileSet) {
  if (typeof relSpec !== "string" || !relSpec.trim()) return null;
  const base = path.posix.join(dirPosix, relSpec);
  const candidates = [base, `${base}.js`, `${base}.ts`, `${base}.jsx`, `${base}.tsx`, `${base}.mjs`, `${base}.mts`];
  for (const c of candidates) {
    const norm = path.posix.normalize(c);
    if (fileSet.has(norm)) return norm;
  }
  return null;
}

/**
 * Next.js file-based routing: Pages Router (anything under "pages", API
 * routes under "pages/api") and App Router (page/route/layout files nested
 * anywhere under "app"). Pure path-convention matching — no parsing needed,
 * and no ambiguity: a file either matches Next.js's documented convention or
 * it doesn't.
 */
export function detectNextJsEntries(fileSet) {
  const entries = [];
  for (const file of fileSet) {
    const pagesMatch = /^(?:src\/)?pages\/(.+)\.(jsx?|tsx?)$/.exec(file);
    if (pagesMatch) {
      const routePath = pagesMatch[1];
      if (path.posix.basename(routePath).startsWith("_")) continue; // _app/_document/_error/_middleware are framework hooks, not routes
      const kind = routePath.startsWith("api/") ? "nextjs-api-route" : "nextjs-page";
      entries.push({ file, kind, detail: `Next.js ${kind === "nextjs-api-route" ? "API route" : "page"}: /${routePath}` });
      continue;
    }
    const appMatch = /^(?:src\/)?app\/(.*\/)?(page|route|layout)\.(jsx?|tsx?)$/.exec(file);
    if (appMatch) {
      const kind = appMatch[2] === "route" ? "nextjs-route-handler" : appMatch[2] === "layout" ? "nextjs-layout" : "nextjs-page";
      entries.push({ file, kind, detail: `Next.js App Router ${appMatch[2]}: /${appMatch[1] ?? ""}` });
    }
  }
  return entries;
}

/**
 * HTML entry points: `<script type="module" src="...">` tags in root-level
 * HTML files — Vite's DEFAULT entry convention (used whenever a project does
 * NOT set an explicit `build.rollupOptions.input`, which is the common case:
 * verified against a real project during development, MITRI included). A
 * root-relative src ("/src/main.jsx") resolves against the project root; a
 * relative src ("./main.jsx") resolves against the HTML file's directory. An
 * external URL (http(s)://, a bare specifier) is skipped, never guessed at.
 */
export function detectHtmlEntries(rootDir, fileSet) {
  const entries = [];
  let rootEntries;
  try { rootEntries = fs.readdirSync(rootDir, { withFileTypes: true }); } catch { return entries; }

  for (const entry of rootEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".html")) continue;
    const relHtml = entry.name;
    let html;
    try { html = fs.readFileSync(path.join(rootDir, relHtml), "utf8"); } catch { continue; }

    const scriptTagRe = /<script\b([^>]*)>/gi;
    let tagMatch;
    while ((tagMatch = scriptTagRe.exec(html))) {
      const attrs = tagMatch[1];
      const typeMatch = /\btype\s*=\s*["']([^"']+)["']/i.exec(attrs);
      const srcMatch = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
      if (!srcMatch || typeMatch?.[1]?.toLowerCase() !== "module") continue;
      const src = srcMatch[1];
      if (/^([a-z]+:)?\/\//i.test(src)) continue; // external URL, e.g. https://... or //cdn...

      const dirPosix = src.startsWith("/") ? "." : path.posix.dirname(relHtml);
      const spec = src.startsWith("/") ? `.${src}` : src;
      const resolved = resolveFromDir(dirPosix, spec, fileSet);
      if (resolved) entries.push({ file: resolved, kind: "html-module-entry", detail: `<script type="module"> in ${relHtml}` });
    }
  }
  return entries;
}

/**
 * Vite entry points: `build.rollupOptions.input` and `build.lib.entry` in
 * vite.config.{js,ts,mjs,mts} at the project root. Verified by walking the
 * real AST and anchoring on the literal enclosing key name (`rollupOptions`
 * or `lib`) — never a bare "any object with an `input`/`entry` key."
 */
export function detectViteEntries(rootDir, fileSet) {
  const entries = [];
  for (const rel of ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts"]) {
    const abs = path.join(rootDir, rel);
    if (!fs.existsSync(abs)) continue;
    let ast;
    try { ast = parse(fs.readFileSync(abs, "utf8"), BABEL_OPTS); } catch { continue; }

    traverse(ast, {
      ObjectProperty(p) {
        const keyName = p.node.key?.name ?? p.node.key?.value;
        if (keyName !== "input" && keyName !== "entry") return;
        const enclosingProp = p.parentPath?.parentPath;
        const enclosingKey = enclosingProp?.isObjectProperty?.() ? (enclosingProp.node.key?.name ?? enclosingProp.node.key?.value) : null;
        const anchorMatches = (keyName === "input" && enclosingKey === "rollupOptions") || (keyName === "entry" && enclosingKey === "lib");
        if (!anchorMatches) return;

        const value = p.node.value;
        const specs = [];
        if (value.type === "StringLiteral") {
          specs.push(value.value);
        } else if (value.type === "ArrayExpression") {
          for (const el of value.elements) if (el?.type === "StringLiteral") specs.push(el.value);
        } else if (value.type === "ObjectExpression") {
          for (const prop of value.properties) if (prop.value?.type === "StringLiteral") specs.push(prop.value.value);
        }

        for (const spec of specs) {
          const resolved = resolveFromDir(".", spec, fileSet);
          if (resolved) entries.push({ file: resolved, kind: "vite-entry", detail: `build.${enclosingKey}.${keyName} in ${rel}` });
        }
      },
    });
  }
  return entries;
}

function resolvePreloadValue(valueNode, fileDirPosix, fileSet) {
  if (valueNode.type === "StringLiteral") return resolveFromDir(fileDirPosix, valueNode.value, fileSet);
  if (valueNode.type === "CallExpression") {
    const callee = valueNode.callee;
    const isPathJoinOrResolve = callee?.type === "MemberExpression" && callee.object?.name === "path" &&
      (callee.property?.name === "join" || callee.property?.name === "resolve");
    if (!isPathJoinOrResolve) return null;
    const args = valueNode.arguments ?? [];
    if (!args.some((a) => a.type === "Identifier" && a.name === "__dirname")) return null; // only the well-known, verifiable pattern
    const literalParts = args.filter((a) => a.type === "StringLiteral").map((a) => a.value);
    if (!literalParts.length) return null;
    return resolveFromDir(fileDirPosix, literalParts.join("/"), fileSet);
  }
  return null;
}

/**
 * Electron preload entries: `new BrowserWindow({ webPreferences: { preload: ... } })`.
 * Only resolves the preload path when it's a plain string or the well-known
 * `path.join(__dirname, "...")`/`path.resolve(__dirname, "...")` pattern —
 * any other expression shape (a variable, a computed path) is left
 * unresolved rather than guessed at.
 */
export function detectElectronPreloadEntries(rootDir, files, fileSet) {
  const entries = [];
  for (const f of files) {
    const relFile = f.file.split(path.sep).join("/");
    if (!/\.(js|ts|mjs|cjs|mts|cts)$/.test(relFile)) continue;
    let raw;
    try { raw = fs.readFileSync(path.join(rootDir, relFile), "utf8"); } catch { continue; }
    if (!raw.includes("BrowserWindow") || !raw.includes("preload")) continue; // cheap pre-filter, not the actual verification
    let ast;
    try { ast = parse(raw, BABEL_OPTS); } catch { continue; }
    const fileDirPosix = path.posix.dirname(relFile);

    traverse(ast, {
      NewExpression(p) {
        if (p.node.callee?.name !== "BrowserWindow") return;
        const optsArg = p.node.arguments?.[0];
        if (optsArg?.type !== "ObjectExpression") return;
        const webPrefsProp = optsArg.properties.find((pr) => pr.key?.name === "webPreferences" || pr.key?.value === "webPreferences");
        const webPrefsObj = webPrefsProp?.value;
        if (webPrefsObj?.type !== "ObjectExpression") return;
        const preloadProp = webPrefsObj.properties.find((pr) => pr.key?.name === "preload" || pr.key?.value === "preload");
        if (!preloadProp) return;
        const resolved = resolvePreloadValue(preloadProp.value, fileDirPosix, fileSet);
        if (resolved) entries.push({ file: resolved, kind: "electron-preload", detail: `BrowserWindow webPreferences.preload in ${relFile}` });
      },
    });
  }
  return entries;
}

/**
 * Tooling config files: entry points read directly by an external tool
 * (a test runner, a process manager) rather than imported by application
 * code. Without registering these, everything they alone pull in (e2e specs,
 * fixture helpers, deploy config) reads as unreachable "dead code" when it
 * isn't — it just belongs to a different runtime context than the app's own
 * entry points. Pure filename-convention matching (same verification model
 * as detectHtmlEntries: the file existing at its conventional path/name IS
 * the check) — once registered, the existing import-graph traversal already
 * follows whatever these files themselves import.
 */
const TOOLING_CONFIG_PATTERNS = [
  { re: /^playwright\.config\.(js|ts|mjs|cjs|mts|cts)$/, kind: "playwright-config", label: "Playwright config" },
  { re: /^jest\.config\.(js|ts|mjs|cjs|json)$/, kind: "jest-config", label: "Jest config" },
  { re: /^vitest\.config\.(js|ts|mjs|cjs|mts|cts)$/, kind: "vitest-config", label: "Vitest config" },
  { re: /^cypress\.config\.(js|ts|mjs|cjs)$/, kind: "cypress-config", label: "Cypress config" },
  { re: /^ecosystem\.config\.(js|cjs)$/, kind: "pm2-ecosystem", label: "PM2 ecosystem config" },
];

export function detectToolingConfigEntries(fileSet) {
  const entries = [];
  for (const file of fileSet) {
    if (file.includes("/")) continue; // these conventions are always project-root files
    for (const { re, kind, label } of TOOLING_CONFIG_PATTERNS) {
      if (re.test(file)) entries.push({ file, kind, detail: `${label} — read directly by its tool, not imported by app code` });
    }
  }
  return entries;
}

/** Runs every framework detector and returns the combined, deduplicated entry list. */
export function detectFrameworkEntries(rootDir, files, fileSet) {
  const all = [
    ...detectNextJsEntries(fileSet),
    ...detectHtmlEntries(rootDir, fileSet),
    ...detectViteEntries(rootDir, fileSet),
    ...detectElectronPreloadEntries(rootDir, files, fileSet),
    ...detectToolingConfigEntries(fileSet),
  ];
  const seen = new Set();
  return all.filter((e) => {
    const key = `${e.file}::${e.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
