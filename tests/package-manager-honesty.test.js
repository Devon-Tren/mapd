/**
 * tests/package-manager-honesty.test.js — regression tests for a real bug:
 * doctor.js previously hardcoded `true`/"npm" for node-version and
 * package-manager checks regardless of actual state. This proves those
 * checks now reflect reality, and that FIX-G2 / chat dev-commands actually
 * detect and use the project's real package manager instead of assuming npm.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor } from "../src/core/doctor.js";
import { detectPackageManager } from "../src/core/graph.js";
import { runProjectCorrectnessGate } from "../src/core/gates.js";
import { classifyCommand } from "../src/core/policy.js";

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-pm-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), `export function greet(){ return "hi"; }\n`);
  return dir;
}

test("detectPackageManager: distinguishes pnpm, yarn, npm, and bun by lockfile — never defaults to npm when another is present", () => {
  for (const [file, manager] of [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["package-lock.json", "npm"], ["bun.lockb", "bun"]]) {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, file), "");
    assert.deepEqual(detectPackageManager(dir), { manager, lockfile: file });
  }
});

test("detectPackageManager: falls back to npm only when no lockfile exists, and says so explicitly via lockfile:null", () => {
  const dir = tmpProject();
  const result = detectPackageManager(dir);
  assert.equal(result.manager, "npm");
  assert.equal(result.lockfile, null);
});

test("runDoctor: node-version check reflects the actual running Node version, not a hardcoded pass", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", engines: { node: ">=20" } }));
  const { checks } = runDoctor(dir);
  const nodeCheck = checks.find((c) => c.name === "node-version");
  const actualMajor = parseInt(process.versions.node.split(".")[0], 10);
  assert.equal(nodeCheck.ok, actualMajor >= 20);
  assert.match(nodeCheck.detail, new RegExp(process.version.replace(/\./g, "\\.")));
});

test("runDoctor: node-version check fails honestly when engines.node requires a version higher than what's running", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", engines: { node: ">=999" } }));
  const { checks } = runDoctor(dir);
  const nodeCheck = checks.find((c) => c.name === "node-version");
  assert.equal(nodeCheck.ok, false);
});

test("runDoctor: package-manager check reports the real detected manager, not always npm", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
  const { checks } = runDoctor(dir);
  const pmCheck = checks.find((c) => c.name === "package-manager");
  assert.match(pmCheck.detail, /pnpm/);
  assert.doesNotMatch(pmCheck.detail, /^npm/);
});

test("runDoctor: package-manager check fails honestly when the detected manager isn't on PATH", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "yarn.lock"), "");
  const originalPath = process.env.PATH;
  process.env.PATH = ""; // simulate no package managers resolvable
  try {
    const { checks } = runDoctor(dir);
    const pmCheck = checks.find((c) => c.name === "package-manager");
    assert.equal(pmCheck.ok, false);
    assert.match(pmCheck.detail, /NOT found on PATH/);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("runProjectCorrectnessGate: uses the project's real package manager (yarn), not a hardcoded npm invocation", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "yarn.lock"), "");
  const pkg = { name: "t", type: "module", scripts: { test: "node -e 1" } };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  // yarn is very unlikely to be installed in this sandboxed CI-like environment,
  // so the gate must report a real, honest failure — never a fabricated pass —
  // and the script label must reflect that yarn (not npm) was actually invoked.
  const g = runProjectCorrectnessGate({ cwd: dir, pkg, runLint: false, runTypecheck: false });
  assert.equal(g.checks[0].script, "yarn test");
});

test("policy.classifyCommand: recognizes pnpm/yarn/bun test invocations identically to npm (never assumes only npm exists)", () => {
  for (const manager of ["npm", "yarn", "pnpm", "bun"]) {
    assert.equal(classifyCommand(manager, ["test"]).classification, "verification");
    assert.equal(classifyCommand(manager, ["install"]).classification, "dependency-mutation");
  }
});
