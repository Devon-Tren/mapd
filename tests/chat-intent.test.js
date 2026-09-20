/**
 * tests/chat-intent.test.js — deterministic NL intent routing (no provider needed).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyIntent } from "../src/chat/intent.js";

test("classifyIntent: slash commands pass through with args", () => {
  assert.deepEqual(classifyIntent("/map"), { type: "slash", command: "/map", args: [] });
  assert.deepEqual(classifyIntent("/modernize heavy"), { type: "slash", command: "/modernize", args: ["heavy"] });
});

test("classifyIntent: unknown slash command is not silently accepted", () => {
  const r = classifyIntent("/nope");
  assert.equal(r.type, "unknown");
});

test("classifyIntent: natural language maps to the same slash commands", () => {
  assert.equal(classifyIntent("Run a project map.").command, "/map");
  assert.equal(classifyIntent("Create a baseline").command, "/baseline");
  assert.equal(classifyIntent("Check this project against the baseline").command, "/check");
  assert.equal(classifyIntent("Run the modernization scan").command, "/modernize");
  assert.equal(classifyIntent("Diagnose the understanding limits").command, "/diagnose");
});

test("classifyIntent: Score Intelligence / planner / verify phrasings route to the new commands", () => {
  assert.deepEqual(classifyIntent("what's the honest ceiling"), { type: "slash", command: "/score", args: ["ceiling"] });
  assert.deepEqual(classifyIntent("explain the confidence score"), { type: "slash", command: "/score", args: ["explain"] });
  // "why did confidence change" is now answered deterministically by /score delta, not LLM speculation
  assert.deepEqual(classifyIntent("Why did confidence change?"), { type: "slash", command: "/score", args: ["delta"] });
  assert.equal(classifyIntent("what should I work on next").command, "/improve");
  assert.equal(classifyIntent("show me the test gaps").command, "/test-gaps");
  assert.deepEqual(classifyIntent("which tests are padding"), { type: "slash", command: "/test-credit", args: ["--padding"] });
  assert.equal(classifyIntent("is the project passing").command, "/verify");
});

test("classifyIntent: new commands are accepted as typed slash commands with args", () => {
  assert.deepEqual(classifyIntent("/improve --budget 2h --risk low"),
    { type: "slash", command: "/improve", args: ["--budget", "2h", "--risk", "low"] });
  assert.deepEqual(classifyIntent("/verify --strict"), { type: "slash", command: "/verify", args: ["--strict"] });
});

test("classifyIntent: approve/dismiss findings with optional reason", () => {
  const approve = classifyIntent("Approve finding abc12345");
  assert.deepEqual(approve, { type: "review-action", action: "approve", id: "abc12345" });

  const dismiss = classifyIntent("Dismiss finding def67890 because it is intentional");
  assert.deepEqual(dismiss, { type: "review-action", action: "dismiss", id: "def67890", reason: "it is intentional" });
});

test("classifyIntent: fix routing distinguishes an explicit id from 'highest severity'", () => {
  assert.deepEqual(classifyIntent("Fix the highest-severity finding"), { type: "fix", id: null, autoSelectHighestSeverity: true });
  assert.deepEqual(classifyIntent("Fix finding abc12345"), { type: "fix", id: "abc12345", autoSelectHighestSeverity: false });
  assert.deepEqual(classifyIntent("Apply fix where you can"), { type: "fix", id: null, autoSelectHighestSeverity: true, autoApply: true });
  assert.deepEqual(classifyIntent("Apply the fix for finding abc12345"), { type: "fix", id: "abc12345", autoSelectHighestSeverity: false, autoApply: true });
});

test("classifyIntent: dev commands route to safe argument-array commands, never raw shell text", () => {
  assert.deepEqual(classifyIntent("Run the tests"), { type: "dev-command", cmd: "npm", args: ["test"] });
  assert.deepEqual(classifyIntent("Run the linter"), { type: "dev-command", cmd: "npm", args: ["run", "lint"] });
  assert.deepEqual(classifyIntent("Install dependencies"), { type: "dev-command", cmd: "npm", args: ["install"] });
  assert.deepEqual(classifyIntent("Show me the current git diff"), { type: "dev-command", cmd: "git", args: ["diff"] });
});

test("classifyIntent: search and watch route deterministically", () => {
  assert.deepEqual(classifyIntent("Search for all references to getUser"), { type: "search", query: "getUser" });
  assert.equal(classifyIntent("Start watching the project").type, "watch");
});

test("classifyIntent: free-form questions fall through to unknown (handled by provider or a clear fallback message)", () => {
  assert.equal(classifyIntent("What does this project do?").type, "unknown");
});

test("classifyIntent: evidence questions route to /evidence with the finding ID as the argument", () => {
  assert.deepEqual(classifyIntent("show the evidence for finding db9ab07b"), { type: "slash", command: "/evidence", args: ["db9ab07b"] });
  assert.deepEqual(classifyIntent("why is db9ab07b flagged"), { type: "slash", command: "/evidence", args: ["db9ab07b"] });
  assert.deepEqual(classifyIntent("explain evidence behind f4597a50"), { type: "slash", command: "/evidence", args: ["f4597a50"] });
});

test("classifyIntent: typed /evidence <id> is recognized as a slash command with args", () => {
  const r = classifyIntent("/evidence db9ab07b");
  assert.equal(r.type, "slash");
  assert.equal(r.command, "/evidence");
  assert.deepEqual(r.args, ["db9ab07b"]);
});

// trace/resolution/find: the folded-in replacements for the CLI's now-hidden
// `trace`, `resolution`, and `context` top-level commands.
test("classifyIntent: trace phrasings route to /trace with file(s) as args", () => {
  assert.deepEqual(classifyIntent("trace src/helper.js"), { type: "slash", command: "/trace", args: ["src/helper.js"] });
  assert.deepEqual(classifyIntent("trace src/a.js to src/b.js"), { type: "slash", command: "/trace", args: ["src/a.js", "src/b.js"] });
  assert.deepEqual(classifyIntent("why is src/helper.js in the workflow"), { type: "slash", command: "/trace", args: ["src/helper.js"] });
  assert.deepEqual(classifyIntent("show the import chain from src/a.js to src/b.js"), { type: "slash", command: "/trace", args: ["src/a.js", "src/b.js"] });
});

test("classifyIntent: resolution-rate phrasings route to /resolution", () => {
  assert.equal(classifyIntent("what's dragging down the resolution rate").command, "/resolution");
  assert.equal(classifyIntent("show unresolved calls").command, "/resolution");
});

test("classifyIntent: find/where-is phrasings route to /find with the query as args", () => {
  assert.deepEqual(classifyIntent("find code related to authentication"), { type: "slash", command: "/find", args: ["authentication"] });
  assert.deepEqual(classifyIntent("where is getUser"), { type: "slash", command: "/find", args: ["getUser"] });
});

test("classifyIntent: 'search for references to X' still routes to the search intent, not /find", () => {
  // /find's phrasing must not shadow the pre-existing dedicated search route.
  assert.deepEqual(classifyIntent("Search for all references to getUser"), { type: "search", query: "getUser" });
});
