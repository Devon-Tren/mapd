/**
 * parseCache.js - persistent, content-hash keyed parser cache.
 *
 * parseProject already knows how to reuse a Map of rel -> {hash,node}; this
 * module only persists that Map between CLI/chat/MCP processes. The cache is
 * intentionally a performance artifact: unreadable, stale, or schema-mismatched
 * cache files are ignored and rebuilt from source.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const CACHE_SCHEMA = 1;
const PARSER_SEMANTICS_VERSION = 2;

function cacheDir(rootDir) {
  return path.join(path.resolve(rootDir), ".mapd", "cache");
}

export function parseCachePath(rootDir) {
  return path.join(cacheDir(rootDir), "parse-v1.json");
}

export function parserConfigSignature(config = {}) {
  const payload = {
    parser: PARSER_SEMANTICS_VERSION,
    include: config.project?.include ?? [],
    exclude: config.project?.exclude ?? [],
    maxFileSizeBytes: config.mapping?.maxFileSizeBytes ?? null,
  };
  return crypto.createHash("sha1").update(JSON.stringify(payload)).digest("hex");
}

export function loadPersistentParseCache(rootDir, config = {}) {
  const p = parseCachePath(rootDir);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(p, "utf8")); } catch { return new Map(); }
  if (raw?.mapdSchema !== CACHE_SCHEMA) return new Map();
  if (raw?.configSignature !== parserConfigSignature(config)) return new Map();
  const entries = raw.entries && typeof raw.entries === "object" ? raw.entries : {};
  return new Map(Object.entries(entries));
}

export function savePersistentParseCache(rootDir, config = {}, cache = new Map()) {
  const dir = cacheDir(rootDir);
  fs.mkdirSync(dir, { recursive: true });
  const p = parseCachePath(rootDir);
  const tmp = path.join(dir, `parse-v1.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const body = {
    mapdSchema: CACHE_SCHEMA,
    configSignature: parserConfigSignature(config),
    savedAt: new Date().toISOString(),
    entries: Object.fromEntries(cache),
  };
  fs.writeFileSync(tmp, JSON.stringify(body));
  try {
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw e;
  }
  return p;
}
