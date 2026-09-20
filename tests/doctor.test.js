/**
 * tests/doctor.test.js — `mapd doctor` health checks: each check reflects
 * real, observable state (no fabricated pass/fail).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { runDoctor } from "../src/core/doctor.js";
import { saveBaseline } from "../src/core/regression.js";
import { buildScoredGraph } from "../src/core/intelligence.js";

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-doctor-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "index.js", type: "module", scripts: { test: "node -e 1" } }));
  fs.writeFileSync(path.join(dir, "index.js"), `export function greet(){ return "hi"; }\n`);
  return dir;
}

test("runDoctor: reports no baseline, no git, and a valid config on a fresh project", () => {
  const dir = tmpProject();
  const { ok, checks } = runDoctor(dir);
  assert.equal(ok, true);
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
  assert.match(byName["baseline-health"].detail, /none/);
  assert.match(byName["git-availability"].detail, /no git repository/);
  assert.equal(byName["config-valid"].ok, true);
  assert.match(byName["project-scripts"].detail, /test/);
  assert.match(byName["provider-configured"].detail, /none configured/);
});

test("runDoctor: detects a git repository when one is present", () => {
  const dir = tmpProject();
  execSync("git init -q -b main", { cwd: dir });
  const { checks } = runDoctor(dir);
  const gitCheck = checks.find((c) => c.name === "git-availability");
  assert.match(gitCheck.detail, /git repository detected/);
});

test("runDoctor: reports a present, schema-current baseline after `mapd baseline`", () => {
  const dir = tmpProject();
  saveBaseline(dir, buildScoredGraph(dir));
  const { checks } = runDoctor(dir);
  const baselineCheck = checks.find((c) => c.name === "baseline-health");
  assert.equal(baselineCheck.ok, true);
  assert.match(baselineCheck.detail, /present and schema-current/);
});

test("runDoctor: flags an invalid .mapdrc without crashing", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, ".mapdrc"), JSON.stringify({ fix: { maxAttempts: -1 } }));
  const { ok, checks } = runDoctor(dir);
  assert.equal(ok, false);
  const configCheck = checks.find((c) => c.name === "config-valid");
  assert.equal(configCheck.ok, false);
});

test("runDoctor: confirms .mapd directory is writable", () => {
  const dir = tmpProject();
  const { checks } = runDoctor(dir);
  const writable = checks.find((c) => c.name === "mapd-dir-writable");
  assert.equal(writable.ok, true);
});

// NOTE: these tests never assert on the ~/.env (user-level) portion of the
// env-file detail string — a real ~/.env may legitimately exist on whoever's
// machine runs the suite (that's the whole point of the feature), so only
// the project-level portion (fully controlled by the tmpdir fixture) is a
// safe, deterministic thing to assert on.

test("runDoctor: reports no .env at all when neither project nor a real user-level ~/.env exists", () => {
  const dir = tmpProject();
  // A real ~/.env may legitimately exist on whoever's machine runs this test
  // (that's the point of the user-level fallback) — redirect HOME to a fresh
  // empty directory so this specific "neither exists" case is deterministic.
  const originalHome = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-fakehome-"));
  try {
    const { checks } = runDoctor(dir);
    const envCheck = checks.find((c) => c.name === "env-file");
    assert.equal(envCheck.ok, true);
    assert.match(envCheck.detail, /no \.env found \(project or user-level\)/);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("runDoctor: detects a project .env file and names which recognized keys it defines — never prints the value", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, ".env"), "ANTHROPIC_API_KEY=sk-ant-supersecretvalue12345\nSOME_OTHER_APP_VAR=x\n");
  const { checks } = runDoctor(dir);
  const envCheck = checks.find((c) => c.name === "env-file");
  assert.match(envCheck.detail, /project \.env: defines ANTHROPIC_API_KEY/);
  assert.ok(!envCheck.detail.includes("supersecretvalue"), "the actual secret value must never appear in doctor output");
});

test("runDoctor: a project .env with no recognized keys is reported honestly, not silently ignored", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, ".env"), "SOME_UNRELATED_VAR=x\n");
  const { checks } = runDoctor(dir);
  const envCheck = checks.find((c) => c.name === "env-file");
  assert.match(envCheck.detail, /project \.env: present, no recognized provider keys/);
});

test("runDoctor: findings-freshness reports 'no reports yet' before any check/modernize has run", () => {
  const dir = tmpProject();
  const { checks } = runDoctor(dir);
  const freshness = checks.find((c) => c.name === "findings-freshness");
  assert.equal(freshness.ok, true);
  assert.match(freshness.detail, /no check\/modernize reports/);
});

test("runDoctor: findings-freshness fails when a report predates a more recent source change", () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, ".mapd"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".mapd", "findings.json"), JSON.stringify({ generatedAt: new Date(Date.now() - 60_000).toISOString(), findings: [] }));
  fs.writeFileSync(path.join(dir, "index.js"), `export function greet(){ return "hi"; }\n// changed after the report\n`);

  const { ok, checks } = runDoctor(dir);
  const freshness = checks.find((c) => c.name === "findings-freshness");
  assert.equal(freshness.ok, false);
  assert.match(freshness.detail, /STALE.*findings\.json/);
  assert.equal(ok, false, "a stale-findings check must fail overall doctor status, not be silently swallowed");
});
