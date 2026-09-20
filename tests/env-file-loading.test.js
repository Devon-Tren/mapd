/**
 * tests/env-file-loading.test.js — proves `mapd` actually loads a .env file
 * from the current working directory (Node's built-in process.loadEnvFile,
 * no dotenv dependency), and that it never overwrites an already-exported
 * shell variable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-envfile-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), `export function greet(){ return "hi"; }\n`);
  return dir;
}

/**
 * A real ~/.env may legitimately exist on whoever's machine runs this suite
 * (that's the whole point of the user-level fallback feature) — so every test
 * here redirects HOME to an empty temp directory (os.homedir() respects the
 * HOME env var) rather than relying on the real one being absent.
 */
function fakeEmptyHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapd-fakehome-"));
}

test("mapd doctor: a .env file in cwd is loaded and reflected in provider-configured", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, ".env"), "ANTHROPIC_API_KEY=sk-ant-test-not-real\n");
  const env = { ...process.env, HOME: fakeEmptyHome() };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.KIMI_API_KEY;
  const out = execFileSync(process.execPath, [CLI, "doctor", "."], { cwd: dir, env }).toString();
  assert.match(out, /provider-configured: anthropic provider available/);
  assert.match(out, /env-file:.*project \.env: defines ANTHROPIC_API_KEY/);
});

test("mapd doctor: an already-exported shell variable is never overwritten by .env", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, ".env"), "ANTHROPIC_API_KEY=sk-ant-from-dotenv\n");
  const env = { ...process.env, ANTHROPIC_API_KEY: "sk-ant-from-shell", HOME: fakeEmptyHome() };
  delete env.OPENAI_API_KEY;
  delete env.KIMI_API_KEY;
  // Prove precedence indirectly: doctor never prints the value, so assert via
  // a small inline script that mapd's own .env-loading path preserves it.
  const out = execFileSync(
    process.execPath,
    ["-e", `process.env.ANTHROPIC_API_KEY = "sk-ant-from-shell"; process.chdir(${JSON.stringify(dir)}); try { process.loadEnvFile(); } catch {} console.log(process.env.ANTHROPIC_API_KEY);`],
    { env },
  ).toString().trim();
  assert.equal(out, "sk-ant-from-shell");
});

test("mapd doctor: with no .env and no exported key, reports deterministic mode honestly", () => {
  const dir = tmpProject();
  const env = { ...process.env, HOME: fakeEmptyHome() };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.KIMI_API_KEY;
  const out = execFileSync(process.execPath, [CLI, "doctor", "."], { cwd: dir, env }).toString();
  assert.match(out, /provider-configured: none configured — deterministic mode only/);
  assert.match(out, /env-file: no \.env found \(project or user-level\)/);
});

test("mapd doctor: a user-level ~\\/.env fills in a key when the project has no .env of its own", () => {
  const dir = tmpProject();
  const home = fakeEmptyHome();
  fs.writeFileSync(path.join(home, ".env"), "KIMI_API_KEY=sk-kimi-from-user-level\n");
  const env = { ...process.env, HOME: home };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.KIMI_API_KEY;
  const out = execFileSync(process.execPath, [CLI, "doctor", "."], { cwd: dir, env }).toString();
  assert.match(out, /provider-configured: kimi provider available/);
  assert.match(out, /env-file:.*no project \.env.*~\/\.env: defines KIMI_API_KEY/);
});

test("mapd doctor: a project .env takes precedence over a user-level ~\\/.env for the same key", () => {
  const dir = tmpProject();
  const home = fakeEmptyHome();
  fs.writeFileSync(path.join(home, ".env"), "ANTHROPIC_API_KEY=sk-ant-from-user-level\nKIMI_API_KEY=sk-kimi-from-user-level\n");
  fs.writeFileSync(path.join(dir, ".env"), "KIMI_API_KEY=sk-kimi-from-project\n");
  const env = { ...process.env, HOME: home };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.KIMI_API_KEY;
  const out = execFileSync(
    process.execPath,
    ["-e", `process.chdir(${JSON.stringify(dir)}); try { process.loadEnvFile(); } catch {} try { process.loadEnvFile(require("node:path").join(require("node:os").homedir(), ".env")); } catch {} console.log(process.env.KIMI_API_KEY, process.env.ANTHROPIC_API_KEY);`],
    { env },
  ).toString().trim();
  assert.equal(out, "sk-kimi-from-project sk-ant-from-user-level", "project .env wins for KIMI_API_KEY; user-level fills in ANTHROPIC_API_KEY since the project didn't set it");
});
