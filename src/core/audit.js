/**
 * audit.js — structured, append-only audit records for every command that
 * touches the project (fix attempts, integrate applies, chat mutations, mcp
 * tool calls). Human-readable via `mapd audit <id>`, machine-readable via
 * `--json`. Secrets are redacted before anything is written.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { redactSecrets } from "./security.js";

const MAPD = ".mapd";
const SCHEMA = 1;

function auditsDir(rootDir) { return path.join(path.resolve(rootDir), MAPD, "audits"); }

function redactDeep(value) {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}

/**
 * `record` should include: command, initiator, sessionId?, changeId?,
 * provider?, model?, contextSources?, filesInspected?, filesChanged?,
 * approvalStatus?, attempt?, gates?, commandsRun?, exitCodes?, durationMs?,
 * tokenUsage?, finalStatus, rollbackStatus?.
 */
export function recordAudit(rootDir, record) {
  const dir = auditsDir(rootDir);
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  const full = redactDeep({
    mapdSchema: SCHEMA,
    id,
    timestamp: new Date().toISOString(),
    ...record,
  });
  const file = path.join(dir, `${full.timestamp.replace(/[:.]/g, "-")}-${id.slice(0, 8)}.json`);
  fs.writeFileSync(file, JSON.stringify(full, null, 2));
  return full;
}

export function loadAudits(rootDir) {
  const dir = auditsDir(rootDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function getAudit(rootDir, id) {
  return loadAudits(rootDir).find((a) => a.id === id || a.id.startsWith(id)) ?? null;
}
