/**
 * review.js — the human half of "autonomous routing, human approval."
 *
 * Every Map'd function emits items with status "awaiting-approval" into
 * .mapd/*.json. This module presents them as one queue with stable IDs and
 * performs the only two state transitions a human can make:
 *
 *   approve — for an integration proposal, writes the verified merged source
 *             into the working tree (the one place approval has a side effect,
 *             because the artifact IS a file). For check/modernize findings,
 *             marks "approved" — a work-queue signal for the fix pass.
 *   dismiss — marks "dismissed" with an optional reason; item leaves the queue
 *             but stays in the report (audit trail, never deleted).
 *
 * IDs are content-derived (kind + file/rule hash), so they are stable across
 * re-listing but change if the underlying finding changes — you can never
 * approve a stale version of an item by accident.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { applyRealTreeWrite } from "./changes.js";
import { checkReportFreshness } from "./staleness.js";

const MAPD = ".mapd";

const id8 = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

/** Collect every reviewable item across all report files. */
export function loadQueue(rootDir) {
  const dir = path.join(rootDir, MAPD);
  const items = [];

  // findings from `mapd check`
  const findingsPath = path.join(dir, "findings.json");
  const findings = readJson(findingsPath);
  findings?.findings?.forEach((f, i) => {
    items.push({
      id: id8(`check:${f.kind}:${f.detail}`),
      source: "check", file: findingsPath, index: i,
      kind: f.kind, severity: f.severity, detail: f.detail, status: f.status,
      hasProposal: !!f.proposal,
    });
  });

  // modernization reports (any mode)
  for (const mode of ["light", "medium", "heavy"]) {
    const p = path.join(dir, `modernize-${mode}.json`);
    const rep = readJson(p);
    rep?.findings?.forEach((f, i) => {
      if (f.informational) return;
      items.push({
        id: id8(`modernize:${f.rule}:${f.detail}`),
        source: `modernize-${mode}`, file: p, index: i,
        kind: f.rule, severity: null,
        priority: f.operationalImpact?.priority ?? null,
        detail: f.detail, status: f.status,
        hasProposal: !!f.migrationPlan,
      });
    });
  }

  // integration reports
  const intDir = path.join(dir, "integration");
  if (fs.existsSync(intDir)) {
    for (const name of fs.readdirSync(intDir).filter((n) => n.startsWith("report-") && n.endsWith(".json"))) {
      const p = path.join(intDir, name);
      const rep = readJson(p);
      rep?.conflicts?.forEach((c, i) => {
        if (!c.proposal) return;
        items.push({
          id: id8(`integrate:${rep.branch}:${c.file}`),
          source: `integrate:${rep.branch}`, file: p, index: i,
          kind: c.classification, severity: null,
          score: c.proposal.resolutionScore?.score ?? null,
          detail: `${c.file} — merge resolution proposal (${c.proposal.status})`,
          status: c.proposal.status,
          hasProposal: !!c.proposal.mergedSource,
          targetFile: c.file,
        });
      });
    }
  }

  // mapd fix proposals — mapd review --approve <id> feeds directly into applying a verified fix
  const proposalsDir = path.join(dir, "proposals");
  if (fs.existsSync(proposalsDir)) {
    for (const name of fs.readdirSync(proposalsDir).filter((n) => n.endsWith(".json"))) {
      const p = path.join(proposalsDir, name);
      const prop = readJson(p);
      if (!prop) continue;
      const files = Object.keys(prop.filesPatch ?? {});
      items.push({
        id: id8(`fix:${prop.findingId}`),
        source: "fix", file: p, index: null,
        kind: prop.findingKind ?? "fix", severity: null,
        detail: `${files.join(", ") || "(no files)"} — verified fix proposal (${prop.status})`,
        status: prop.status,
        hasProposal: files.length > 0,
        targetFile: files[0] ?? null,
      });
    }
  }
  return items;
}

export function pending(items) {
  return items.filter((i) => i.status === "awaiting-approval");
}

/**
 * The five finding states the master prompt requires to be obvious, derived —
 * never stored — from the raw report status plus report freshness:
 *
 *   active     — awaiting approval AND the source report is current with the tree
 *   stale      — awaiting approval, but the source report predates a newer
 *                source change (see staleness.js) — act only after refreshing
 *   approved   — human marked it approved; queued for a fix pass
 *   resolved   — a verified fix/merge was applied to the real tree
 *   dismissed  — human dismissed it (kept in the report as audit trail)
 *   historical — terminal leftovers: rolled back after apply, failed gates, etc.
 *
 * Deriving keeps a single source of truth: staleness can change with every
 * file save, so persisting a state would immediately overclaim.
 */
export function stateOf(item, staleReports = []) {
  const staleSet = staleReports instanceof Set ? staleReports : new Set(staleReports);
  switch (item.status) {
    case "awaiting-approval":
      return item.file && staleSet.has(path.basename(item.file)) ? "stale" : "active";
    case "approved": return "approved";
    case "approved-applied": return "resolved";
    case "resolved": return "resolved"; // auto-resolved by re-check (see regression.js saveFindings)
    case "dismissed": return "dismissed";
    default: return "historical";
  }
}

/**
 * loadQueue plus a derived `state` on every item and the freshness result it
 * was derived from — the one call sites should prefer whenever they show a
 * queue to a human or an agent, so stale findings are never presented as
 * current fact.
 */
export function loadQueueWithStates(rootDir) {
  const freshness = checkReportFreshness(rootDir);
  const items = loadQueue(rootDir).map((i) => ({ ...i, state: stateOf(i, freshness.staleReports) }));
  return { items, freshness };
}

/**
 * Transition one item. Returns { ok, action, detail }.
 * Approving an integration proposal writes the (already gate-verified) merged
 * source to the working tree; everything else is a status change only.
 */
export function transition(rootDir, item, action, reason) {
  const rep = readJson(item.file);
  if (!rep) return { ok: false, detail: `report file missing: ${item.file}` };

  const stamp = { at: new Date().toISOString(), by: "mapd review" };

  if (item.source.startsWith("integrate:")) {
    const c = rep.conflicts[item.index];
    if (!c?.proposal) return { ok: false, detail: "proposal no longer present in report" };
    if (c.proposal.status !== "awaiting-approval")
      return { ok: false, detail: `proposal is '${c.proposal.status}', not awaiting-approval` };
    if (action === "approve") {
      const change = applyRealTreeWrite(rootDir, c.file, c.proposal.mergedSource, "integrate");
      c.proposal.status = "approved-applied";
      c.proposal.applied = stamp;
      c.proposal.changeId = change.id;
      fs.writeFileSync(item.file, JSON.stringify(rep, null, 2));
      return { ok: true, action, detail: `merged source written to ${c.file} (change ${change.id}) — review the diff, then commit`, changeId: change.id, changeIds: [change.id] };
    }
    c.proposal.status = "dismissed";
    c.proposal.dismissed = { ...stamp, reason: reason ?? null };
    fs.writeFileSync(item.file, JSON.stringify(rep, null, 2));
    return { ok: true, action, detail: `proposal for ${c.file} dismissed` };
  }

  if (item.source === "fix") {
    const prop = rep; // proposals/*.json holds a single proposal object, not a report with an array
    if (prop.status !== "awaiting-approval")
      return { ok: false, detail: `fix proposal is '${prop.status}', not awaiting-approval` };
    if (action === "approve") {
      const changeIds = [];
      for (const [file, newSource] of Object.entries(prop.filesPatch ?? {})) {
        const change = applyRealTreeWrite(rootDir, file, newSource, "fix");
        changeIds.push(change.id);
      }
      prop.status = "approved-applied";
      prop.applied = stamp;
      prop.changeIds = changeIds;
      fs.writeFileSync(item.file, JSON.stringify(prop, null, 2));
      return { ok: true, action, detail: `fix applied to ${Object.keys(prop.filesPatch ?? {}).join(", ")} (changes ${changeIds.join(", ")})`, changeIds };
    }
    prop.status = "dismissed";
    prop.dismissed = { ...stamp, reason: reason ?? null };
    fs.writeFileSync(item.file, JSON.stringify(prop, null, 2));
    return { ok: true, action, detail: `fix proposal dismissed` };
  }

  const f = rep.findings[item.index];
  if (!f) return { ok: false, detail: "finding no longer present in report" };
  f.status = action === "approve" ? "approved" : "dismissed";
  f[action === "approve" ? "approved" : "dismissed"] = { ...stamp, ...(reason ? { reason } : {}) };
  fs.writeFileSync(item.file, JSON.stringify(rep, null, 2));
  return {
    ok: true, action,
    detail: action === "approve"
      ? `finding marked approved — queued for a fix pass (mapd never auto-fixes)`
      : `finding dismissed`,
  };
}
