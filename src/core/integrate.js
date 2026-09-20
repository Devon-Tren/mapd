/**
 * integrate.js — Function 1: integration / congruence resolution.
 *
 * Pipeline (LLM optional, verification mandatory):
 *   1. DETECT     — attempt the merge in an isolated git worktree; collect
 *                   conflicted files with base/ours/theirs content. Deterministic.
 *   2. CLASSIFY   — parse ours & theirs; compare function sets and exported
 *                   surface to label each conflict:
 *                     "small-scale"    same functions, bodies diverged
 *                     "workflow-scale" exports / function topology diverged
 *                   Deterministic (this drives Devon's small-vs-POC routing).
 *   3. PROPOSE    — (optional, needs API key) LLM drafts a merged file per
 *                   conflict, receiving both sides + classification.
 *   4. VERIFY     — every proposal must pass hard deterministic gates before
 *                   it is even *saved as a proposal*:
 *                     G1 parses cleanly (zero recovery errors)
 *                     G2 preserves the UNION of both parents' exports
 *                     G3 preserves the union of top-level function names
 *                   A gate failure downgrades the proposal to "rejected-by-gate"
 *                   with the failed gate named — it is never silently dropped.
 *   5. APPLY      — only via explicit `mapd integrate --apply`, and only
 *                   proposals whose derived score ≥ threshold. Default: never.
 *
 * Derived resolution score (per proposal — computed, not asserted):
 *   gatePassRate (0.5)  fraction of gates passed
 *   testPresence (0.3)  does the conflicted file have a matching test file
 *   scaleFactor  (0.2)  small-scale=1.0, workflow-scale=0.4 (structural merges
 *                       are inherently riskier; constant is a policy knob, not
 *                       a guess about *this* merge)
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseSource, runStandardGates } from "./gates.js";
import { applyRealTreeWrite } from "./changes.js";

/** All git invocations use argument arrays — no shell, no interpolation, no injection. */
function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

/** Step 1+2: detect conflicts merging `branch` into HEAD, classify each. Deterministic. */
export function detectConflicts(rootDir, branch) {
  const abs = path.resolve(rootDir);
  // integrate is inherently git-native (it merges in an isolated worktree). If
  // this project isn't a git repo, say so cleanly instead of letting a raw
  // `fatal: not a git repository` escape — the rest of Map'd degrades
  // gracefully without git, and so must this.
  try { git(abs, "rev-parse", "--git-dir"); }
  catch { return { mergeable: false, conflicts: [], requiresGit: true }; }
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-merge-"));
  const conflicts = [];
  let mergeable = true;

  try {
    const head = git(abs, "rev-parse", "--abbrev-ref", "HEAD").trim();
    git(abs, "worktree", "add", "--detach", worktree, head);
    try {
      git(worktree, "-c", "user.email=mapd@local", "-c", "user.name=mapd", "merge", "--no-commit", "--no-ff", branch);
      // clean merge — nothing to resolve
    } catch (e) {
      const status = git(worktree, "status", "--porcelain");
      const conflictedFiles = status.split("\n")
        .filter((l) => /^(UU|AA|DU|UD|AU|UA) /.test(l))
        .map((l) => l.slice(3).trim());
      if (conflictedFiles.length === 0) {
        // merge failed for a non-conflict reason — surface it, don't fabricate a clean/empty result
        return { mergeable: false, conflicts: [], mergeError: (e.stderr ?? e.message ?? "").toString().trim() };
      }
      mergeable = false;

      for (const file of conflictedFiles) {
        const show = (ref) => {
          try { return git(worktree, "show", `${ref}:${file}`); } catch { return null; }
        };
        const base = show(":1"), ours = show(":2"), theirs = show(":3");
        const conflict = { file, base, ours, theirs, classification: "unknown" };

        if (ours != null && theirs != null && /\.(js|ts|jsx|tsx|mjs|cjs)$/.test(file)) {
          const po = parseSource(ours, `${file}@ours`);
          const pt = parseSource(theirs, `${file}@theirs`);
          if (po.parsed && pt.parsed) {
            const fo = new Set(po.functions.map((f) => f.name));
            const ft = new Set(pt.functions.map((f) => f.name));
            const eo = new Set(po.exports), et = new Set(pt.exports);
            const sameFns = fo.size === ft.size && [...fo].every((n) => ft.has(n));
            const sameExports = eo.size === et.size && [...eo].every((n) => et.has(n));
            conflict.classification = sameFns && sameExports ? "small-scale" : "workflow-scale";
            conflict.evidence = {
              oursFns: [...fo].sort(), theirsFns: [...ft].sort(),
              oursExports: [...eo].sort(), theirsExports: [...et].sort(),
            };
            // union targets for verification gates
            conflict.requiredExports = [...new Set([...eo, ...et])].sort();
            conflict.requiredFunctions = [...new Set([...fo, ...ft])].sort();
          } else {
            conflict.classification = "unparseable-side";
          }
        } else if (ours == null || theirs == null) {
          conflict.classification = "delete-modify"; // one side deleted — always workflow-scale severity
        }
        conflicts.push(conflict);
      }
      try { git(worktree, "merge", "--abort"); } catch { /* detached worktree, discarded anyway */ }
    }
  } finally {
    try { git(abs, "worktree", "remove", "--force", worktree); } catch { /* best effort */ }
    fs.rmSync(worktree, { recursive: true, force: true });
  }
  return { mergeable, conflicts };
}

/** Step 4: hard deterministic gates on a proposed merged source. Delegates to gates.js. */
export function verifyProposal(conflict, mergedSource) {
  return runStandardGates({
    source: mergedSource,
    label: `${conflict.file}@proposed`,
    requiredExports: conflict.requiredExports,
    requiredFunctions: conflict.requiredFunctions,
  });
}

/** Derived resolution score. Every input measurable; policy constants documented above. */
export function scoreResolution(conflict, gates, hasTest) {
  const gatePassRate = gates.length ? gates.filter((g) => g.passed).length / gates.length : 0;
  const scaleFactor = conflict.classification === "small-scale" ? 1.0
    : conflict.classification === "workflow-scale" ? 0.4 : 0.2;
  const signals = {
    gatePassRate: { value: Number(gatePassRate.toFixed(3)), weight: 0.5 },
    testPresence: { value: hasTest ? 1 : 0, weight: 0.3 },
    scaleFactor: { value: scaleFactor, weight: 0.2 },
  };
  const score = Object.values(signals).reduce((a, s) => a + s.value * s.weight, 0);
  return { score: Number(score.toFixed(3)), signals, method: "resolution-composite-v1" };
}

export function saveIntegrationReport(rootDir, branch, report) {
  const dir = path.join(rootDir, ".mapd", "integration");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `report-${branch.replace(/[^\w.-]/g, "_")}.json`);
  fs.writeFileSync(p, JSON.stringify(report, null, 2));
  // proposals as reviewable files next to the report
  for (const c of report.conflicts) {
    if (c.proposal?.mergedSource && c.proposal.status === "awaiting-approval") {
      const pf = path.join(dir, c.file.replace(/[\\/]/g, "__") + ".proposed");
      fs.writeFileSync(pf, c.proposal.mergedSource);
      c.proposal.proposalFile = pf;
    }
  }
  fs.writeFileSync(p, JSON.stringify(report, null, 2));
  return p;
}

/** Step 5: apply approved proposals above threshold. Explicit opt-in only. */
export function applyProposals(rootDir, report, threshold) {
  const applied = [], skipped = [];
  for (const c of report.conflicts) {
    const pr = c.proposal;
    if (pr?.status === "awaiting-approval" && pr.resolutionScore?.score >= threshold && pr.mergedSource) {
      const change = applyRealTreeWrite(rootDir, c.file, pr.mergedSource, "integrate");
      applied.push({ file: c.file, score: pr.resolutionScore.score, changeId: change.id });
    } else {
      skipped.push({ file: c.file, score: pr?.resolutionScore?.score ?? null, reason: pr ? "below threshold or gated" : "no proposal" });
    }
  }
  return { applied, skipped };
}
