/**
 * tests/command-consolidation.test.js — the new consolidated CLI surface
 * (7 top-level commands + `tools`): `check --save-baseline` replacing
 * `baseline`, `map`'s status-fold, `map --view`, `fix review`/`fix evidence`
 * replacing `review`/`evidence`, `config annotate` replacing `annotate`,
 * `tools docs/modernize/test/changes`, `chat`'s one-shot query mode, and the
 * bare-`mapd` guided default. Business logic is exercised elsewhere (this
 * file only proves the new wiring reaches it).
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
    return { code: e.status ?? 1, out: (e.stdout ?? "").toString(), err: (e.stderr ?? "").toString() };
  }
}

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-consolidation-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "entry.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "entry.js"), `import { helper } from "./helper.js";\nexport function run(){ return helper(); }\nrun();\n`);
  fs.writeFileSync(path.join(dir, "helper.js"), `export function helper(){ return 1; }\n`);
  return dir;
}

test("check --save-baseline snapshots the map (replaces the hidden `baseline` command)", () => {
  const dir = project();
  const { out } = run(["check", "--save-baseline"], dir);
  assert.match(out, /Baseline saved/);
  assert.ok(fs.existsSync(path.join(dir, ".mapd", "baseline.json")));
});

test("map's default output folds in baseline + open-findings status", () => {
  const dir = project();
  const before = run(["map"], dir).out;
  assert.match(before, /baseline: none/);
  run(["check", "--save-baseline"], dir);
  const after = run(["map"], dir).out;
  assert.match(after, /baseline: present/);
  assert.match(after, /open findings: 0/);
  assert.match(after, /Next:/);
});

test("map --view --static writes the same standalone HTML the hidden `view` command produces", () => {
  const dir = project();
  const { out } = run(["map", "--view", "--static"], dir);
  assert.match(out, /Map'd view/);
  assert.ok(fs.existsSync(path.join(dir, "mapd-view.html")));
  const html = fs.readFileSync(path.join(dir, "mapd-view.html"), "utf8");
  assert.match(html, /<!doctype html>/i);
});

test("fix review lists the approval queue (replaces the hidden `review` command)", () => {
  const dir = project();
  run(["check", "--save-baseline"], dir);
  fs.writeFileSync(path.join(dir, "helper.js"), `// removed\n`);
  run(["check"], dir);
  const { out } = run(["fix", "review"], dir);
  assert.match(out, /export-removed/);
  assert.match(out, /mapd fix review --approve/);
  assert.match(out, /mapd fix evidence/);
});

test("fix evidence <id> shows evidence for a finding (replaces the hidden `evidence` command)", () => {
  const dir = project();
  run(["check", "--save-baseline"], dir);
  fs.writeFileSync(path.join(dir, "helper.js"), `// removed\n`);
  run(["check"], dir);
  const review = JSON.parse(run(["fix", "review", "--json"], dir).out);
  const item = review.items.find((i) => i.kind === "export-removed");
  assert.ok(item, "expected an export-removed finding in the queue");
  const { out } = run(["fix", "evidence", item.id], dir);
  assert.match(out, /export-removed/);
});

test("config annotate add/list/remove round-trips (replaces the hidden `annotate` command group)", () => {
  const dir = project();
  const add = run(["config", "annotate", "add", "helper.js", "intentional-dormant"], dir);
  assert.match(add.out, /Added annotation/);
  const list = run(["config", "annotate", "list"], dir);
  assert.match(list.out, /intentional-dormant/);
  const remove = run(["config", "annotate", "remove", "helper.js"], dir);
  assert.match(remove.out, /Removed annotation/);
  const listAfter = run(["config", "annotate", "list"], dir);
  assert.match(listAfter.out, /No annotations/);
});

test("tools docs renders MAP.md (replaces the hidden `docs` command)", () => {
  const dir = project();
  run(["tools", "docs"], dir);
  assert.ok(fs.existsSync(path.join(dir, "MAP.md")));
});

test("tools modernize runs a scan (replaces the hidden `modernize` command)", () => {
  const dir = project();
  const { out } = run(["tools", "modernize", "light", "--json"], dir);
  const j = JSON.parse(out);
  assert.ok(Array.isArray(j.findings));
});

test("tools test (gaps default) and tools test credit work (replaces the hidden `test` command)", () => {
  const dir = project();
  const gaps = run(["tools", "test"], dir);
  assert.match(gaps.out, /testPresence|untested|gap/i);
  const credit = run(["tools", "test", "credit"], dir);
  assert.equal(credit.code, 0);
});

test("tools changes list works (replaces the hidden `changes` command)", () => {
  const dir = project();
  const { out } = run(["tools", "changes"], dir);
  assert.match(out, /No recorded changes/);
});

test("tools improve emits a ranked plan (replaces the hidden `improve` command)", () => {
  const dir = project();
  const { out } = run(["tools", "improve", "--json"], dir);
  const j = JSON.parse(out);
  assert.ok(Array.isArray(j.tasks));
});

test("chat one-shot query answers and exits instead of starting the REPL", () => {
  const dir = project();
  const { out } = run(["chat", "show test gaps"], dir);
  assert.equal(typeof out, "string");
  assert.ok(out.length > 0);
  assert.doesNotMatch(out, /mapd>/); // never entered the interactive prompt
});

test("chat one-shot query accepts a leading real directory before the query", () => {
  const dir = project();
  const { out } = run(["chat", dir, "show test gaps"]);
  assert.ok(out.length > 0);
});

test("bare `mapd` (no args) prints a guided suggestion grounded in real project state, not generic help", () => {
  const dir = project();
  const { out } = run([], dir);
  assert.match(out, /What to run next/);
  assert.match(out, /mapd config init|mapd check --save-baseline|mapd chat/);
});

test("bare `mapd` reflects state changes: baseline present changes the suggestion", () => {
  const dir = project();
  const before = run([], dir).out;
  assert.match(before, /mapd check --save-baseline/);
  run(["check", "--save-baseline"], dir);
  const after = run([], dir).out;
  assert.doesNotMatch(after, /mapd check --save-baseline/);
});

test("`mapd --help` still works normally (only bare invocation triggers the guided default)", () => {
  const dir = project();
  const { out } = run(["--help"], dir);
  assert.match(out, /Usage: mapd/);
});
