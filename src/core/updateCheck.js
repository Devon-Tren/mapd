/**
 * updateCheck.js — tell the user when npm has a newer mapd.
 *
 * Once per 24h it asks the registry for the latest version (1.5s cap, never
 * fails a command) and caches the answer in ~/.mapd/update-check.json; the
 * notice itself is printed from that cache, to stderr, after the command ran.
 *
 * Silent when output is not an interactive terminal, in CI, with --json, for
 * `mapd mcp` (stdio is a protocol), when running from a source checkout
 * rather than an npm install, or with MAPD_NO_UPDATE_CHECK=1.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TTL_MS = 24 * 60 * 60 * 1000;

export function updateCachePath() {
  return path.join(os.homedir(), ".mapd", "update-check.json");
}

/** a > b for plain x.y.z versions (prerelease tags are never offered). */
export function isNewer(a, b) {
  const [x, y] = [a, b].map((v) => String(v).split(".").map((n) => Number.parseInt(n, 10) || 0));
  return (x[0] - y[0] || x[1] - y[1] || x[2] - y[2]) > 0;
}

export function shouldCheck({ argv = process.argv, env = process.env, isTTY = process.stderr.isTTY, modulePath = fileURLToPath(import.meta.url) } = {}) {
  if (!isTTY || env.CI || env.MAPD_NO_UPDATE_CHECK) return false;
  if (argv.includes("--json") || argv.slice(2).includes("mcp")) return false;
  return modulePath.split(path.sep).includes("node_modules"); // a dev checkout updates via git, not npm
}

function readCache(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** The one-line notice, or null — from the cache only, no network. */
export function updateNotice(current, name, { cacheFile = updateCachePath() } = {}) {
  const latest = readCache(cacheFile)?.latest;
  return latest && isNewer(latest, current)
    ? `mapd ${latest} is available (you have ${current}) — npm install -g ${name}`
    : null;
}

/** Refresh the cache if it is older than a day. Never throws. */
export async function refreshUpdateCache(name, { cacheFile = updateCachePath(), now = Date.now(), fetchImpl = globalThis.fetch, timeoutMs = 1500 } = {}) {
  const cached = readCache(cacheFile);
  if (cached && now - Date.parse(cached.checkedAt) < TTL_MS) return cached;
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/${name.replace("/", "%2f")}/latest`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return cached;
    const { version } = await res.json();
    if (typeof version !== "string") return cached;
    const entry = { latest: version, checkedAt: new Date(now).toISOString() };
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(entry, null, 2));
    return entry;
  } catch {
    return cached; // offline / slow registry: try again next run
  }
}
