/**
 * tests/chat-commands.test.js — slash-command table calls the same core
 * services the CLI uses (no duplicated business logic).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCommandTable } from "../src/chat/commands.js";

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-chatcmd-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), `export function greet(){ return "hi"; }\n`);
  return dir;
}

test("/map reports files, workflows, and confidence from the real graph", async () => {
  const dir = tmpProject();
  const table = createCommandTable({ rootDir: dir, config: {} });
  const r = await table["/map"]();
  assert.equal(r.ok, true);
  assert.match(r.text, /files: 1/); // only index.js is parsed (package.json isn't a JS/TS file)
  assert.match(r.text, /workflows: 1/);
});

test("/baseline then /check round-trip: no regressions immediately after baselining", async () => {
  const dir = tmpProject();
  const table = createCommandTable({ rootDir: dir, config: {} });
  const b = await table["/baseline"]();
  assert.match(b.text, /Baseline saved/);
  const c = await table["/check"]();
  assert.match(c.text, /No regressions/);
});

test("/check reports a real regression after an export is removed", async () => {
  const dir = tmpProject();
  const table = createCommandTable({ rootDir: dir, config: {} });
  await table["/baseline"]();
  fs.writeFileSync(path.join(dir, "index.js"), `// greet removed\n`);
  const c = await table["/check"]();
  assert.match(c.text, /export-removed/);
});

test("/review and /findings reflect the unified approval queue", async () => {
  const dir = tmpProject();
  const table = createCommandTable({ rootDir: dir, config: {} });
  await table["/baseline"]();
  fs.writeFileSync(path.join(dir, "index.js"), `// greet removed\n`);
  await table["/check"]();
  const review = await table["/review"]();
  assert.match(review.text, /export-removed/);
  const findings = await table["/findings"]();
  assert.match(findings.text, /export-removed/);
});

test("/status reports baseline presence and open findings count", async () => {
  const dir = tmpProject();
  const table = createCommandTable({ rootDir: dir, config: {} });
  const before = await table["/status"]();
  assert.match(before.text, /baseline: none/);
  await table["/baseline"]();
  const after = await table["/status"]();
  assert.match(after.text, /baseline: present/);
});

test("/help lists the documented slash commands", async () => {
  const dir = tmpProject();
  const table = createCommandTable({ rootDir: dir, config: {} });
  const r = await table["/help"]();
  for (const cmd of ["/map", "/baseline", "/check", "/docs", "/modernize", "/review", "/findings", "/project", "/context", "/status", "/diagnose", "/help", "/clear", "/end"]) {
    assert.ok(r.text.includes(cmd), `missing ${cmd} from /help output`);
  }
});

test("/diagnose reports deterministic understanding limits", async () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "index.js"), `export function greet(){ return process.env.PORT; }\n`);
  const table = createCommandTable({ rootDir: dir, config: {} });
  const r = await table["/diagnose"]();
  assert.equal(r.ok, true);
  assert.match(r.text, /Map'd diagnosis/);
  assert.match(r.text, /PORT/);
});

function tmpMultiFileProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-chatcmd-multi-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "entry.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "entry.js"), `import { helper } from "./helper.js";\nexport function run(){ return helper(); }\nrun();\n`);
  fs.writeFileSync(path.join(dir, "helper.js"), `export function helper(){ return 1; }\n`);
  return dir;
}

// trace/resolution/find are the CLI's `trace`, `resolution`, and `context`
// commands folded into chat's natural-language surface (command consolidation
// balanced-cut: those top-level names became hidden aliases, reachable here).
test("/trace <file> explains workflow membership for a single file", async () => {
  const dir = tmpMultiFileProject();
  const table = createCommandTable({ rootDir: dir, config: {} });
  const r = await table["/trace"](["helper.js"]);
  assert.equal(r.ok, true);
  assert.match(r.text, /helper\.js/);
});

test("/trace <file> <to> shows the import chain connecting two files", async () => {
  const dir = tmpMultiFileProject();
  const table = createCommandTable({ rootDir: dir, config: {} });
  const r = await table["/trace"](["entry.js", "helper.js"]);
  assert.equal(r.ok, true);
  assert.match(r.text, /entry\.js/);
  assert.match(r.text, /helper\.js/);
});

test("/trace with no file argument reports usage instead of throwing", async () => {
  const dir = tmpMultiFileProject();
  const table = createCommandTable({ rootDir: dir, config: {} });
  const r = await table["/trace"]([]);
  assert.equal(r.ok, false);
  assert.match(r.text, /Usage: \/trace/);
});

test("/resolution reports the call-resolution rate breakdown", async () => {
  const dir = tmpMultiFileProject();
  const table = createCommandTable({ rootDir: dir, config: {} });
  const r = await table["/resolution"]();
  assert.equal(r.ok, true);
  assert.equal(typeof r.text, "string");
  assert.ok(r.text.length > 0);
});

test("/find <query> returns ranked symbol/file hits from the real graph", async () => {
  const dir = tmpMultiFileProject();
  const table = createCommandTable({ rootDir: dir, config: {} });
  const r = await table["/find"](["helper"]);
  assert.equal(r.ok, true);
  assert.match(r.text, /helper\.js/);
});

test("/find with no query reports usage instead of throwing", async () => {
  const dir = tmpMultiFileProject();
  const table = createCommandTable({ rootDir: dir, config: {} });
  const r = await table["/find"]([]);
  assert.equal(r.ok, false);
  assert.match(r.text, /Usage: \/find/);
});

test("/help mentions the newly folded-in trace/resolution/find commands", async () => {
  const dir = tmpProject();
  const table = createCommandTable({ rootDir: dir, config: {} });
  const r = await table["/help"]();
  for (const cmd of ["/trace", "/resolution", "/find"]) {
    assert.ok(r.text.includes(cmd), `missing ${cmd} from /help output`);
  }
});
