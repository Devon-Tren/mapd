/**
 * parser.js — Deterministic AST extraction (adapter #1: JavaScript/TypeScript).
 *
 * DESIGN RULE: Nothing in this file may call an LLM. The map is ground truth,
 * extracted from ASTs. Any file we cannot parse is recorded as unparsed and
 * *lowers* the derived confidence score — we never guess its contents.
 *
 * Adding a language = implementing this same interface (see ParserAdapter shape
 * at bottom) with e.g. tree-sitter-python and registering it in ADAPTERS.
 */

import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parsePolyglotFile, POLYGLOT_EXTENSIONS, KNOWN_UNSUPPORTED_EXTENSIONS } from "./polyglot.js";

const traverse = _traverse.default ?? _traverse;

const JS_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]);

const BABEL_OPTS = {
  sourceType: "unambiguous",
  errorRecovery: true,
  plugins: ["typescript", "jsx", "decorators-legacy"], // Babel 8: class props / top-level await / import attributes are default
};

/** NestJS-style HTTP method decorators — verified against real Babel AST output, not assumed. */
const ROUTE_DECORATORS = new Set(["Get", "Post", "Put", "Delete", "Patch", "Options", "Head", "All"]);

function decoratorCalleeName(decorator) {
  const expr = decorator.expression;
  if (expr.type === "Identifier") return expr.name;
  if (expr.type === "CallExpression" && expr.callee?.type === "Identifier") return expr.callee.name;
  return null;
}

/** Trivial functions (getters, one-liners) below this size produce meaningless "duplicate" noise across nearly any codebase. */
const MIN_SHAPE_HASH_LINES = 4;

/**
 * Structural "shape hash" for near-duplicate (Type-2 clone) detection: a
 * deterministic hash of the function's AST node-type/operator sequence, with
 * locally-declared identifiers (parameters, variables, catch params — incl.
 * nested function scopes within the body) normalized to positional
 * placeholders so a consistent variable rename doesn't change the hash.
 * Literal VALUES are reduced to their type tag, not their content — two
 * functions differing only in a string/number constant still match, which is
 * the standard definition of a Type-2 clone. Property names and called
 * function/method names ARE kept literal: calling a different function is a
 * real behavioral difference, not a rename.
 *
 * Returns null for functions shorter than MIN_SHAPE_HASH_LINES — never
 * computed, never a fabricated hash for a function too small to meaningfully
 * compare.
 */
function computeShapeHash(fnPath, locLines) {
  if (locLines < MIN_SHAPE_HASH_LINES) return null;

  const localNames = new Set();
  for (const name of Object.keys(fnPath.scope.bindings)) localNames.add(name);
  fnPath.traverse({
    Scopable(innerPath) {
      for (const name of Object.keys(innerPath.scope.bindings)) localNames.add(name);
    },
  });

  const localOrdinal = new Map();
  const tokens = [];
  const OPERATOR_NODE_TYPES = new Set(["BinaryExpression", "LogicalExpression", "AssignmentExpression", "UnaryExpression", "UpdateExpression"]);
  const LITERAL_NODE_TYPES = new Set(["StringLiteral", "NumericLiteral", "BooleanLiteral"]);

  const ownNameNode = fnPath.node.id ?? fnPath.node.key ?? null;

  fnPath.traverse({
    enter(p) {
      const n = p.node;
      if (n === ownNameNode) return; // the function/method's own declared name is not part of its body's shape
      if (n.type === "Identifier") {
        if (localNames.has(n.name)) {
          if (!localOrdinal.has(n.name)) localOrdinal.set(n.name, `VAR${localOrdinal.size + 1}`);
          tokens.push(localOrdinal.get(n.name));
        } else {
          tokens.push(`ref:${n.name}`);
        }
      } else if (LITERAL_NODE_TYPES.has(n.type)) {
        tokens.push(`lit:${n.type}`);
      } else if (OPERATOR_NODE_TYPES.has(n.type)) {
        tokens.push(`${n.type}:${n.operator}`);
      } else {
        tokens.push(n.type);
      }
    },
  });

  return crypto.createHash("sha1").update(tokens.join("|")).digest("hex").slice(0, 16);
}

/**
 * Parse one file into a FileNode.
 * @returns {{
 *   file: string, lang: "js", parsed: boolean, parseErrors: number,
 *   functions: Array<{name: string, exported: boolean, async: boolean, loc: number, params: number, calls: string[]}>,
 *   imports: Array<{source: string, names: string[]}>,
 *   exports: string[],
 *   loc: number
 * }}
 */
export function parseJsFile(absPath, relPath) {
  const code = fs.readFileSync(absPath, "utf8");
  const loc = code.split("\n").length;
  const node = {
    file: relPath, lang: "js", parsed: false, parseErrors: 0,
    functions: [], imports: [], exports: [], loc,
    moduleType: null, // "module" | "script" — detected, used by modernization scan
    varCount: 0,      // `var` declarations — legacy-pattern signal
    decoratorRoutes: [], // NestJS-style @Get()/@Post()/etc. method decorators — see ROUTE_DECORATORS
  };

  let ast;
  try {
    ast = parse(code, BABEL_OPTS);
    node.parseErrors = ast.errors?.length ?? 0;
    node.parsed = true;
  } catch {
    return node; // unparsed file: recorded honestly, degrades confidence
  }

  const exportedNames = new Set();
  /** identifier name -> its ObjectExpression node, for `const x = {...}; module.exports = x;` */
  const objectLiterals = new Map();
  /** name -> { calls:Set, async, loc, params, exported } */
  const fns = new Map();

  const addFn = (name, fnNode, exported) => {
    if (!name) return;
    const entry = fns.get(name) ?? {
      name, calls: new Set(), async: !!fnNode.async,
      loc: fnNode.loc ? fnNode.loc.end.line - fnNode.loc.start.line + 1 : 0,
      params: fnNode.params?.length ?? 0, exported: false,
    };
    entry.exported = entry.exported || exported;
    fns.set(name, entry);
    return entry;
  };

  const calleeName = (callee) => {
    if (!callee) return null;
    if (callee.type === "Identifier") return callee.name;
    if (callee.type === "ThisExpression") return "this"; // this.method() — resolved against the enclosing function's `receiver`, see graph.js
    if (callee.type === "CallExpression") return "()"; // method on a call result, e.g. fetch(x).then
    if (callee.type === "MemberExpression") {
      const obj = calleeName(callee.object);
      const prop = callee.property?.name ?? null;
      return obj && prop ? `${obj}.${prop}` : prop;
    }
    return null;
  };

  /** X.prototype.method = <function-like> — l is the AssignmentExpression's left MemberExpression. */
  const prototypeAssignmentTarget = (l) =>
    l?.type === "MemberExpression" && l.object?.type === "MemberExpression" &&
    l.object.property?.name === "prototype" && l.object.object?.type === "Identifier" && l.property?.name
      ? { className: l.object.object.name, methodName: l.property.name }
      : null;

  /** Object.assign(X.prototype, { method(){}, other: function(){} }) — target is the call's first argument. */
  const objectAssignPrototypeTarget = (calleeNode, targetArg) =>
    calleeNode?.type === "MemberExpression" && calleeNode.object?.name === "Object" && calleeNode.property?.name === "assign" &&
    targetArg?.type === "MemberExpression" && targetArg.property?.name === "prototype" && targetArg.object?.type === "Identifier"
      ? targetArg.object.name
      : null;

  // Which function body are we inside? Track a stack.
  const fnStack = [];

  node.moduleType = ast.program.sourceType;

  traverse(ast, {
    VariableDeclaration(p) {
      if (p.node.kind === "var") node.varCount++;
      for (const dec of p.node.declarations) {
        if (dec.id?.type === "Identifier" && dec.init?.type === "ObjectExpression") {
          objectLiterals.set(dec.id.name, dec.init);
        }
      }
    },
    ImportDeclaration(p) {
      node.imports.push({
        source: p.node.source.value,
        names: p.node.specifiers.map((s) => s.local.name),
        // `import type { X }` is erased at compile time — it creates no runtime
        // dependency. Flagged so test credit can tell "a test exercises this"
        // from "a test borrows its types", which are not the same claim. Only
        // present when true, so the common record shape is unchanged.
        ...(p.node.importKind === "type" ||
        (p.node.specifiers.length > 0 && p.node.specifiers.every((sp) => sp.importKind === "type"))
          ? { typeOnly: true }
          : {}),
      });
    },
    // import("./x.js") with a STATIC string specifier is a real, resolvable
    // module edge (lazy-loaded routes/modals are imported exactly this way) —
    // without it the target looks orphaned. Template-literal dynamic imports
    // stay reachability.js's job. Babel 8 parses import() as ImportExpression.
    ImportExpression(p) {
      if (p.node.source?.type === "StringLiteral") {
        node.imports.push({ source: p.node.source.value, names: [] });
      }
    },
    CallExpression(p) {
      // require() imports — capture the bound names so CJS resolves like ESM
      if (p.node.callee.name === "require" && p.node.arguments[0]?.type === "StringLiteral") {
        const names = [];
        const parent = p.parent;
        if (parent?.type === "VariableDeclarator") {
          if (parent.id.type === "Identifier") names.push(parent.id.name);
          else if (parent.id.type === "ObjectPattern") {
            for (const prop of parent.id.properties) {
              if (prop.value?.type === "Identifier") names.push(prop.value.name);
              else if (prop.argument?.type === "Identifier") names.push(prop.argument.name); // rest
            }
          }
        } else if (parent?.type === "MemberExpression" && p.parentPath.parent?.type === "VariableDeclarator"
                   && p.parentPath.parent.id?.type === "Identifier") {
          names.push(p.parentPath.parent.id.name); // const x = require('y').z
        }
        node.imports.push({ source: p.node.arguments[0].value, names });
      }
      const name = calleeName(p.node.callee);
      if (name && fnStack.length) fnStack[fnStack.length - 1].calls.add(name);
    },
    AssignmentExpression(p) {
      // CJS export surface: module.exports = ... / module.exports.x = ... / exports.x = ...
      const l = p.node.left;
      if (l?.type !== "MemberExpression") return;
      const objName = l.object?.name ?? (l.object?.object?.name === "module" && l.object?.property?.name === "exports" ? "module.exports" : null);
      if (objName === "exports" || objName === "module.exports") {
        if (l.property?.name) exportedNames.add(l.property.name);
      } else if (l.object?.name === "module" && l.property?.name === "exports") {
        const r = p.node.right;
        if (r.type === "ObjectExpression") {
          for (const prop of r.properties) if (prop.key?.name) exportedNames.add(prop.key.name);
        } else if (r.type === "Identifier") exportedNames.add(r.name);
        else if (r.id?.name) exportedNames.add(r.id.name);   // module.exports = function foo(){}
        else if (r.type === "CallExpression" && r.callee?.name) exportedNames.add(r.callee.name); // = createX()
        else exportedNames.add("default");
      }
    },
    ExportNamedDeclaration(p) {
      for (const s of p.node.specifiers ?? []) exportedNames.add(s.exported.name ?? s.exported.value);
      const d = p.node.declaration;
      if (d?.id?.name) exportedNames.add(d.id.name);
      if (d?.declarations) for (const dec of d.declarations) if (dec.id?.name) exportedNames.add(dec.id.name);
      // `export { x } from "./impl.js"` — a barrel re-export IS an import of
      // ./impl.js; without this edge the implementation file falls out of
      // every workflow and gets misreported as unreachable.
      if (p.node.source?.value) {
        node.imports.push({ source: p.node.source.value, names: p.node.specifiers.map((s) => s.local?.name ?? s.exported?.name).filter(Boolean) });
      }
    },
    // `export * from "./wide.js"` — same barrel edge. The re-exported NAMES
    // are statically unknowable here, so none are fabricated; only the
    // verified file relationship is recorded.
    ExportAllDeclaration(p) {
      if (p.node.source?.value) node.imports.push({ source: p.node.source.value, names: [] });
    },
    ExportDefaultDeclaration(p) {
      const d = p.node.declaration;
      exportedNames.add(d?.id?.name ?? "default");
    },
    "FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ClassMethod|ObjectMethod": {
      enter(p) {
        const n = p.node;
        let name = n.id?.name ?? n.key?.name ?? null;
        let receiver = null;

        // const foo = () => {} / const foo = function () {}
        if (!name && p.parent?.type === "VariableDeclarator" && p.parent.id?.type === "Identifier") {
          name = p.parent.id.name;
        }

        // X.prototype.method = function(){} / async function(){} / () => {}
        if (p.parent?.type === "AssignmentExpression") {
          const target = prototypeAssignmentTarget(p.parent.left);
          if (target) { receiver = target.className; name = `${receiver}.prototype.${target.methodName}`; }
        }

        // Object.assign(X.prototype, { method(){}, other: function(){} })
        if (!receiver) {
          let keyName = n.key?.name ?? n.key?.value ?? null; // ObjectMethod carries its own key
          let objExprPath = null;
          if (p.parentPath?.isObjectExpression()) {
            objExprPath = p.parentPath; // ObjectMethod directly inside the object literal
          } else if (p.parentPath?.isObjectProperty() && p.parentPath.parentPath?.isObjectExpression()) {
            keyName = p.parentPath.node.key?.name ?? p.parentPath.node.key?.value ?? keyName;
            objExprPath = p.parentPath.parentPath; // `other: function(){}` — FunctionExpression as a property value
          }
          const callPath = objExprPath?.parentPath?.isCallExpression() ? objExprPath.parentPath : null;
          if (callPath && keyName) {
            const className = objectAssignPrototypeTarget(callPath.node.callee, callPath.node.arguments?.[0]);
            if (className) { receiver = className; name = `${receiver}.prototype.${keyName}`; }
          }
        }

        // NestJS-style @Get()/@Post()/etc. method decorators — a real, verified AST
        // shape (ClassMethod.decorators[].expression), not a regex guess.
        if (n.type === "ClassMethod" && Array.isArray(n.decorators)) {
          const classPath = p.findParent((pp) => pp.isClassDeclaration() || pp.isClassExpression());
          const className = classPath?.node.id?.name ?? null;
          for (const decorator of n.decorators) {
            const decoratorName = decoratorCalleeName(decorator);
            if (decoratorName && ROUTE_DECORATORS.has(decoratorName)) {
              node.decoratorRoutes.push({ class: className, method: n.key?.name ?? null, decorator: decoratorName });
            }
          }
        }

        // exported inline?
        const exportedInline =
          p.findParent((pp) => pp.isExportNamedDeclaration() || pp.isExportDefaultDeclaration()) != null;
        const entry = addFn(name ?? `<anon:${n.loc?.start.line ?? "?"}>`, n, exportedInline);
        if (entry) {
          if (receiver) entry.receiver = receiver;
          entry.shapeHash = computeShapeHash(p, entry.loc);
        }
        fnStack.push(entry ?? { calls: new Set() });
      },
      exit() { fnStack.pop(); },
    },
  });

  // `const alpaca = { getPortfolioHistory() {...} }; module.exports = alpaca;` — the
  // AssignmentExpression visitor above only saw the identifier "alpaca" being exported;
  // resolve it back to the object literal it was declared with and export its properties
  // too, so CJS's "declare an object, export the identifier" pattern isn't missed.
  for (const name of [...exportedNames]) {
    const obj = objectLiterals.get(name);
    if (!obj) continue;
    for (const prop of obj.properties) {
      const key = prop.key?.name ?? prop.key?.value;
      if (key) exportedNames.add(key);
    }
  }

  for (const fn of fns.values()) {
    fn.exported = fn.exported || exportedNames.has(fn.name);
    node.functions.push({ ...fn, calls: [...fn.calls] });
  }
  node.exports = [...exportedNames];
  return node;
}

export const DEFAULT_IGNORE = new Set(["node_modules", ".git", "dist", "build", "coverage", ".mapd", ".next", "out"]);

function normalizeRelPath(rel) {
  return rel.split(path.sep).join("/").replace(/^\.\//, "");
}

function escapeRegExp(s) {
  return s.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern) {
  const p = normalizeRelPath(String(pattern ?? "").trim());
  if (!p) return /^$/;
  let out = "^";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    const next = p[i + 1];
    if (ch === "*" && next === "*") {
      const after = p[i + 2];
      if (after === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i++;
      }
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegExp(ch);
    }
  }
  out += "$";
  return new RegExp(out);
}

const globRegexCache = new Map();

function matchesGlob(rel, pattern) {
  const normalizedRel = normalizeRelPath(rel).replace(/\/$/, "");
  const normalizedPattern = normalizeRelPath(pattern).replace(/\/$/, "");
  if (!normalizedPattern) return false;

  // The common directory-subtree pattern should match the directory itself
  // too, so "dist/**" excludes both "dist" and "dist/app.js".
  if (normalizedPattern.endsWith("/**")) {
    const dir = normalizedPattern.slice(0, -3);
    if (normalizedRel === dir || normalizedRel.startsWith(`${dir}/`)) return true;
  }

  let re = globRegexCache.get(normalizedPattern);
  if (!re) {
    re = globToRegExp(normalizedPattern);
    globRegexCache.set(normalizedPattern, re);
  }
  return re.test(normalizedRel);
}

function matchesAnyGlob(rel, patterns = []) {
  return patterns.some((p) => matchesGlob(rel, p));
}

function skippedFileNode(relPath, reason) {
  return {
    file: relPath, lang: "js", parsed: false, parseErrors: 0,
    functions: [], imports: [], exports: [], loc: 0, skippedReason: reason,
    moduleType: null, varCount: 0, decoratorRoutes: [],
  };
}

/**
 * Walk a project directory and parse every supported file deterministically.
 * Optional `cache` (Map rel → {hash, node}) skips re-parsing unchanged files —
 * correctness identical (keyed on content hash, not mtime), cost proportional
 * to the diff. Used by `mapd watch`.
 */
export function parseProject(rootDir, { ignore = DEFAULT_IGNORE, cache = null, include = [], exclude = [], maxFileSizeBytes = Infinity, polyglot = true } = {}) {
  const files = [];
  const skipped = []; // supported-language files we failed to parse
  const unsupported = []; // files in languages with no adapter yet (honestly reported)
  let cacheHits = 0, parsedCount = 0;

  const parseOne = (abs, rel, parseFn) => {
    const stat = fs.statSync(abs);
    if (Number.isFinite(maxFileSizeBytes) && stat.size > maxFileSizeBytes) {
      const parsed = skippedFileNode(rel, "file-too-large");
      cache?.delete(rel);
      files.push(parsed);
      skipped.push(rel);
      return;
    }
    let parsed;
    if (cache) {
      const content = fs.readFileSync(abs);
      const hash = crypto.createHash("sha1").update(content).digest("hex");
      const hit = cache.get(rel);
      if (hit && hit.hash === hash) {
        parsed = hit.node;
        cacheHits++;
      } else {
        parsed = parseFn(abs, rel);
        parsedCount++;
        cache.set(rel, { hash, node: parsed });
      }
    } else {
      parsed = parseFn(abs, rel);
      parsedCount++;
    }
    files.push(parsed);
    if (!parsed.parsed) skipped.push(rel);
  };

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      const abs = path.join(dir, entry.name);
      const rel = normalizeRelPath(path.relative(rootDir, abs));
      if (matchesAnyGlob(rel, exclude)) continue;
      if (entry.isDirectory()) {
        if (!ignore.has(entry.name)) walk(abs);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (include.length && !matchesAnyGlob(rel, include)) continue;
      if (JS_EXTENSIONS.has(ext)) {
        parseOne(abs, rel, parseJsFile);
      } else if (POLYGLOT_EXTENSIONS[ext]) {
        // heuristic-tier adapter (see polyglot.js); the `mapping.polyglot: false`
        // kill switch reverts these to the honest "unsupported" bucket
        if (polyglot) parseOne(abs, rel, parsePolyglotFile);
        else unsupported.push(rel);
      } else if (KNOWN_UNSUPPORTED_EXTENSIONS.has(ext)) {
        unsupported.push(rel);
      }
    }
  };
  walk(rootDir);
  if (cache) {
    const live = new Set(files.map((f) => f.file));
    for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
  }
  return { files, skipped, unsupported, cacheHits, parsedCount };
}

/**
 * Most recent mtime among source files parseProject would scan — same ignore
 * rules, no parsing, just a stat walk. Used by staleness.js to tell whether
 * an on-disk report predates a source change, without duplicating or
 * drifting from parseProject's own file-discovery rules.
 */
export function latestSourceMtime(rootDir, ignore = DEFAULT_IGNORE) {
  let latest = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!ignore.has(entry.name)) walk(abs); continue; }
      const ext = path.extname(entry.name).toLowerCase();
      if (!JS_EXTENSIONS.has(ext) && !POLYGLOT_EXTENSIONS[ext]) continue;
      try { const m = fs.statSync(abs).mtimeMs; if (m > latest) latest = m; } catch { /* file vanished mid-walk */ }
    }
  };
  walk(rootDir);
  return latest;
}

/**
 * ParserAdapter interface (for future languages):
 *   { extensions: Set<string>, parseFile(absPath, relPath) -> FileNode }
 * Adapter #2 is polyglot.js: heuristic-tier extraction for Python/Go/Rust/
 * Ruby/Java/PHP, every node marked `parserKind: "heuristic"` so downstream
 * consumers can discount it. A full tree-sitter adapter would slot in the
 * same way and simply drop the heuristic mark.
 */
