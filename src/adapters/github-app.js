/**
 * github-app.js — SaaS wrapper skeleton (adapter, not a second engine).
 *
 * Architecture rule: the GitHub App owns ZERO analysis logic. It clones the
 * repo at the pushed SHA, runs the exact same core pipeline the CLI runs, and
 * translates findings into GitHub-native surfaces:
 *
 *   push to default branch  → mapd baseline (auto-refresh ground truth)
 *   pull_request opened/sync → mapd check against base-branch baseline
 *                              → findings posted as a PR review comment
 *                              → high-severity findings become a "Map'd"
 *                                check-run with conclusion "action_required"
 *   /mapd propose (PR comment) → drafts fix proposals as a suggested-changes
 *                                review — never a direct commit
 *
 * This file is a wired skeleton: handler routing and pipeline calls are real;
 * the Octokit/webhook-verification plumbing is stubbed where deployment
 * secrets are required. See README "GitHub App deployment".
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { parseProject } from "../core/parser.js";
import { buildGraph, loadPkg } from "../core/graph.js";
import { scoreGraph } from "../core/confidence.js";
import { diffGraphs, loadBaseline, saveBaseline } from "../core/regression.js";

function analyzeAt(cloneUrl, sha) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-"));
  execFileSync("git", ["clone", "--depth", "50", "--", cloneUrl, dir], { stdio: "ignore" });
  execFileSync("git", ["checkout", sha], { cwd: dir, stdio: "ignore" });
  const parsed = parseProject(dir);
  return { dir, graph: scoreGraph(dir, buildGraph(dir, parsed, loadPkg(dir))) };
}

export async function handleWebhook(event, payload /*, octokit */) {
  switch (event) {
    case "push": {
      if (payload.ref !== `refs/heads/${payload.repository.default_branch}`) return;
      const { dir, graph } = analyzeAt(payload.repository.clone_url, payload.after);
      saveBaseline(dir, graph);
      // TODO(deploy): persist baseline to app storage keyed by repo id,
      // instead of the ephemeral clone dir.
      return { action: "baseline-refreshed", repoConfidence: graph.repoConfidence };
    }

    case "pull_request": {
      if (!["opened", "synchronize"].includes(payload.action)) return;
      const head = analyzeAt(payload.repository.clone_url, payload.pull_request.head.sha);
      const loaded = loadBaseline(head.dir); // TODO(deploy): load from app storage
      const baseline = loaded && !loaded.schemaMismatch ? loaded.graph : null;
      if (!baseline) return { action: "skipped", reason: "no baseline for base branch" };
      const findings = diffGraphs(baseline, head.graph);
      const high = findings.filter((f) => f.severity === "high");
      // TODO(deploy): octokit.checks.create({ conclusion: high.length ? "action_required" : "success", ... })
      // TODO(deploy): octokit.pulls.createReview({ body: renderFindingsComment(findings), event: "COMMENT" })
      return { action: "checked", findings: findings.length, blocking: high.length };
    }

    default:
      return;
  }
}

export function renderFindingsComment(findings) {
  if (!findings.length) return "**Map'd** — no workflow regressions detected. ✅";
  const rows = findings.map((f) => `| ${f.severity} | \`${f.kind}\` | ${f.detail} |`).join("\n");
  return [
    "## Map'd — workflow regression report",
    "",
    "All findings below are derived from AST-level graph diffs against the base-branch baseline. Nothing has been modified; approve individual fixes with `/mapd propose`.",
    "",
    "| Severity | Kind | Detail |",
    "|---|---|---|",
    rows,
  ].join("\n");
}
