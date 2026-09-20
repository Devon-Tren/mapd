/**
 * tests/json-output.test.js — the JSON-everywhere polish: check / review /
 * modernize must emit parseable JSON on --json, and --json must NOT weaken
 * behavior — check still saves findings and still sets the CI exit code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

function run(args, cwd) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { cwd }).toString() };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? "").toString() };
  }
}

function project(helperSrc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-json-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "entry.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "entry.js"), `import { helper } from "./helper.js";\nexport function run(){ return helper(); }\nrun();\n`);
  fs.writeFileSync(path.join(dir, "helper.js"), helperSrc);
  return dir;
}

test("modernize --json emits a parseable report", () => {
  const { out } = run(["modernize", "light", ".", "--json"], project(`export function helper(){ return 1; }\n`));
  const j = JSON.parse(out);
  assert.ok(Array.isArray(j.findings));
  assert.equal(typeof j.mode, "string");
});

test("review --json emits the queue as structured data", () => {
  const { out } = run(["review", ".", "--json"], project(`export function helper(){ return 1; }\n`));
  const j = JSON.parse(out);
  assert.ok(Array.isArray(j.items));
  assert.equal(typeof j.count, "number");
});

test("check --json emits findings + confidence delta and STILL exits 2 on a high-severity regression", () => {
  const dir = project(`export function helper(){ return 1; }\nexport function extra(){ return 2; }\n`);
  run(["baseline", dir], dir);
  fs.writeFileSync(path.join(dir, "helper.js"), `export function helper(){ return 1; }\n`); // remove an export
  const { code, out } = run(["check", dir, "--json"], dir);
  const j = JSON.parse(out);
  assert.equal(j.ok, true);
  assert.ok(j.findings.some((f) => f.kind === "export-removed"));
  assert.ok(j.confidence && "from" in j.confidence && "to" in j.confidence);
  assert.equal(code, 2, "--json must not suppress the CI exit code");
});

test("check --json on a clean re-check reports zero findings and exits 0", () => {
  const dir = project(`export function helper(){ return 1; }\n`);
  run(["baseline", dir], dir);
  const { code, out } = run(["check", dir, "--json"], dir);
  const j = JSON.parse(out);
  assert.deepEqual(j.findings, []);
  assert.equal(code, 0);
});
