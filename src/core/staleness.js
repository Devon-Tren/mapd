/**
 * staleness.js — reports from `mapd check`/`mapd modernize` are written to
 * disk once and re-read by review.js, handoff.js, solutions.js, and chat's
 * /findings and /review every time after that. Nothing previously compared
 * a report's age against the current tree, so a finding that was already
 * fixed (in this project or by an external agent) kept getting presented as
 * current. That's a real form of overclaiming — stale data shown as current
 * fact without disclosure — so this is checked and surfaced explicitly
 * wherever those reports get read, never silently trusted.
 */

import fs from "node:fs";
import path from "node:path";
import { latestSourceMtime } from "./parser.js";

const REPORT_FILES = ["findings.json", "modernize-light.json", "modernize-medium.json", "modernize-heavy.json"];

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

/**
 * Compares each present report's `generatedAt` against the most recent
 * source-file mtime in the project. Returns `{checked:false}` when no
 * reports exist yet (nothing to be stale). Never mutates or deletes
 * anything — purely informational, for callers to disclose.
 */
export function checkReportFreshness(rootDir) {
  const abs = path.resolve(rootDir);
  const dir = path.join(abs, ".mapd");
  const reports = REPORT_FILES
    .map((name) => ({ name, path: path.join(dir, name) }))
    .filter((r) => fs.existsSync(r.path))
    .map((r) => ({ ...r, data: readJson(r.path) }))
    .filter((r) => r.data?.generatedAt);

  if (!reports.length) return { checked: false, stale: false, staleReports: [] };

  const latestSource = latestSourceMtime(abs);
  const staleReports = reports
    .filter((r) => new Date(r.data.generatedAt).getTime() < latestSource)
    .map((r) => r.name);

  return { checked: true, stale: staleReports.length > 0, staleReports, latestSourceMtime: latestSource };
}
