/**
 * tests/model-resolver.test.js — Map'd follows the newest Claude Sonnet without
 * a release, but an explicit pin always wins and a failed lookup never breaks a call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAnthropicModel, pickLatestSonnet, FALLBACK_SONNET } from "../src/agents/modelResolver.js";

const tmpCache = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mapd-model-")), "model-cache.json");
const listing = (data) => ({ models: { list: async () => ({ data }) }, calls: 0 });
const MODELS = [
  { id: "claude-opus-5", created_at: "2026-05-01T00:00:00Z" },
  { id: "claude-sonnet-4-6", created_at: "2025-10-01T00:00:00Z" },
  { id: "claude-sonnet-5", created_at: "2026-04-01T00:00:00Z" },
  { id: "claude-haiku-4-5", created_at: "2025-10-15T00:00:00Z" },
];

test("picks the newest claude-sonnet-* by created_at, ignoring other families", () => {
  assert.equal(pickLatestSonnet(MODELS), "claude-sonnet-5");
  assert.equal(pickLatestSonnet([{ id: "claude-sonnet-6", created_at: "2027-01-01T00:00:00Z" }, ...MODELS]), "claude-sonnet-6");
  assert.equal(pickLatestSonnet([{ id: "claude-opus-5" }]), null);
});

test("unpinned: resolves via the Models API, then serves from the 24h cache without calling again", async () => {
  const saved = process.env.MAPD_MODEL; delete process.env.MAPD_MODEL;
  try {
    const cacheFile = tmpCache();
    let calls = 0;
    const client = { models: { list: async () => { calls++; return { data: MODELS }; } } };
    const now = Date.parse("2026-09-28T12:00:00Z");
    assert.deepEqual(await resolveAnthropicModel(client, { cacheFile, now }), { model: "claude-sonnet-5", source: "models-api" });
    assert.deepEqual(await resolveAnthropicModel(client, { cacheFile, now: now + 3600_000 }), { model: "claude-sonnet-5", source: "cache" });
    assert.equal(calls, 1);
    // stale after 24h → looks again
    await resolveAnthropicModel(client, { cacheFile, now: now + 25 * 3600_000 });
    assert.equal(calls, 2);
  } finally { if (saved !== undefined) process.env.MAPD_MODEL = saved; }
});

test("an explicit pin wins over the lookup; 'latest' is not a pin", async () => {
  const saved = process.env.MAPD_MODEL; delete process.env.MAPD_MODEL;
  try {
    const client = listing(MODELS);
    const cacheFile = tmpCache();
    assert.deepEqual(await resolveAnthropicModel(client, { cacheFile, config: { providers: { anthropic: { model: "claude-opus-5" } } } }), { model: "claude-opus-5", source: "pinned" });
    assert.equal((await resolveAnthropicModel(client, { cacheFile, config: { providers: { anthropic: { model: "latest" } } } })).source, "models-api");
    process.env.MAPD_MODEL = "claude-haiku-4-5";
    assert.equal((await resolveAnthropicModel(client, { cacheFile })).model, "claude-haiku-4-5");
  } finally { if (saved === undefined) delete process.env.MAPD_MODEL; else process.env.MAPD_MODEL = saved; }
});

test("a failed lookup falls back without throwing and without caching the fallback", async () => {
  const saved = process.env.MAPD_MODEL; delete process.env.MAPD_MODEL;
  try {
    const cacheFile = tmpCache();
    const client = { models: { list: async () => { throw new Error("403 forbidden"); } } };
    assert.deepEqual(await resolveAnthropicModel(client, { cacheFile }), { model: FALLBACK_SONNET, source: "fallback" });
    assert.equal(fs.existsSync(cacheFile), false);
  } finally { if (saved !== undefined) process.env.MAPD_MODEL = saved; }
});
