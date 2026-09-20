/**
 * tests/mcp.test.js — mapd mcp: a real MCP client talking to a real MCP
 * server over an in-memory transport (same protocol path as stdio, no
 * subprocess needed for speed). Verifies a read-only tool succeeds directly
 * and the one mutation tool is denied without explicit approve:true, with a
 * machine-readable reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { saveBaseline } from "../src/core/regression.js";
import { buildScoredGraph } from "../src/core/intelligence.js";
import { saveFindings } from "../src/core/regression.js";

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-mcp-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), `export function greet(){ return "hi"; }\n`);
  return dir;
}

async function connectedClient() {
  const server = createMcpServer();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test("mcp: lists all documented tools", async () => {
  const { client } = await connectedClient();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "apply_approved_fix", "check_project", "compare_baseline", "generate_docs",
    "get_finding", "get_finding_evidence", "get_handoff", "get_mapd_status",
    "get_project_diagnosis", "get_project_summary", "get_solutions", "get_symbol",
    "get_task_context",
    "get_workflow", "list_annotations", "list_changes", "list_findings", "map_project", "modernize_project",
    "profile_project", "propose_fix", "rollback_change", "search_project", "verify_proposal",
  ].sort());
});

test("mcp: a read-only tool (map_project) runs directly and returns real data", async () => {
  const dir = tmpProject();
  const { client } = await connectedClient();
  const result = await client.callTool({ name: "map_project", arguments: { dir } });
  assert.equal(result.isError, false);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.stats.fileCount, 1);
});

test("mcp: get_project_summary and get_mapd_status reflect real project state", async () => {
  const dir = tmpProject();
  const { client } = await connectedClient();
  const summary = JSON.parse((await client.callTool({ name: "get_project_summary", arguments: { dir } })).content[0].text);
  assert.equal(summary.summary.fileCount, 1);

  const status = JSON.parse((await client.callTool({ name: "get_mapd_status", arguments: { dir } })).content[0].text);
  assert.equal(status.baseline, "none");
});

test("mcp: unknown tool name is denied with a machine-readable reason", async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({ name: "not_a_real_tool", arguments: {} });
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.denied, true);
  assert.match(payload.reason, /Unknown tool/);
});

test("mcp: apply_approved_fix is denied without explicit approve:true, with a machine-readable reason", async () => {
  const dir = tmpProject();
  const { client } = await connectedClient();
  const result = await client.callTool({ name: "apply_approved_fix", arguments: { dir, id: "deadbeef" } });
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.denied, true);
  assert.equal(payload.requiresApproval, true);
  assert.match(payload.reason, /requires an explicit approve:true/);
});

test("mcp: apply_approved_fix with approve:true but a nonexistent proposal is still denied (never fabricates success)", async () => {
  const dir = tmpProject();
  const { client } = await connectedClient();
  const result = await client.callTool({ name: "apply_approved_fix", arguments: { dir, id: "deadbeef", approve: true } });
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.denied, true);
});

test("mcp: check_project reports real regression findings after an export is removed", async () => {
  const dir = tmpProject();
  const baseline = buildScoredGraph(dir);
  saveBaseline(dir, baseline);
  fs.writeFileSync(path.join(dir, "index.js"), `// export removed\n`);

  const { client } = await connectedClient();
  const result = await client.callTool({ name: "check_project", arguments: { dir } });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, true);
  assert.ok(payload.findings.some((f) => f.kind === "export-removed"));
});

test("mcp: get_task_context returns ranked graph context for a query", async () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, "auth"), { recursive: true });
  fs.writeFileSync(path.join(dir, "auth", "session.js"), `export function loginUser(){ return true; }\n`);
  fs.writeFileSync(path.join(dir, "index.js"), `import { loginUser } from "./auth/session.js";\nexport function greet(){ return loginUser(); }\n`);

  const { client } = await connectedClient();
  const result = await client.callTool({ name: "get_task_context", arguments: { dir, query: "login session" } });
  assert.equal(result.isError, false);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, true);
  assert.ok(payload.context.files.some((f) => f.file === "auth/session.js"));
  assert.ok(payload.context.hits.some((h) => h.function === "loginUser"));
});

test("mcp: get_project_diagnosis returns deterministic understanding limits", async () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "index.js"), `export function greet(){ return process.env.PORT; }\n`);

  const { client } = await connectedClient();
  const result = await client.callTool({ name: "get_project_diagnosis", arguments: { dir } });
  assert.equal(result.isError, false);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, true);
  assert.ok(payload.diagnosis.env.keys.some((k) => k.key === "PORT"));
  assert.ok(Array.isArray(payload.diagnosis.recommendations));
});

test("mcp: profile_project returns map timing and optional modernization phase timing", async () => {
  const dir = tmpProject();
  const { client } = await connectedClient();
  const result = await client.callTool({ name: "profile_project", arguments: { dir, modernizeMode: "light", checkRegistry: false } });
  assert.equal(result.isError, false);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.profile.map.fileCount, 1);
  assert.equal(payload.profile.modernize.mode, "light");
  assert.ok(payload.profile.modernize.profile.steps.some((s) => s.name === "dependency-health"));
});

test("mcp: list_findings / get_finding surface the same review queue used by review.js", async () => {
  const dir = tmpProject();
  const baseline = buildScoredGraph(dir);
  saveBaseline(dir, baseline);
  fs.writeFileSync(path.join(dir, "index.js"), `// export removed\n`);
  const current = buildScoredGraph(dir);
  const { diffGraphs } = await import("../src/core/regression.js");
  saveFindings(dir, diffGraphs(baseline, current));

  const { client } = await connectedClient();
  const list = JSON.parse((await client.callTool({ name: "list_findings", arguments: { dir } })).content[0].text);
  assert.equal(list.items.length, 1);
  const one = JSON.parse((await client.callTool({ name: "get_finding", arguments: { dir, id: list.items[0].id } })).content[0].text);
  assert.equal(one.ok, true);
  assert.equal(one.item.id, list.items[0].id);
});

test("mcp: list_findings items carry derived states and the freshness result they came from", async () => {
  const dir = tmpProject();
  const baseline = buildScoredGraph(dir);
  saveBaseline(dir, baseline);
  fs.writeFileSync(path.join(dir, "index.js"), `// export removed\n`);
  const current = buildScoredGraph(dir);
  const { diffGraphs } = await import("../src/core/regression.js");
  saveFindings(dir, diffGraphs(baseline, current));

  const { client } = await connectedClient();
  const list = JSON.parse((await client.callTool({ name: "list_findings", arguments: { dir } })).content[0].text);
  assert.ok(list.items.every((i) => ["active", "stale"].includes(i.state)));
  assert.ok(list.freshness, "freshness must accompany the states it derived");
});

test("mcp: get_finding_evidence returns the deterministic evidence view; unknown ID is denied", async () => {
  const dir = tmpProject();
  const baseline = buildScoredGraph(dir);
  saveBaseline(dir, baseline);
  fs.writeFileSync(path.join(dir, "index.js"), `// export removed\n`);
  const current = buildScoredGraph(dir);
  const { diffGraphs } = await import("../src/core/regression.js");
  saveFindings(dir, diffGraphs(baseline, current));

  const { client } = await connectedClient();
  const list = JSON.parse((await client.callTool({ name: "list_findings", arguments: { dir } })).content[0].text);
  const evidence = JSON.parse((await client.callTool({ name: "get_finding_evidence", arguments: { dir, id: list.items[0].id } })).content[0].text);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.evidence.evidenceType, "finding");
  assert.ok(["active", "stale"].includes(evidence.evidence.state));

  const missing = JSON.parse((await client.callTool({ name: "get_finding_evidence", arguments: { dir, id: "deadbeef" } })).content[0].text);
  assert.equal(missing.denied, true);
});

test("mcp: get_handoff and get_solutions expose the same packaging as the CLI", async () => {
  const dir = tmpProject();
  const { client } = await connectedClient();
  const handoff = JSON.parse((await client.callTool({ name: "get_handoff", arguments: { dir } })).content[0].text);
  assert.equal(handoff.ok, true);
  assert.equal(handoff.handoff.fileCount, 1);
  assert.match(handoff.prompt, /No open findings|CONTEXT/);

  const solutions = JSON.parse((await client.callTool({ name: "get_solutions", arguments: { dir } })).content[0].text);
  assert.equal(solutions.ok, true);
  assert.ok(Array.isArray(solutions.solutions.solutions));
});

test("mcp: rollback_change is denied without approve:true and never invents a change", async () => {
  const dir = tmpProject();
  const { client } = await connectedClient();
  const denied = JSON.parse((await client.callTool({ name: "rollback_change", arguments: { dir, changeId: "chg-x" } })).content[0].text);
  assert.equal(denied.denied, true);
  assert.equal(denied.requiresApproval, true);

  const missing = JSON.parse((await client.callTool({ name: "rollback_change", arguments: { dir, changeId: "chg-x", approve: true } })).content[0].text);
  assert.equal(missing.denied, true);
  assert.match(missing.reason, /no change with id/);
});

test("mcp: list_changes and list_annotations read the same records the CLI writes", async () => {
  const dir = tmpProject();
  const { setAnnotation } = await import("../src/config/index.js");
  setAnnotation(dir, "index.js", "generated");

  const { client } = await connectedClient();
  const changes = JSON.parse((await client.callTool({ name: "list_changes", arguments: { dir } })).content[0].text);
  assert.equal(changes.changes.length, 1);
  assert.equal(changes.changes[0].source, "annotate");

  const annotations = JSON.parse((await client.callTool({ name: "list_annotations", arguments: { dir } })).content[0].text);
  assert.equal(annotations.ok, true);
  const entry = annotations.annotations.find((a) => a.pattern === "index.js");
  assert.equal(entry.classification, "generated");
  assert.deepEqual(entry.matchedFiles, ["index.js"]);
});
