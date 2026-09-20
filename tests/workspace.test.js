/**
 * tests/workspace.test.js — patch isolation: git-worktree path + tmpdir-copy fallback.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  createIsolatedWorkspace, applyPatchInWorkspace, diffWorkspace,
  promoteWorkspaceChange, sanitizeRelPath,
} from "../src/core/workspace.js";

const sh = (cwd, cmd) => execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
const G = `git -c user.email=t@t -c user.name=t`;

function gitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-ws-git-"));
  fs.writeFileSync(path.join(dir, "index.js"), `export function greet(){ return "hi"; }\n`);
  sh(dir, `git init -q -b main`); sh(dir, `${G} add -A`); sh(dir, `${G} commit -qm base`);
  return dir;
}

function plainFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-ws-plain-"));
  fs.writeFileSync(path.join(dir, "index.js"), `export function greet(){ return "hi"; }\n`);
  return dir;
}

test("createIsolatedWorkspace: uses a git worktree when the project is git-backed", () => {
  const dir = gitFixture();
  const ws = createIsolatedWorkspace(dir);
  try {
    assert.equal(ws.kind, "worktree");
    assert.ok(fs.existsSync(path.join(ws.dir, "index.js")));
  } finally {
    ws.cleanup();
  }
});

test("createIsolatedWorkspace: falls back to a tmpdir copy when there is no git repo", () => {
  const dir = plainFixture();
  const ws = createIsolatedWorkspace(dir);
  try {
    assert.equal(ws.kind, "tmpdir-copy");
    assert.ok(fs.existsSync(path.join(ws.dir, "index.js")));
  } finally {
    ws.cleanup();
  }
});

test("applyPatchInWorkspace + diffWorkspace: only the patched file is reported changed", () => {
  const dir = plainFixture();
  fs.writeFileSync(path.join(dir, "untouched.js"), `export const x = 1;\n`);
  const ws = createIsolatedWorkspace(dir);
  try {
    applyPatchInWorkspace(ws, "index.js", `export function greet(){ return "hello"; }\n`);
    const changed = diffWorkspace(ws);
    assert.deepEqual(changed, ["index.js"]);
    const promoted = promoteWorkspaceChange(ws, "index.js");
    assert.match(promoted, /hello/);
  } finally {
    ws.cleanup();
  }
});

test("sanitizeRelPath: rejects path traversal outside the workspace", () => {
  const dir = plainFixture();
  const ws = createIsolatedWorkspace(dir);
  try {
    assert.throws(() => sanitizeRelPath(ws.dir, "../../etc/passwd"));
    assert.throws(() => applyPatchInWorkspace(ws, "../outside.js", "x"));
  } finally {
    ws.cleanup();
  }
});
