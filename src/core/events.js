/**
 * events.js — structured watch events, shared by `mapd watch`'s console
 * output and any in-process subscriber (chat's "watch this project and tell
 * me when X regresses"). Built on node:events — zero new dependency.
 */

import { EventEmitter } from "node:events";

export function createWatchBus() {
  return new EventEmitter();
}

/**
 * Turns one rescan's raw inputs into a structured event payload. Kept as a
 * pure function (not baked into the emitter) so it's independently testable.
 */
export function buildRescanEvent({ durationMs, parsed, prevGraph, newGraph, findings }) {
  const newOrphans = newGraph.orphans.filter((o) => !prevGraph.orphans.includes(o));
  const resolvedOrphans = prevGraph.orphans.filter((o) => !newGraph.orphans.includes(o));
  const deltaConfidence = Number((newGraph.repoConfidence - prevGraph.repoConfidence).toFixed(3));

  const prevWfById = new Map(prevGraph.workflows.map((w) => [w.id, w]));
  const affectedWorkflows = newGraph.workflows
    .filter((wf) => {
      const prev = prevWfById.get(wf.id);
      return !prev || prev.confidence.score !== wf.confidence.score;
    })
    .map((wf) => ({ id: wf.id, confidence: wf.confidence.score, previousConfidence: prevWfById.get(wf.id)?.confidence.score ?? null }));

  const newFindings = findings.filter((f) => f.kind !== "workflow-added");
  const resolvedFindings = findings.filter((f) => f.kind === "workflow-added");

  return {
    type: "remap",
    at: new Date().toISOString(),
    durationMs,
    reparsedCount: parsed.parsedCount,
    cacheHits: parsed.cacheHits,
    repoConfidence: { from: prevGraph.repoConfidence, to: newGraph.repoConfidence, delta: deltaConfidence },
    affectedWorkflows,
    newFindings,
    resolvedFindings,
    newOrphans,
    resolvedOrphans,
  };
}

/** Emits the structured event plus one per-finding event (`regression` for high severity, `finding` otherwise). */
export function emitRescanEvent(bus, payload) {
  bus.emit("remap", payload);
  for (const f of payload.newFindings) bus.emit(f.severity === "high" ? "regression" : "finding", f);
  for (const f of payload.resolvedFindings) bus.emit("resolved", f);
}
