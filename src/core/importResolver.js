/**
 * importResolver.js — resolves import specifiers the way the project's OWN
 * toolchain resolves them, not just by relative-path guessing. Every alias
 * mapd can't resolve becomes a false "unresolved edge" that depresses call
 * resolution and inflates orphan candidates — so this attacks orphan/
 * confidence accuracy at the root instead of adding downstream caveats.
 *
 * Sources of truth, all read from the project's real configuration:
 *   - tsconfig.json / jsconfig.json  `compilerOptions.paths` + `baseUrl`
 *     (root-level file only; `extends` chains are not followed — a miss
 *     falls through to the old behavior, never a wrong resolution)
 *   - package.json `imports`  (Node's `#`-prefixed subpath imports)
 *   - package.json `exports`  (self-referencing imports of the package's
 *     own name — Node resolves these through the exports map)
 *   - TypeScript's node16/nodenext ESM convention: source says
 *     `import "./x.js"` but the file on disk is `x.ts`/`x.tsx`
 *
 * DESIGN RULE (same as everywhere else): a candidate only resolves if the
 * target file actually exists in the project's file set. An alias that
 * matches but points at nothing stays "unresolved" — never fabricated.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Tolerates // and block comments plus trailing commas — tsconfig.json is
 * JSONC in practice. Must be string-aware, not regex-based: tsconfig paths
 * keys literally contain "/*" (e.g. "@/*"), which a naive block-comment
 * regex would eat as a comment opener and corrupt the whole document.
 */
function stripJsonc(raw) {
  let out = "";
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (ch === "\\") { out += raw[++i] ?? ""; continue; } // escaped char, incl. \"
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === "/" && raw[i + 1] === "/") { while (i < raw.length && raw[i] !== "\n") i++; out += "\n"; continue; }
    if (ch === "/" && raw[i + 1] === "*") { i += 2; while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++; i++; continue; }
    if (ch === "}" || ch === "]") { out = out.replace(/,\s*$/, ""); } // trailing comma, only ever outside strings here
    out += ch;
  }
  return out;
}

function readJsonc(absPath) {
  let raw;
  try { raw = fs.readFileSync(absPath, "utf8"); } catch { return null; }
  try {
    return JSON.parse(stripJsonc(raw));
  } catch {
    return null;
  }
}

/**
 * Loads `paths` aliases from tsconfig.json (preferred) or jsconfig.json.
 * Returns [{ keyPrefix, keySuffix, targets: [{prefix, suffix}] }] where a
 * single `*` wildcard splits key/target into prefix+suffix (TS allows at
 * most one `*` per pattern); exact keys have keySuffix === null.
 */
export function loadPathAliases(rootDir) {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const config = readJsonc(path.join(rootDir, name));
    const paths = config?.compilerOptions?.paths;
    if (!paths || typeof paths !== "object") continue;
    const baseUrl = config.compilerOptions.baseUrl ?? ".";
    const aliases = [];
    for (const [key, targets] of Object.entries(paths)) {
      if (!Array.isArray(targets)) continue;
      const starIdx = key.indexOf("*");
      const entry = {
        keyPrefix: starIdx === -1 ? key : key.slice(0, starIdx),
        keySuffix: starIdx === -1 ? null : key.slice(starIdx + 1),
        targets: targets
          .filter((t) => typeof t === "string")
          .map((t) => {
            const tStar = t.indexOf("*");
            const joined = (p) => path.posix.normalize(path.posix.join(baseUrl, p));
            return tStar === -1
              ? { prefix: joined(t), suffix: "" }
              : { prefix: joined(t.slice(0, tStar)), suffix: t.slice(tStar + 1) };
          }),
      };
      if (entry.targets.length) aliases.push(entry);
    }
    if (aliases.length) return aliases;
  }
  return [];
}

/** Unwraps a package.json imports/exports value: plain string, or a conditions object (first matching common condition). */
function unwrapConditional(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    for (const cond of ["import", "require", "node", "default"]) {
      if (typeof value[cond] === "string") return value[cond];
      if (value[cond] && typeof value[cond] === "object") {
        const nested = unwrapConditional(value[cond]);
        if (nested) return nested;
      }
    }
  }
  return null;
}

/** Matches `spec` against a subpath map (package.json imports/exports): exact first, then single-`*` patterns. */
function resolveSubpathMap(map, spec) {
  if (!map || typeof map !== "object") return null;
  if (map[spec] !== undefined) return unwrapConditional(map[spec]);
  for (const [key, value] of Object.entries(map)) {
    const starIdx = key.indexOf("*");
    if (starIdx === -1) continue;
    const prefix = key.slice(0, starIdx);
    const suffix = key.slice(starIdx + 1);
    if (spec.startsWith(prefix) && spec.endsWith(suffix) && spec.length >= prefix.length + suffix.length) {
      const matched = spec.slice(prefix.length, spec.length - suffix.length || undefined);
      const target = unwrapConditional(value);
      return target ? target.replace("*", matched) : null;
    }
  }
  return null;
}

/**
 * Creates the resolver used for every import edge in buildGraph.
 * `resolve(fromFile, spec)` returns exactly the old resolveImport contract:
 * `{internal}` | `{external}` | `{unresolved}`.
 */
export function createImportResolver(rootDir, fileSet, pkg) {
  const aliases = loadPathAliases(rootDir);
  const importsMap = pkg?.imports ?? null;
  const exportsMap = pkg?.exports ?? null;
  const pkgName = typeof pkg?.name === "string" ? pkg.name : null;

  /** Existence-checked candidate expansion; includes the TS-ESM `.js` → `.ts` swap. */
  function tryFile(basePosix) {
    const base = path.posix.normalize(basePosix);
    const candidates = [
      base,
      `${base}.js`, `${base}.ts`, `${base}.jsx`, `${base}.tsx`, `${base}.mjs`, `${base}.cjs`,
      `${base}/index.js`, `${base}/index.ts`,
    ];
    // node16/nodenext TypeScript: the import says .js/.mjs/.cjs but the file
    // on disk is the .ts flavor — the compiler rewrites at emit time.
    const extSwap = { ".js": [".ts", ".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };
    for (const [from, tos] of Object.entries(extSwap)) {
      if (base.endsWith(from)) for (const to of tos) candidates.push(base.slice(0, -from.length) + to);
    }
    for (const c of candidates) {
      const norm = path.posix.normalize(c);
      if (fileSet.has(norm)) return norm;
    }
    return null;
  }

  function resolve(fromFile, spec) {
    // 1. relative / absolute — the original behavior, plus the extension swap
    if (spec.startsWith(".") || spec.startsWith("/")) {
      const base = path.posix.join(path.posix.dirname(fromFile.split(path.sep).join("/")), spec);
      const hit = tryFile(base);
      return hit ? { internal: hit } : { unresolved: spec };
    }

    // 2. package.json "imports" — Node reserves the # prefix for these, so an
    //    unmatched #-spec can never be an external package: honest unresolved.
    if (spec.startsWith("#")) {
      const target = importsMap ? resolveSubpathMap(importsMap, spec) : null;
      if (target) {
        const hit = tryFile(target.startsWith("./") ? target.slice(2) : target);
        if (hit) return { internal: hit };
      }
      return { unresolved: spec };
    }

    // 3. tsconfig/jsconfig paths aliases
    for (const alias of aliases) {
      let remainder = null;
      if (alias.keySuffix === null) {
        if (spec === alias.keyPrefix) remainder = "";
        else continue;
      } else if (spec.startsWith(alias.keyPrefix) && spec.endsWith(alias.keySuffix)) {
        remainder = spec.slice(alias.keyPrefix.length, spec.length - alias.keySuffix.length || undefined);
      } else continue;
      for (const t of alias.targets) {
        const hit = tryFile(path.posix.join(t.prefix, remainder + t.suffix));
        if (hit) return { internal: hit };
      }
      // alias matched but no target file exists — a real broken alias, not an
      // external package; report it honestly rather than misclassifying.
      return { unresolved: spec };
    }

    // 4. self-referencing import of the package's own name via "exports"
    if (pkgName && (spec === pkgName || spec.startsWith(`${pkgName}/`))) {
      const subpath = spec === pkgName ? "." : `./${spec.slice(pkgName.length + 1)}`;
      const target = typeof exportsMap === "string" && subpath === "."
        ? exportsMap
        : resolveSubpathMap(exportsMap, subpath);
      if (target) {
        const hit = tryFile(target.startsWith("./") ? target.slice(2) : target);
        if (hit) return { internal: hit };
      }
      // fall through: a package importing its own name with no matching
      // export behaves like an external lookup at runtime too
    }

    return { external: spec };
  }

  return { resolve, aliasCount: aliases.length };
}
