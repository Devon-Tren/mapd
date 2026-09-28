/**
 * modelResolver.js — which Claude model Map'd talks to, kept current without
 * a release: by default it asks Anthropic's Models API for the newest
 * `claude-sonnet-*` and uses that.
 *
 * Precedence (first wins):
 *   1. MAPD_MODEL env / .mapdrc providers.anthropic.model — an explicit pin.
 *      The words "latest" / "auto" / "" mean "no pin".
 *   2. ~/.mapd/model-cache.json, if resolved within the last 24h.
 *   3. models.list() (newest first) → the most recent claude-sonnet-* id.
 *   4. FALLBACK_SONNET, if the lookup fails (offline, key lacks the scope…).
 *
 * Never throws: a model lookup must not be the reason a chat answer fails.
 * `source` is reported with the model so doctor/proposals can say which rule picked it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FALLBACK_SONNET = "claude-sonnet-5";
const TTL_MS = 24 * 60 * 60 * 1000;
const UNPINNED = new Set(["", "latest", "auto", "latest-sonnet"]);
const SONNET_RE = /^claude-sonnet-/;

export function modelCachePath() {
  return path.join(os.homedir(), ".mapd", "model-cache.json");
}

/** An explicit pin from env/config, or null when Map'd should pick the latest Sonnet. */
export function pinnedModel(config = {}) {
  const raw = (process.env.MAPD_MODEL ?? config.providers?.anthropic?.model ?? "").trim();
  return UNPINNED.has(raw.toLowerCase()) ? null : raw;
}

/** Newest Sonnet in a models.list() page: by created_at, falling back to API order (already newest first). */
export function pickLatestSonnet(models) {
  const sonnets = (models ?? []).filter((m) => SONNET_RE.test(m?.id ?? ""));
  if (!sonnets.length) return null;
  const ts = (m) => Date.parse(m.created_at ?? "") || 0;
  return [...sonnets].sort((a, b) => ts(b) - ts(a))[0].id;
}

function readCache(file, now) {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof c.model === "string" && SONNET_RE.test(c.model) && now - Date.parse(c.resolvedAt) < TTL_MS) return c.model;
  } catch { /* missing or corrupt → resolve fresh */ }
  return null;
}

function writeCache(file, model, now) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ model, resolvedAt: new Date(now).toISOString() }, null, 2));
  } catch { /* read-only home: still works, just re-resolves next run */ }
}

/**
 * Resolve the model for one process. `client` is an Anthropic SDK client (or
 * anything with models.list()). Returns { model, source }.
 */
export async function resolveAnthropicModel(client, { config = {}, cacheFile = modelCachePath(), now = Date.now() } = {}) {
  const pin = pinnedModel(config);
  if (pin) return { model: pin, source: "pinned" };
  const cached = readCache(cacheFile, now);
  if (cached) return { model: cached, source: "cache" };
  try {
    const page = await client.models.list({ limit: 100 });
    const latest = pickLatestSonnet(page?.data);
    if (latest) {
      writeCache(cacheFile, latest, now);
      return { model: latest, source: "models-api" };
    }
  } catch { /* fall through */ }
  return { model: FALLBACK_SONNET, source: "fallback" };
}

/** Synchronous, network-free description of the model choice — for doctor. */
export function describeModelChoice(config = {}, { cacheFile = modelCachePath(), now = Date.now() } = {}) {
  const pin = pinnedModel(config);
  if (pin) return `${pin} (pinned via ${process.env.MAPD_MODEL ? "MAPD_MODEL" : ".mapdrc"})`;
  const cached = readCache(cacheFile, now);
  return cached
    ? `${cached} (newest Sonnet, from the Models API within the last 24h)`
    : `newest Sonnet — looked up on first use (${FALLBACK_SONNET} if the lookup fails)`;
}
