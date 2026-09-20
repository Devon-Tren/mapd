/**
 * config/index.js — .mapdrc loading, precedence, and validation.
 *
 * Precedence (later wins): DEFAULTS < user `~/.mapdrc` < project `.mapdrc`
 * < `MAPD_*` env vars < explicit CLI overrides.
 *
 * Format: JSONC-lite — plain JSON with `//` and /* *\/ comments stripped,
 * respecting string literals so a `//` inside a string value is never
 * mistaken for a comment. No YAML dependency.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DEFAULTS, validateAgainstSchema, ANNOTATION_CLASSIFICATIONS } from "./schema.js";
import { applyRealTreeWrite } from "../core/changes.js";

/** Strip //-line and /* *\/-block comments from JSONC, respecting string literals. */
export function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let stringQuote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inString) {
      out += c;
      if (c === "\\") { out += next ?? ""; i++; continue; }
      if (c === stringQuote) inString = false;
      continue;
    }
    if (c === '"' || c === "'") { inString = true; stringQuote = c; out += c; continue; }
    if (c === "/" && next === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // consume the closing '/'
      continue;
    }
    out += c;
  }
  return out;
}

function readMapdrc(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(stripJsonComments(fs.readFileSync(filePath, "utf8")));
  } catch (e) {
    throw new Error(`Failed to parse ${filePath}: ${e.message}`);
  }
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

export function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function setPath(obj, dotted, value) {
  const parts = dotted.split(".");
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    node[parts[i]] = isPlainObject(node[parts[i]]) ? node[parts[i]] : {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

/** Recognized MAPD_* env overrides, mapped onto config paths. Documented, not "magic generic". */
const ENV_MAP = {
  MAPD_PROVIDER: { path: "chat.provider", parse: (v) => v },
  MAPD_MODEL: { path: "chat.model", parse: (v) => v },
  MAPD_FIX_MAX_ATTEMPTS: { path: "fix.maxAttempts", parse: (v) => parseInt(v, 10) },
  MAPD_MCP_TRANSPORT: { path: "mcp.transport", parse: (v) => v },
  MAPD_ALLOW_DESTRUCTIVE: { path: "security.allowDestructiveCommands", parse: (v) => v === "true" || v === "1" },
  MAPD_ALLOW_NETWORK: { path: "security.allowNetworkCommands", parse: (v) => v === "true" || v === "1" },
};

function envOverrides(env) {
  const out = {};
  for (const [key, { path: p, parse }] of Object.entries(ENV_MAP)) {
    if (env[key] !== undefined) setPath(out, p, parse(env[key]));
  }
  return out;
}

/**
 * Load and merge configuration. Never throws for missing files; throws only
 * on a malformed .mapdrc so the user gets an actionable parse error.
 */
export function loadConfig(rootDir, { cliOverrides = {}, env = process.env, homeDir = os.homedir() } = {}) {
  const abs = path.resolve(rootDir);
  const userRc = readMapdrc(path.join(homeDir, ".mapdrc")) ?? {};
  const projectRc = readMapdrc(path.join(abs, ".mapdrc")) ?? {};
  const envRc = envOverrides(env);

  let merged = deepMerge(DEFAULTS, userRc);
  merged = deepMerge(merged, projectRc);
  merged = deepMerge(merged, envRc);
  merged = deepMerge(merged, cliOverrides);
  return merged;
}

/** Structural + schema validation. Never throws — returns {ok, errors}. */
export function validateConfig(config) {
  const errors = [];
  if (!isPlainObject(config)) return { ok: false, errors: ["config must be an object"] };
  for (const section of ["project", "mapping", "chat", "fix", "mcp", "security", "providers"]) {
    if (config[section] !== undefined && !isPlainObject(config[section])) {
      errors.push(`${section}: must be an object`);
    }
  }
  errors.push(...validateAgainstSchema(config));
  return { ok: errors.length === 0, errors };
}

export function mapdrcPath(rootDir) {
  return path.join(path.resolve(rootDir), ".mapdrc");
}

/**
 * Annotation memory (`mapd annotate ...`) — user-asserted classifications for
 * things static analysis structurally cannot know, persisted in the PROJECT
 * .mapdrc under project.annotations so every surface (cli/chat/mcp/handoff/
 * solutions) sees them through the normal config merge. Editing rewrites the
 * file as pretty JSON; if the existing .mapdrc had JSONC comments they are
 * not preserved, and `hadComments` is returned so callers can say so instead
 * of silently eating documentation. The write goes through
 * applyRealTreeWrite — .mapdrc is a real project file, so the edit is
 * recorded as a rollback-able change like every other real-tree mutation.
 */
export function setAnnotation(rootDir, pattern, classification) {
  if (!ANNOTATION_CLASSIFICATIONS.includes(classification)) {
    return { ok: false, reason: `classification must be one of ${ANNOTATION_CLASSIFICATIONS.map((c) => `"${c}"`).join(", ")} (got "${classification}")` };
  }
  const p = mapdrcPath(rootDir);
  const raw = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  let rc;
  try {
    rc = raw === null ? {} : JSON.parse(stripJsonComments(raw));
  } catch (e) {
    return { ok: false, reason: `cannot edit ${p}: ${e.message}` };
  }
  rc.project = isPlainObject(rc.project) ? rc.project : {};
  rc.project.annotations = isPlainObject(rc.project.annotations) ? rc.project.annotations : {};
  const replaced = Object.prototype.hasOwnProperty.call(rc.project.annotations, pattern);
  rc.project.annotations[pattern] = classification;
  const change = applyRealTreeWrite(rootDir, ".mapdrc", JSON.stringify(rc, null, 2) + "\n", "annotate");
  return { ok: true, path: p, pattern, classification, replaced, changeId: change.id, hadComments: raw !== null && stripJsonComments(raw) !== raw };
}

export function removeAnnotation(rootDir, pattern) {
  const p = mapdrcPath(rootDir);
  if (!fs.existsSync(p)) return { ok: false, reason: `no .mapdrc at ${p}` };
  const raw = fs.readFileSync(p, "utf8");
  let rc;
  try {
    rc = JSON.parse(stripJsonComments(raw));
  } catch (e) {
    return { ok: false, reason: `cannot edit ${p}: ${e.message}` };
  }
  if (!isPlainObject(rc.project?.annotations) || !Object.prototype.hasOwnProperty.call(rc.project.annotations, pattern)) {
    return { ok: false, reason: `no annotation for pattern "${pattern}" in ${p}` };
  }
  delete rc.project.annotations[pattern];
  const change = applyRealTreeWrite(rootDir, ".mapdrc", JSON.stringify(rc, null, 2) + "\n", "annotate");
  return { ok: true, path: p, pattern, changeId: change.id, hadComments: stripJsonComments(raw) !== raw };
}

/** The fully-resolved annotation map (defaults + user + project + env), for listing. */
export function listAnnotations(rootDir) {
  const resolved = loadConfig(rootDir);
  return resolved.project?.annotations ?? {};
}

/** `mapd config init` — writes a commented starter .mapdrc from DEFAULTS. Never overwrites silently. */
export function initConfig(rootDir, { force = false } = {}) {
  const p = mapdrcPath(rootDir);
  if (fs.existsSync(p) && !force) {
    return { ok: false, path: p, reason: "already exists (use --force to overwrite)" };
  }
  const body =
    "// Map'd project configuration (JSONC — // and /* */ comments are stripped before parsing).\n" +
    "// See README.md \"Configuration\" for the full field reference.\n" +
    JSON.stringify(DEFAULTS, null, 2) + "\n";
  fs.writeFileSync(p, body);
  return { ok: true, path: p };
}
