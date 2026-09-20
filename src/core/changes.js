/**
 * changes.js — the single funnel for every real-tree mutation Map'd makes
 * (fix apply, integrate apply, review approve). Every write through here is
 * also recorded as a stable, rollback-able change record — approval state
 * is never allowed to stand in for an actual recorded, reversible write.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sanitizeRelPath, isProtectedPath } from "./security.js";

const MAPD = ".mapd";

function changesDir(rootDir) { return path.join(rootDir, MAPD, "changes"); }
function blobsDir(rootDir) { return path.join(changesDir(rootDir), "blobs"); }

function newChangeId() {
  return `chg-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function hashOf(content) {
  return content == null ? null : crypto.createHash("sha256").update(content).digest("hex");
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

/**
 * Write `newSource` to `file` (relative to rootDir) and record a change entry
 * with a full before/after blob backup. Refuses protected paths and path
 * traversal outright — this is the last line of defense before a real-tree
 * write, independent of whatever upstream gates already ran.
 *
 * `source` identifies the origin ("fix" | "integrate" | "review") for the audit trail.
 */
export function applyRealTreeWrite(rootDir, file, newSource, source, { forbiddenPaths = [] } = {}) {
  const abs = path.resolve(rootDir);
  if (isProtectedPath(file, forbiddenPaths)) {
    throw new Error(`Refusing to write a protected path: ${file}`);
  }
  const target = sanitizeRelPath(abs, file);

  let before = null;
  try { before = fs.readFileSync(target, "utf8"); } catch { /* new file */ }

  const id = newChangeId();
  fs.mkdirSync(blobsDir(abs), { recursive: true });
  const beforePath = before != null ? path.join(blobsDir(abs), `${id}.before`) : null;
  const afterPath = path.join(blobsDir(abs), `${id}.after`);
  if (beforePath) fs.writeFileSync(beforePath, before);
  fs.writeFileSync(afterPath, newSource);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, newSource);

  const record = {
    mapdSchema: 1,
    id,
    at: new Date().toISOString(),
    file,
    source,
    beforeHash: hashOf(before),
    afterHash: hashOf(newSource),
    beforePath, afterPath,
    rolledBack: false,
  };
  fs.writeFileSync(path.join(changesDir(abs), `${id}.json`), JSON.stringify(record, null, 2));
  return record;
}

export function loadChanges(rootDir) {
  const dir = changesDir(path.resolve(rootDir));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => readJson(path.join(dir, n)))
    .filter(Boolean)
    .sort((a, b) => a.at.localeCompare(b.at));
}

export function getChange(rootDir, changeId) {
  return loadChanges(rootDir).find((c) => c.id === changeId) ?? null;
}

/**
 * Restore the file this change touched to its pre-change content (or delete
 * it, if the change created a new file). Append-only: the original record is
 * never deleted, only marked rolledBack, and a new rollback record is appended.
 */
export function rollbackChange(rootDir, changeId) {
  const abs = path.resolve(rootDir);
  const record = getChange(abs, changeId);
  if (!record) return { ok: false, detail: `no change with id ${changeId}` };
  if (record.rolledBack) return { ok: false, detail: `change ${changeId} was already rolled back` };

  const target = sanitizeRelPath(abs, record.file);
  if (record.beforePath && fs.existsSync(record.beforePath)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, fs.readFileSync(record.beforePath));
  } else {
    try { fs.rmSync(target, { force: true }); } catch { /* best effort */ }
  }

  record.rolledBack = true;
  record.rolledBackAt = new Date().toISOString();
  fs.writeFileSync(path.join(changesDir(abs), `${changeId}.json`), JSON.stringify(record, null, 2));
  return { ok: true, detail: `${record.file} restored to its state before change ${changeId}` };
}
