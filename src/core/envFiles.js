/**
 * envFiles.js — .env loading and inspection, project-level and user-level.
 *
 * Precedence: a project's own `.env` (current working directory) always wins;
 * a user-level `~/.env` fills in anything the project didn't set. This means
 * a key configured once in your home directory works in every project you
 * run mapd from, while any project can still override it with its own `.env`
 * (e.g. a different model, or a project-specific key). Node's built-in
 * `process.loadEnvFile` never overwrites a variable that's already set, which
 * is what makes this precedence chain work without extra bookkeeping.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const RECOGNIZED_ENV_KEYS = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL",
  "KIMI_API_KEY", "KIMI_BASE_URL", "MAPD_MODEL", "MAPD_WEBHOOK_SECRET",
];

/** Loads .env files in precedence order. Call once, as early as possible. Never throws. */
export function loadEnvFiles() {
  try { process.loadEnvFile(); } catch { /* no project .env in cwd — fine, optional */ }
  try { process.loadEnvFile(path.join(os.homedir(), ".env")); } catch { /* no user-level ~/.env — fine, optional */ }
}

function scanEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return { present: false, keys: [] };
  let content;
  try { content = fs.readFileSync(envPath, "utf8"); } catch { return { present: true, keys: [] }; }
  const keys = RECOGNIZED_ENV_KEYS.filter((k) => new RegExp(`^\\s*${k}\\s*=`, "m").test(content));
  return { present: true, keys };
}

/** Reports on both the project-level and user-level .env — never reads or prints values. */
export function checkEnvFiles(rootDir) {
  const userPath = path.join(os.homedir(), ".env");
  return {
    project: { path: path.join(path.resolve(rootDir), ".env"), ...scanEnvFile(path.join(path.resolve(rootDir), ".env")) },
    user: { path: userPath, ...scanEnvFile(userPath) },
  };
}
