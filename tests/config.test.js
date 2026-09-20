/**
 * tests/config.test.js — .mapdrc loading, precedence, JSONC comment-stripping, validation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, validateConfig, stripJsonComments, deepMerge, initConfig } from "../src/config/index.js";
import { DEFAULTS } from "../src/config/schema.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapd-cfg-"));
}

test("stripJsonComments: removes // and /* */ but preserves // inside string literals", () => {
  const src = `{
    // a comment
    "url": "https://example.com/x", /* block */
    "n": 1 // trailing
  }`;
  const stripped = stripJsonComments(src);
  const parsed = JSON.parse(stripped);
  assert.equal(parsed.url, "https://example.com/x");
  assert.equal(parsed.n, 1);
});

test("deepMerge: nested objects merge, arrays are replaced wholesale", () => {
  const base = { a: { x: 1, y: 2 }, arr: [1, 2] };
  const merged = deepMerge(base, { a: { y: 3 }, arr: [9] });
  assert.deepEqual(merged, { a: { x: 1, y: 3 }, arr: [9] });
});

test("loadConfig: defaults apply with no .mapdrc present anywhere", () => {
  const dir = tmpProject();
  const config = loadConfig(dir, { env: {}, homeDir: fs.mkdtempSync(path.join(os.tmpdir(), "mapd-home-")) });
  assert.equal(config.fix.maxAttempts, DEFAULTS.fix.maxAttempts);
  assert.equal(config.mcp.transport, "stdio");
});

test("loadConfig: precedence — project .mapdrc overrides user .mapdrc; env overrides both; CLI overrides all", () => {
  const dir = tmpProject();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-home-"));
  fs.writeFileSync(path.join(homeDir, ".mapdrc"), JSON.stringify({ fix: { maxAttempts: 5 } }));
  fs.writeFileSync(path.join(dir, ".mapdrc"), JSON.stringify({ fix: { maxAttempts: 3 } }));

  const noEnv = loadConfig(dir, { env: {}, homeDir });
  assert.equal(noEnv.fix.maxAttempts, 3, "project overrides user");

  const withEnv = loadConfig(dir, { env: { MAPD_FIX_MAX_ATTEMPTS: "7" }, homeDir });
  assert.equal(withEnv.fix.maxAttempts, 7, "env overrides project");

  const withCli = loadConfig(dir, {
    env: { MAPD_FIX_MAX_ATTEMPTS: "7" }, homeDir, cliOverrides: { fix: { maxAttempts: 9 } },
  });
  assert.equal(withCli.fix.maxAttempts, 9, "CLI overrides env");
});

test("loadConfig: throws an actionable error on malformed .mapdrc", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, ".mapdrc"), "{ not: valid json");
  assert.throws(() => loadConfig(dir, { env: {}, homeDir: fs.mkdtempSync(path.join(os.tmpdir(), "mapd-home-")) }),
    /Failed to parse/);
});

test("validateConfig: rejects out-of-range values without throwing", () => {
  const bad = deepMerge(DEFAULTS, { mapping: { confidenceThreshold: 5 }, fix: { maxAttempts: 0 } });
  const { ok, errors } = validateConfig(bad);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("confidenceThreshold")));
  assert.ok(errors.some((e) => e.includes("maxAttempts")));
});

test("validateConfig: DEFAULTS themselves are always valid", () => {
  const { ok, errors } = validateConfig(DEFAULTS);
  assert.equal(ok, true, JSON.stringify(errors));
});

test("initConfig: writes a starter .mapdrc and refuses to overwrite without --force", () => {
  const dir = tmpProject();
  const first = initConfig(dir);
  assert.equal(first.ok, true);
  assert.ok(fs.existsSync(first.path));

  const second = initConfig(dir);
  assert.equal(second.ok, false);

  const forced = initConfig(dir, { force: true });
  assert.equal(forced.ok, true);
});

test("initConfig: never writes secret values (only structural defaults)", () => {
  const dir = tmpProject();
  process.env.ANTHROPIC_API_KEY = "sk-should-never-appear";
  try {
    initConfig(dir);
    const body = fs.readFileSync(path.join(dir, ".mapdrc"), "utf8");
    assert.ok(!body.includes("sk-should-never-appear"));
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});
