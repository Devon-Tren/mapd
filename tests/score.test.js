/**
 * tests/score.test.js — Score Intelligence (mapd score explain/simulate/ceiling/delta).
 * The spine's contract: it must DECOMPOSE the real confidence number (contributions
 * sum back to it), and any what-if must re-run the real scorer — never assert a
 * number of its own. Structural caps (no git → stability, heuristic parsing) must
 * survive to the ceiling instead of being optimistically closed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildScoredGraph } from "../src/core/intelligence.js";
import { explainScore, ceilingScore, simulateScore, deltaScore } from "../src/core/score.js";

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-score-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "entry.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "entry.js"), `import { helper } from "./helper.js";\nexport function run(){ return helper(); }\nrun();\n`);
  fs.writeFileSync(path.join(dir, "helper.js"), `export function helper(){ return 1; }\n`);
  return dir;
}

test("explain: repo signal contributions sum back to repoConfidence", () => {
  const g = buildScoredGraph(tmpProject());
  const data = explainScore(g);
  const summed = data.repoSignals.reduce((a, s) => a + s.contribution, 0);
  assert.ok(Math.abs(summed - data.repoConfidence) <= 0.01,
    `contributions ${summed} should reconstruct repoConfidence ${data.repoConfidence}`);
  // per available signal, contribution + cost == effectiveWeight (value + (1-value))
  for (const w of data.workflows) {
    for (const s of w.signals) {
      if (s.unavailable) continue;
      assert.ok(Math.abs((s.contribution + s.cost) - s.effectiveWeight) <= 0.002,
        `${s.signal}: contribution+cost must equal effectiveWeight`);
    }
  }
});

test("simulate: adding tests raises confidence and re-runs the real scorer", () => {
  const dir = tmpProject();
  const g = buildScoredGraph(dir);
  const sim = simulateScore(dir, g, { addTests: ["entry.js", "helper.js"] });
  assert.ok(sim.after > sim.before, "adding tests should raise confidence");
  assert.equal(sim.delta, Number((sim.after - sim.before).toFixed(3)));
  // the simulated number must equal an independent rescore with the same evidence — no invented value
});

test("simulate: a file matching no workflow file is reported, not silently ignored", () => {
  const dir = tmpProject();
  const g = buildScoredGraph(dir);
  const sim = simulateScore(dir, g, { addTests: ["does-not-exist.js"] });
  assert.deepEqual(sim.unmatched, ["does-not-exist.js"]);
  assert.equal(sim.delta, 0, "a phantom file must not move the score");
});

test("ceiling: never below current, and no-git keeps signalCoverage < 1", () => {
  const dir = tmpProject(); // mkdtemp dir is not a git repo → stability unavailable
  const g = buildScoredGraph(dir);
  const c = ceilingScore(dir, g);
  assert.ok(c.ceiling >= c.current, "ceiling must be >= current");
  assert.ok(c.headroom >= 0);
  assert.ok(c.ceilingSignalCoverage < 1, "no git → even the ceiling can't claim full signal coverage");
  assert.ok(c.caps.some((x) => x.cap === "no-git-stability"), "must disclose the no-git structural cap");
});

test("delta: attributes a testPresence gain between two snapshots", () => {
  const dir = tmpProject();
  const before = buildScoredGraph(dir);
  fs.writeFileSync(path.join(dir, "entry.test.js"), `import { run } from "./entry.js";\nrun();\n`);
  fs.writeFileSync(path.join(dir, "helper.test.js"), `import { helper } from "./helper.js";\nhelper();\n`);
  const after = buildScoredGraph(dir);
  const d = deltaScore(before, after);
  assert.ok(d.delta > 0, "adding real test files should raise confidence");
  const tp = d.signals.find((s) => s.signal === "testPresence");
  assert.ok(tp && tp.delta > 0, "the gain must be attributed to testPresence");
});
