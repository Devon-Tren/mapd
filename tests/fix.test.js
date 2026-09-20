/**
 * tests/fix.test.js — full mapd fix lifecycle against a stub provider (an
 * in-process HTTP server standing in for an OpenAI-compatible endpoint) —
 * no real API credentials anywhere in this file. Covers:
 * propose -> gate-fail -> retry-with-feedback -> pass -> save proposal,
 * and the "no provider configured" honest failure path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { saveBaseline } from "../src/core/regression.js";
import { buildScoredGraph } from "../src/core/intelligence.js";
import { saveFindings } from "../src/core/regression.js";
import { loadQueue, pending, transition } from "../src/core/review.js";
import { runFixLifecycle, loadFinding, candidateFilesForFinding } from "../src/core/fix.js";
import { chooseFixTarget, approveFixWithPostApplyVerification } from "../src/core/fixApply.js";
import { loadChanges } from "../src/core/changes.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

function fixtureWithRegressionFinding() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-fix-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "greet.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "greet.js"), `export function greet(n){ return "hi " + n; }\nexport function farewell(n){ return "bye " + n; }\n`);
  const baseline = buildScoredGraph(dir);
  saveBaseline(dir, baseline);

  // regress: drop the `farewell` export
  fs.writeFileSync(path.join(dir, "greet.js"), `export function greet(n){ return "hi " + n; }\n`);
  const current = buildScoredGraph(dir);
  const findings = [{
    severity: "high", kind: "export-removed",
    detail: `Workflow ${current.workflows[0].id} removed exported symbols: farewell.`,
    evidence: { removed: ["farewell"] },
    status: "awaiting-approval",
  }];
  saveFindings(dir, findings);
  return { dir, findingDetail: findings[0].detail };
}

/** A stub OpenAI-compatible server: first call returns a patch that drops `greet` too (fails gates), second call returns a correct fix. */
function startStubProvider({ badThenGood = true } = {}) {
  let call = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      call++;
      const bad = JSON.stringify({
        summary: "restore farewell (buggy attempt)",
        reasoning_summary: "attempt 1",
        files: ["greet.js"],
        patch: { "greet.js": `export function farewell(n){ return "bye " + n; }\n` }, // drops `greet`!
        expected_effect: "restores farewell",
        risks: [], verification_plan: [],
      });
      const good = JSON.stringify({
        summary: "restore farewell",
        reasoning_summary: "attempt 2, keeping greet intact per retry feedback",
        files: ["greet.js"],
        patch: { "greet.js": `export function greet(n){ return "hi " + n; }\nexport function farewell(n){ return "bye " + n; }\n` },
        expected_effect: "restores the farewell export without touching greet",
        risks: [], verification_plan: ["mapd check"],
      });
      const content = badThenGood ? (call === 1 ? bad : good) : bad;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

test("loadFinding + candidateFilesForFinding: resolves a check finding and its files via workflow lookup", () => {
  const { dir } = fixtureWithRegressionFinding();
  const item = pending(loadQueue(dir))[0];
  const loaded = loadFinding(dir, item.id);
  assert.ok(loaded);
  const graph = buildScoredGraph(dir);
  const files = candidateFilesForFinding(loaded.finding, graph);
  assert.deepEqual(files, ["greet.js"]);
});

test("chooseFixTarget: picks the strongest open check/modernize finding deterministically", () => {
  const selected = chooseFixTarget([
    { id: "modern", source: "modernize-heavy", status: "awaiting-approval", priority: 0.99, kind: "duplicate-functions" },
    { id: "dismissed", source: "check", status: "dismissed", severity: "high", kind: "export-removed" },
    { id: "medium", source: "check", status: "awaiting-approval", severity: "medium", kind: "workflow-confidence-drop" },
    { id: "high", source: "check", status: "awaiting-approval", severity: "high", kind: "export-removed" },
  ]);
  assert.equal(selected.id, "high");
});

test("mapd fix --propose --dry-run: omitted id auto-selects an open finding instead of failing argument parsing", () => {
  const { dir } = fixtureWithRegressionFinding();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-fakehome-"));
  const r = spawnSync(process.execPath, [CLI, "fix", "--propose", "--dry-run"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", KIMI_API_KEY: "", HOME: home },
  });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 1);
  assert.match(out, /Auto-selected finding [0-9a-f]{8}/);
  assert.doesNotMatch(out, /missing required argument 'id'/);

  const explicitDir = spawnSync(process.execPath, [CLI, "fix", "--propose", "--dry-run", dir], {
    cwd: path.dirname(dir),
    encoding: "utf8",
    env: { ...process.env, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", KIMI_API_KEY: "", HOME: home },
  });
  const explicitOut = `${explicitDir.stdout}\n${explicitDir.stderr}`;
  assert.equal(explicitDir.status, 1);
  assert.match(explicitOut, /Auto-selected finding [0-9a-f]{8}/);
  assert.doesNotMatch(explicitOut, /no fixable finding with id/);
});

test("approveFixWithPostApplyVerification: rolls back when real-tree project checks fail", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-fixapply-"));
  fs.mkdirSync(path.join(dir, ".mapd", "proposals"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "fixapply",
    type: "module",
    main: "index.js",
    scripts: { test: "node test.js" },
  }));
  fs.writeFileSync(path.join(dir, "index.js"), `export const value = "good";\n`);
  fs.writeFileSync(path.join(dir, "test.js"), `import fs from "node:fs";\nif (!fs.readFileSync(new URL("./index.js", import.meta.url), "utf8").includes('"good"')) process.exit(1);\n`);
  const proposalPath = path.join(dir, ".mapd", "proposals", "finding-1.json");
  fs.writeFileSync(proposalPath, JSON.stringify({
    mapdSchema: 1,
    findingId: "finding-1",
    findingKind: "test",
    findingDetail: "fixture",
    filesPatch: { "index.js": `export const value = "bad";\n` },
    attempts: [{ attempt: 1, passed: true, gates: [] }],
    status: "awaiting-approval",
  }, null, 2));

  const item = pending(loadQueue(dir)).find((i) => i.source === "fix");
  const r = approveFixWithPostApplyVerification(dir, item, { fix: { runTests: true, runLint: false, runTypecheck: false } });
  assert.equal(r.ok, false);
  assert.match(r.detail, /post-apply verification failed/);
  assert.match(fs.readFileSync(path.join(dir, "index.js"), "utf8"), /"good"/);

  const proposal = JSON.parse(fs.readFileSync(proposalPath, "utf8"));
  assert.equal(proposal.status, "rolled-back-after-apply");
  assert.equal(proposal.postApplyVerification.ok, false);
  assert.ok(proposal.postApplyVerification.issues.some((i) => /npm test failed/.test(i)));
  assert.equal(loadChanges(dir).filter((c) => c.source === "fix")[0].rolledBack, true);
});

test("runFixLifecycle: with no provider configured, fails honestly without fabricating a fix", async () => {
  const { dir } = fixtureWithRegressionFinding();
  const item = pending(loadQueue(dir))[0];
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const r = await runFixLifecycle(dir, item.id, { chat: { provider: "auto" } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /requires a configured LLM provider/);
});

test("runFixLifecycle: retries after a gate failure with structured feedback, then passes and saves a proposal", async () => {
  const { dir } = fixtureWithRegressionFinding();
  const item = pending(loadQueue(dir))[0];
  const server = await startStubProvider({ badThenGood: true });
  const { port } = server.address();
  process.env.OPENAI_API_KEY = "sk-test-not-real";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  try {
    const r = await runFixLifecycle(dir, item.id, { chat: { provider: "openai" }, fix: { maxAttempts: 2 } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.stopReason, "passed");
    assert.equal(r.attempts.length, 2, "first attempt (bad) then second (good)");
    assert.equal(r.attempts[0].passed, false);
    assert.equal(r.attempts[1].passed, true);
    assert.equal(r.proposalRecord.status, "awaiting-approval");
    assert.ok(fs.existsSync(r.proposalPath));

    // review --approve <fix-id> feeds directly into applying the verified fix
    const fixItem = pending(loadQueue(dir)).find((i) => i.source === "fix");
    assert.ok(fixItem, "fix proposal must appear in the unified review queue");
    const approval = transition(dir, fixItem, "approve");
    assert.equal(approval.ok, true);
    const written = fs.readFileSync(path.join(dir, "greet.js"), "utf8");
    assert.match(written, /farewell/);
    assert.match(written, /greet/);
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    server.close();
  }
});

test("runFixLifecycle: exhausts maxAttempts and records rejected-by-gate when every attempt fails", async () => {
  const { dir } = fixtureWithRegressionFinding();
  const item = pending(loadQueue(dir))[0];
  const server = await startStubProvider({ badThenGood: false });
  const { port } = server.address();
  process.env.OPENAI_API_KEY = "sk-test-not-real";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  try {
    const r = await runFixLifecycle(dir, item.id, { chat: { provider: "openai" }, fix: { maxAttempts: 2 } });
    assert.equal(r.ok, true);
    assert.equal(r.proposalRecord.status, "rejected-by-gate");
    assert.ok(["max-attempts", "repeated-failure"].includes(r.stopReason));
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    server.close();
  }
});

test("runFixLifecycle: --dry-run does not persist a proposal file", async () => {
  const { dir } = fixtureWithRegressionFinding();
  const item = pending(loadQueue(dir))[0];
  const server = await startStubProvider({ badThenGood: true });
  const { port } = server.address();
  process.env.OPENAI_API_KEY = "sk-test-not-real";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  try {
    const r = await runFixLifecycle(dir, item.id, { chat: { provider: "openai" }, fix: { maxAttempts: 2 } }, { dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.ok(!fs.existsSync(path.join(dir, ".mapd", "proposals")));
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    server.close();
  }
});
