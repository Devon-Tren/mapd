/**
 * workspace.js — patch isolation. Never apply an unverified proposal directly
 * to the user's real working tree.
 *
 * Two isolation strategies, same surface:
 *   - "worktree"    — git-backed projects: reuses the exact `mkdtempSync` +
 *                     `git worktree add --detach` pattern already proven in
 *                     integrate.js's detectConflicts().
 *   - "tmpdir-copy" — non-git projects: a plain recursive filesystem copy,
 *                     excluding .git/.mapd/node_modules.
 *
 * Callers (fix.js, mcp/tools.js) never branch on git-vs-not — they only see
 * `{dir, kind, cleanup()}` plus applyPatchInWorkspace/diffWorkspace/promoteWorkspaceChange.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { sanitizeRelPath as sanitizeWithinRoot } from "./security.js";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

function isGitRepo(rootDir) {
  try {
    return git(rootDir, "rev-parse", "--is-inside-work-tree").trim() === "true";
  } catch {
    return false;
  }
}

const IGNORE_DIRS = new Set(["node_modules", ".git", ".mapd"]);

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) continue; // never follow symlinks out of the tree
    if (entry.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Guard against path traversal / symlink escape out of the workspace root. */
export function sanitizeRelPath(workspaceDir, relFile) {
  return sanitizeWithinRoot(workspaceDir, relFile);
}

/** Create an isolated copy of rootDir to safely apply and verify an unverified patch. */
export function createIsolatedWorkspace(rootDir) {
  const abs = path.resolve(rootDir);
  if (isGitRepo(abs)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-ws-"));
    const head = git(abs, "rev-parse", "--abbrev-ref", "HEAD").trim();
    git(abs, "worktree", "add", "--detach", dir, head === "HEAD" ? git(abs, "rev-parse", "HEAD").trim() : head);
    return {
      dir, kind: "worktree", rootDir: abs,
      cleanup() {
        try { git(abs, "worktree", "remove", "--force", dir); } catch { /* best effort */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      },
    };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-ws-"));
  copyTree(abs, dir);
  return {
    dir, kind: "tmpdir-copy", rootDir: abs,
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

/** Write a proposed patch's resulting source for one file inside the isolated workspace. */
export function applyPatchInWorkspace(ws, relFile, newSource) {
  const abs = sanitizeRelPath(ws.dir, relFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, newSource);
  return abs;
}

/**
 * List every file that differs between the isolated workspace and rootDir
 * (relative paths). Used by G1 to enforce "only allowed files changed."
 */
export function diffWorkspace(ws) {
  const changed = [];
  const walk = (relDir) => {
    const wsAbs = path.join(ws.dir, relDir);
    if (!fs.existsSync(wsAbs)) return;
    for (const entry of fs.readdirSync(wsAbs, { withFileTypes: true })) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const rel = path.join(relDir, entry.name);
      if (entry.isDirectory()) { walk(rel); continue; }
      const wsFile = path.join(ws.dir, rel);
      const rootFile = path.join(ws.rootDir, rel);
      const wsContent = fs.readFileSync(wsFile);
      let rootContent = null;
      try { rootContent = fs.readFileSync(rootFile); } catch { /* new file */ }
      if (!rootContent || !wsContent.equals(rootContent)) changed.push(rel.split(path.sep).join("/"));
    }
  };
  walk(".");
  return changed;
}

/** Read back the (already gate-verified) content of one file from the workspace. */
export function promoteWorkspaceChange(ws, relFile) {
  const abs = sanitizeRelPath(ws.dir, relFile);
  return fs.readFileSync(abs, "utf8");
}
