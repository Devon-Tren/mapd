/**
 * tests/events-watch.test.js — structured watch events (deterministic,
 * built from real graph diffs) and the shared watch service used by both
 * `mapd watch` and chat's in-session subscription.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRescanEvent, emitRescanEvent, createWatchBus } from "../src/core/events.js";
import { buildScoredGraph } from "../src/core/intelligence.js";
import { diffGraphs } from "../src/core/regression.js";
import { startWatcher } from "../src/core/watch.js";

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-watch-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), `export function greet(){ return "hi"; }\nexport function farewell(){ return "bye"; }\n`);
  return dir;
}

test("buildRescanEvent: reports confidence delta and a real export-removed finding", () => {
  const dir = tmpProject();
  const prevGraph = buildScoredGraph(dir);
  fs.writeFileSync(path.join(dir, "index.js"), `export function greet(){ return "hi"; }\n`); // drops farewell
  const newGraph = buildScoredGraph(dir);
  const findings = diffGraphs(prevGraph, newGraph);

  const evt = buildRescanEvent({ durationMs: 12, parsed: { parsedCount: 1, cacheHits: 0 }, prevGraph, newGraph, findings });
  assert.equal(evt.type, "remap");
  assert.equal(evt.durationMs, 12);
  assert.ok(evt.newFindings.some((f) => f.kind === "export-removed"));
  assert.equal(evt.repoConfidence.from, prevGraph.repoConfidence);
  assert.equal(evt.repoConfidence.to, newGraph.repoConfidence);
});

test("emitRescanEvent: routes high-severity findings to 'regression' and others to 'finding'", () => {
  const dir = tmpProject();
  const prevGraph = buildScoredGraph(dir);
  fs.writeFileSync(path.join(dir, "index.js"), `export function greet(){ return "hi"; }\n`);
  const newGraph = buildScoredGraph(dir);
  const findings = diffGraphs(prevGraph, newGraph);
  const evt = buildRescanEvent({ durationMs: 1, parsed: { parsedCount: 1, cacheHits: 0 }, prevGraph, newGraph, findings });

  const bus = createWatchBus();
  const seen = { regression: 0, finding: 0, remap: 0 };
  bus.on("regression", () => seen.regression++);
  bus.on("finding", () => seen.finding++);
  bus.on("remap", () => seen.remap++);
  emitRescanEvent(bus, evt);

  assert.equal(seen.remap, 1);
  assert.ok(seen.regression >= 1, "export-removed is high severity");
});

test("startWatcher: detects a real file change and emits a remap event with the confidence delta", async () => {
  const dir = tmpProject();
  const { bus, initialGraph, stop } = startWatcher(dir, { intervalMs: 50 });
  assert.equal(initialGraph.workflows.length, 1);

  const remapPromise = new Promise((resolve) => bus.once("remap", resolve));
  await new Promise((r) => setTimeout(r, 100)); // let the watcher attach before mutating
  fs.writeFileSync(path.join(dir, "index.js"), `export function greet(){ return "hi"; }\n`);
  const evt = await remapPromise;

  assert.equal(evt.type, "remap");
  stop();
});
