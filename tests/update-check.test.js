/**
 * tests/update-check.test.js — mapd announces a newer npm release, checks the
 * registry at most once a day, and never gets in the way of a command.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isNewer, shouldCheck, updateNotice, refreshUpdateCache } from "../src/core/updateCheck.js";

const tmpCache = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mapd-upd-")), "update-check.json");
const registry = (version, calls = { n: 0 }) => Object.assign(async () => { calls.n++; return { ok: true, json: async () => ({ version }) }; }, { calls });

test("version comparison is numeric, not lexical", () => {
  assert.equal(isNewer("0.21.10", "0.21.9"), true);
  assert.equal(isNewer("0.22.0", "0.21.99"), true);
  assert.equal(isNewer("0.21.0", "0.21.0"), false);
  assert.equal(isNewer("0.20.9", "0.21.0"), false);
});

test("notice appears only when the registry has something newer", async () => {
  const cacheFile = tmpCache();
  await refreshUpdateCache("@dev-tren/mapd", { cacheFile, fetchImpl: registry("0.21.1") });
  assert.match(updateNotice("0.21.0", "@dev-tren/mapd", { cacheFile }), /0\.21\.1 is available .* npm install -g @dev-tren\/mapd/);
  assert.equal(updateNotice("0.21.1", "@dev-tren/mapd", { cacheFile }), null);
});

test("the registry is asked at most once a day, and a failure never throws", async () => {
  const cacheFile = tmpCache();
  const calls = { n: 0 };
  const now = Date.parse("2026-09-30T12:00:00Z");
  await refreshUpdateCache("@dev-tren/mapd", { cacheFile, now, fetchImpl: registry("0.21.1", calls) });
  await refreshUpdateCache("@dev-tren/mapd", { cacheFile, now: now + 3600_000, fetchImpl: registry("0.21.1", calls) });
  assert.equal(calls.n, 1);
  const failing = async () => { throw new Error("offline"); };
  const r = await refreshUpdateCache("@dev-tren/mapd", { cacheFile, now: now + 25 * 3600_000, fetchImpl: failing });
  assert.equal(r.latest, "0.21.1", "keeps the last known answer");
});

test("stays silent for CI, pipes, --json, mcp, opt-out, and source checkouts", () => {
  const installed = "/usr/lib/node_modules/@dev-tren/mapd/src/core/updateCheck.js";
  const base = { argv: ["node", "mapd", "map"], env: {}, isTTY: true, modulePath: installed };
  assert.equal(shouldCheck(base), true);
  assert.equal(shouldCheck({ ...base, env: { CI: "true" } }), false);
  assert.equal(shouldCheck({ ...base, env: { MAPD_NO_UPDATE_CHECK: "1" } }), false);
  assert.equal(shouldCheck({ ...base, isTTY: false }), false);
  assert.equal(shouldCheck({ ...base, argv: ["node", "mapd", "map", "--json"] }), false);
  assert.equal(shouldCheck({ ...base, argv: ["node", "mapd", "mcp"] }), false);
  assert.equal(shouldCheck({ ...base, modulePath: "/Users/x/Downloads/mapd-v0/src/core/updateCheck.js" }), false);
});
