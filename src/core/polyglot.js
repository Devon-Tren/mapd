/**
 * polyglot.js — heuristic parser adapters for languages Map'd has no full AST
 * adapter for yet (Python, Go, Rust, Ruby, Java, PHP).
 *
 * HONESTY CONTRACT (the whole point of this module):
 * - Every node produced here is marked `parserKind: "heuristic"`. Full-AST
 *   JS/TS nodes never carry that mark. Downstream consumers treat the two
 *   differently on purpose: confidence discounts heuristic files, reachability
 *   never asserts "orphan" about them, and diagnose discloses the count.
 * - Extraction is line/regex-based and deliberately conservative: it may MISS
 *   functions or imports (disclosed as a limit), but every import edge it
 *   emits still goes through existence-checked resolution — a specifier only
 *   resolves if the target file is really in the project. No fabricated edges.
 * - The kill switch is `.mapdrc` `mapping.polyglot: false` — you can tell
 *   Map'd to stop mapping these languages entirely, and they revert to the
 *   old honestly-reported "unsupported" bucket.
 *
 * Adding a language = one entry in EXTRACTORS + one resolver case below.
 */

import fs from "node:fs";
import path from "node:path";

/** extension -> language id. Everything here is heuristic-tier. */
export const POLYGLOT_EXTENSIONS = Object.freeze({
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".java": "java",
  ".php": "php",
});

/** Languages recognized but NOT heuristically parsed — stay in the honest "unsupported" bucket. */
export const KNOWN_UNSUPPORTED_EXTENSIONS = new Set([".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".kt", ".kts", ".swift", ".scala", ".ex", ".exs", ".dart", ".lua", ".pl", ".m"]);

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** Identifier fragment that tolerates unicode word characters (Python/Ruby allow them). */
const ID = "[\\p{L}_][\\p{L}\\p{N}_]*";

// ---------------------------------------------------------------------------
// per-language extraction — each returns { functions, imports, exports, entryHints }
// imports: [{ source, names }] where `source` keeps enough language context
// for resolvePolyglotImport to do existence-checked resolution.
// ---------------------------------------------------------------------------

function extractPython(lines) {
  const functions = [], imports = [], exports = [], entryHints = [];
  const defRe = new RegExp(`^(\\s*)(?:async\\s+)?def\\s+(${ID})\\s*\\(`, "u");
  const classRe = new RegExp(`^(\\s*)class\\s+(${ID})\\b`, "u");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = defRe.exec(line))) {
      const topLevel = m[1].length === 0;
      functions.push({ name: m[2], line: i + 1, exported: topLevel && !m[2].startsWith("_"), async: /^\s*async\s/.test(line) });
      if (topLevel && !m[2].startsWith("_")) exports.push(m[2]);
    } else if ((m = classRe.exec(line))) {
      if (m[1].length === 0 && !m[2].startsWith("_")) exports.push(m[2]);
    } else if ((m = /^\s*from\s+(\.*[\w.]*)\s+import\s+(.+)/u.exec(line))) {
      const names = m[2].split(",").map((n) => n.trim().split(/\s+as\s+/)[0]).filter((n) => /^[\w*]+$/u.test(n));
      imports.push({ source: m[1], names });
    } else if ((m = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/u.exec(line))) {
      for (const mod of m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0])) imports.push({ source: mod, names: [mod.split(".")[0]] });
    } else if (/^if\s+__name__\s*==\s*["']__main__["']/.test(line)) {
      entryHints.push({ kind: "python-main-guard", detail: `if __name__ == "__main__" at line ${i + 1}` });
    }
  }
  return { functions, imports, exports, entryHints };
}

function extractGo(lines) {
  const functions = [], imports = [], exports = [], entryHints = [];
  let isMainPackage = false, hasMainFn = false, inImportBlock = false;
  const fnRe = /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)\s*[([]/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (/^package\s+main\b/.test(line)) isMainPackage = true;
    if (inImportBlock) {
      if (/^\s*\)/.test(line)) { inImportBlock = false; continue; }
      if ((m = /^\s*(?:\w+\s+)?"([^"]+)"/.exec(line))) imports.push({ source: m[1], names: [m[1].split("/").pop()] });
      continue;
    }
    if (/^import\s*\(/.test(line)) { inImportBlock = true; continue; }
    if ((m = /^import\s+(?:\w+\s+)?"([^"]+)"/.exec(line))) imports.push({ source: m[1], names: [m[1].split("/").pop()] });
    if ((m = fnRe.exec(line))) {
      const exported = /^[A-Z]/.test(m[1]);
      functions.push({ name: m[1], line: i + 1, exported, async: false });
      if (exported) exports.push(m[1]);
      if (m[1] === "main") hasMainFn = true;
    }
  }
  if (isMainPackage && hasMainFn) entryHints.push({ kind: "go-main", detail: "package main with func main()" });
  return { functions, imports, exports, entryHints };
}

function extractRust(lines, relFile) {
  const functions = [], imports = [], exports = [], entryHints = [];
  const fnRe = /^\s*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/.exec(line))) {
      imports.push({ source: `mod:${m[1]}`, names: [m[1]] });
    } else if ((m = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+((?:crate|super|self)(?:::[A-Za-z_]\w*)+)/.exec(line))) {
      imports.push({ source: m[1], names: [m[1].split("::").pop()] });
    } else if ((m = fnRe.exec(line))) {
      const exported = !!m[1];
      functions.push({ name: m[2], line: i + 1, exported, async: /\basync\s+fn\b/.test(line) });
      if (exported) exports.push(m[2]);
      if (m[2] === "main" && /(^|\/)main\.rs$/.test(relFile)) entryHints.push({ kind: "rust-main", detail: `fn main() in ${path.posix.basename(relFile)}` });
    }
  }
  return { functions, imports, exports, entryHints };
}

function extractRuby(lines) {
  const functions = [], imports = [], exports = [], entryHints = [];
  const defRe = new RegExp(`^\\s*def\\s+(?:self\\.)?(${ID}[?!=]?)`, "u");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = /^\s*require_relative\s+["']([^"']+)["']/.exec(line))) {
      imports.push({ source: `./${m[1]}`, names: [] });
    } else if ((m = /^\s*require\s+["']([^"']+)["']/.exec(line))) {
      imports.push({ source: m[1], names: [] });
    } else if ((m = defRe.exec(line))) {
      functions.push({ name: m[1], line: i + 1, exported: true, async: false });
      exports.push(m[1]);
    } else if ((m = new RegExp(`^\\s*(?:class|module)\\s+(${ID})`, "u").exec(line))) {
      exports.push(m[1]);
    } else if (/^if\s+__FILE__\s*==\s*\$(?:0|PROGRAM_NAME)/.test(line)) {
      entryHints.push({ kind: "ruby-main-guard", detail: `__FILE__ == $0 guard at line ${i + 1}` });
    }
  }
  return { functions, imports, exports: [...new Set(exports)], entryHints };
}

function extractJava(lines) {
  const functions = [], imports = [], exports = [], entryHints = [];
  const methodRe = /^\s*(?:public|protected|private)\s+(?:static\s+)?(?:final\s+)?[\w<>[\],\s.]+?\s+(\w+)\s*\(/;
  const typeRe = /^\s*(?:public\s+)?(?:final\s+|abstract\s+)?(?:class|interface|enum|record)\s+(\w+)/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = /^\s*import\s+(?:static\s+)?([\w.]+)\s*;/.exec(line))) imports.push({ source: m[1], names: [m[1].split(".").pop()] });
    else if ((m = typeRe.exec(line))) exports.push(m[1]);
    else if ((m = methodRe.exec(line)) && !/^(if|for|while|switch|catch|return|new)$/.test(m[1])) {
      const exported = /^\s*public\b/.test(line);
      functions.push({ name: m[1], line: i + 1, exported, async: false });
      if (exported) exports.push(m[1]);
      if (/public\s+static\s+void\s+main\s*\(/.test(line)) entryHints.push({ kind: "java-main", detail: `public static void main at line ${i + 1}` });
    }
  }
  return { functions, imports, exports: [...new Set(exports)], entryHints };
}

function extractPhp(lines) {
  const functions = [], imports = [], exports = [], entryHints = [];
  const fnRe = new RegExp(`^\\s*(?:public\\s+|protected\\s+|private\\s+)?(?:static\\s+)?function\\s+(${ID})\\s*\\(`, "u");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = /\b(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?["']\/?([^"']+\.php)["']/.exec(line))) {
      imports.push({ source: line.includes("__DIR__") ? `./${m[1].replace(/^\//, "")}` : m[1], names: [] });
    } else if ((m = fnRe.exec(line))) {
      const exported = !/^\s*(?:private|protected)\b/.test(line);
      functions.push({ name: m[1], line: i + 1, exported, async: false });
      if (exported) exports.push(m[1]);
    } else if ((m = new RegExp(`^\\s*(?:abstract\\s+|final\\s+)?(?:class|interface|trait)\\s+(${ID})`, "u").exec(line))) {
      exports.push(m[1]);
    }
  }
  return { functions, imports, exports: [...new Set(exports)], entryHints };
}

const EXTRACTORS = { python: extractPython, go: extractGo, rust: extractRust, ruby: extractRuby, java: extractJava, php: extractPhp };

/**
 * Parse one non-JS file heuristically into the same FileNode shape
 * parseJsFile produces, plus `parserKind: "heuristic"` and `entryHints`.
 * Any read/extract failure degrades to an honest unparsed node — never throws.
 */
export function parsePolyglotFile(absPath, relPath) {
  const lang = POLYGLOT_EXTENSIONS[path.extname(relPath).toLowerCase()];
  const node = {
    file: relPath, lang: lang ?? "unknown", parsed: false, parseErrors: 0,
    parserKind: "heuristic",
    functions: [], imports: [], exports: [], loc: 0,
    moduleType: null, varCount: 0, decoratorRoutes: [], entryHints: [],
  };
  let code;
  try { code = stripBom(fs.readFileSync(absPath, "utf8")); } catch { return node; }
  const lines = code.split(/\r?\n/);
  node.loc = lines.length;
  const extractor = EXTRACTORS[lang];
  if (!extractor) return node;
  try {
    const { functions, imports, exports, entryHints } = extractor(lines, relPath);
    // a shebang is a verified executable marker in any language
    if (lines[0]?.startsWith("#!")) entryHints.push({ kind: "shebang", detail: lines[0].slice(0, 60) });
    node.functions = functions.map((f) => ({ name: f.name, exported: f.exported, async: f.async, loc: 1, params: 0, calls: [] }));
    node.imports = imports;
    node.exports = exports;
    node.entryHints = entryHints;
    node.parsed = true;
  } catch {
    // extraction bug on exotic input: recorded honestly as unparsed, never a crash
  }
  return node;
}

// ---------------------------------------------------------------------------
// import resolution — existence-checked against the project fileSet, mirroring
// importResolver.js's contract: {internal} | {external} | {unresolved}.
// ---------------------------------------------------------------------------

const tryCandidates = (fileSet, candidates) => {
  for (const c of candidates) {
    const norm = path.posix.normalize(c);
    if (fileSet.has(norm)) return norm;
  }
  return null;
};

function resolvePython(fromDir, spec, fileSet) {
  // relative: leading dots climb from the importing file's package
  const dots = /^(\.+)/.exec(spec)?.[1].length ?? 0;
  const modPath = spec.slice(dots).split(".").filter(Boolean).join("/");
  const bases = dots > 0
    ? [path.posix.join(fromDir, "../".repeat(dots - 1), modPath)]
    : [modPath, path.posix.join(fromDir, modPath)]; // absolute: project root first, then sibling package
  for (const base of bases.map((b) => path.posix.normalize(b))) {
    const hit = tryCandidates(fileSet, base === "." || base === "" ? [] : [`${base}.py`, `${base}/__init__.py`]);
    if (hit) return { internal: hit };
    if ((base === "." || base === "") && dots > 0) {
      // `from . import x` — the package itself
      const init = tryCandidates(fileSet, [path.posix.join(fromDir, "__init__.py")]);
      if (init) return { internal: init };
    }
  }
  return dots > 0 ? { unresolved: spec } : { external: spec };
}

function resolveGo(spec, fileSet, dirIndex) {
  // Go imports are package (directory) paths. We resolve by longest real
  // directory suffix match and link to that directory's .go files.
  const parts = spec.split("/");
  for (let i = 0; i < parts.length; i++) {
    const suffix = parts.slice(i).join("/");
    const files = dirIndex.get(suffix);
    if (files?.length) return { internalMany: files };
  }
  return { external: spec };
}

function resolveRust(fromDir, spec, fileSet) {
  if (spec.startsWith("mod:")) {
    const name = spec.slice(4);
    const hit = tryCandidates(fileSet, [path.posix.join(fromDir, `${name}.rs`), path.posix.join(fromDir, name, "mod.rs")]);
    return hit ? { internal: hit } : { unresolved: spec };
  }
  const segs = spec.split("::").slice(1); // drop crate/super/self
  const roots = spec.startsWith("crate") ? ["src", "."] : [fromDir];
  for (const root of roots) {
    for (let take = segs.length; take >= 1; take--) {
      const base = path.posix.join(root, ...segs.slice(0, take));
      const hit = tryCandidates(fileSet, [`${base}.rs`, `${base}/mod.rs`]);
      if (hit) return { internal: hit };
    }
  }
  return { unresolved: spec };
}

function resolveRuby(fromDir, spec, fileSet) {
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const base = path.posix.join(fromDir, spec);
    const hit = tryCandidates(fileSet, [base.endsWith(".rb") ? base : `${base}.rb`]);
    return hit ? { internal: hit } : { unresolved: spec };
  }
  const hit = tryCandidates(fileSet, [`lib/${spec}.rb`, `${spec}.rb`]);
  return hit ? { internal: hit } : { external: spec };
}

function resolveJava(spec, fileSet) {
  // import a.b.C -> any project file whose path ends a/b/C.java
  const suffix = `${spec.split(".").join("/")}.java`;
  for (const f of fileSet) if (f === suffix || f.endsWith(`/${suffix}`)) return { internal: f };
  return { external: spec };
}

function resolvePhp(fromDir, spec, fileSet) {
  const base = spec.startsWith("./") || spec.startsWith("../") ? path.posix.join(fromDir, spec) : spec;
  const hit = tryCandidates(fileSet, [base, path.posix.join(fromDir, spec)]);
  return hit ? { internal: hit } : { unresolved: spec };
}

/**
 * Build the polyglot resolver once per graph. `dirIndex` (dir suffix -> .go
 * files) makes Go package resolution O(1) per import.
 * resolve(fileNode, spec) -> {internal} | {internalMany} | {external} | {unresolved}
 */
export function createPolyglotResolver(fileSet) {
  const goDirIndex = new Map();
  for (const f of fileSet) {
    if (!f.endsWith(".go")) continue;
    const dir = path.posix.dirname(f);
    // index every suffix of the directory path: "a/b/c" -> "a/b/c", "b/c", "c"
    const parts = dir === "." ? [] : dir.split("/");
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join("/");
      if (!goDirIndex.has(suffix)) goDirIndex.set(suffix, []);
      goDirIndex.get(suffix).push(f);
    }
  }

  return {
    resolve(fileNode, spec) {
      const fromDir = path.posix.dirname(fileNode.file.split(path.sep).join("/"));
      switch (fileNode.lang) {
        case "python": return resolvePython(fromDir, spec, fileSet);
        case "go": return resolveGo(spec, fileSet, goDirIndex);
        case "rust": return resolveRust(fromDir, spec, fileSet);
        case "ruby": return resolveRuby(fromDir, spec, fileSet);
        case "java": return resolveJava(spec, fileSet);
        case "php": return resolvePhp(fromDir, spec, fileSet);
        default: return { unresolved: spec };
      }
    },
  };
}
