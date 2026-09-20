/**
 * watch.js — the reusable watch loop (hash-cached remap on file change,
 * structured events) shared by `mapd watch` and chat's in-session watch
 * subscription. Only one implementation of the fs.watch/debounce/remap
 * logic exists — cli.js and chat/repl.js both consume it.
 */

import fs from "node:fs";
import path from "node:path";
import { parseProject } from "./parser.js";
import { buildGraph, loadPkg } from "./graph.js";
import { scoreGraph } from "./confidence.js";
import { diffGraphs } from "./regression.js";
import { createWatchBus, buildRescanEvent, emitRescanEvent } from "./events.js";
import { loadConfig } from "../config/index.js";

/**
 * Starts watching `rootDir`. Returns `{ bus, initialGraph, stop() }`.
 * `bus` emits: "remap", "regression", "finding", "resolved" (see events.js).
 * Never throws on transient parse errors during a rescan — reports them and
 * keeps watching, matching `mapd watch`'s existing behavior.
 */
export function startWatcher(rootDir, { intervalMs = 400, bus = createWatchBus() } = {}) {
  const abs = path.resolve(rootDir);
  const config = loadConfig(abs);
  const cache = new Map();
  const build = () => {
    const parsed = parseProject(abs, {
      cache,
      ignore: new Set(),
      include: config.project?.include ?? [],
      exclude: config.project?.exclude ?? [],
      maxFileSizeBytes: config.mapping?.maxFileSizeBytes ?? Infinity,
      polyglot: config.mapping?.polyglot !== false,
    });
    const g = scoreGraph(abs, buildGraph(abs, parsed, loadPkg(abs), { annotations: config.project?.annotations ?? {} }));
    return { g, parsed };
  };

  let { g: prev } = build();
  const initialGraph = prev;
  let timer = null;

  const rescan = () => {
    const t0 = Date.now();
    let g, parsed;
    try {
      ({ g, parsed } = build());
    } catch (e) {
      bus.emit("error", e);
      return;
    }
    const durationMs = Date.now() - t0;
    const findings = diffGraphs(prev, g);
    emitRescanEvent(bus, buildRescanEvent({ durationMs, parsed, prevGraph: prev, newGraph: g, findings }));
    prev = g;
  };

  const watcher = fs.watch(abs, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const n = filename.toString();
    if (n.includes("node_modules") || n.startsWith(".mapd") || n.startsWith(".git")) return;
    if (!/\.(js|jsx|ts|tsx|mjs|cjs|mts|cts|json)$/.test(n)) return;
    clearTimeout(timer);
    timer = setTimeout(rescan, Math.max(50, intervalMs));
  });

  return {
    bus,
    initialGraph,
    stop() {
      clearTimeout(timer);
      watcher.close();
    },
  };
}
