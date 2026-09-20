/**
 * tests/chat-commandrunner.test.js — safe dev-command execution: allowlist
 * enforcement, approval gating, output capping, secret redaction, and that
 * a long-running ("networked") command is tracked for later cleanup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand, getActiveChildren, killActiveChildren } from "../src/chat/commandRunner.js";

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-cmdrun-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", type: "module", scripts: { test: "node -e \"console.log('ok')\"" } }));
  return dir;
}

test("runCommand: refuses a command that is not on the allowlist, without spawning anything", async () => {
  const dir = tmpProject();
  const r = await runCommand("curl", ["http://example.com"], { cwd: dir, config: {} });
  assert.equal(r.denied, true);
  assert.match(r.reason, /not an allowlisted command/);
});

test("runCommand: read-only commands auto-run when config allows it", async () => {
  const dir = tmpProject();
  const r = await runCommand("git", ["status"], { cwd: dir, config: { chat: { autoRunReadOnly: true } } });
  assert.equal(r.denied, undefined);
  assert.equal(r.classification, "read-only");
});

test("runCommand: a git-mutation command is refused without explicit approval", async () => {
  const dir = tmpProject();
  const r = await runCommand("git", ["commit", "-m", "x"], { cwd: dir, config: {}, approved: false });
  assert.equal(r.denied, true);
  assert.equal(r.requiresApproval, true);
});

test("runCommand: executes an allowlisted verification command and captures output", async () => {
  const dir = tmpProject();
  const r = await runCommand("npm", ["test"], { cwd: dir, config: { chat: { autoRunReadOnly: true } } });
  assert.equal(r.ok, true);
  assert.match(r.stdout, /ok/);
});

test("runCommand: caps output to maxOutputChars", async () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "t", type: "module", scripts: { test: `node -e "console.log('x'.repeat(1000))"` },
  }));
  const r = await runCommand("npm", ["test"], { cwd: dir, config: { chat: { autoRunReadOnly: true } }, maxOutputChars: 50 });
  assert.equal(r.ok, true);
  assert.ok(r.stdout.length <= 50);
});

test("runCommand: redacts secrets from captured output", async () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "t", type: "module", scripts: { test: `node -e "console.log('sk-ant-abcdefghijklmnopqrstuvwxyz1234567890')"` },
  }));
  const r = await runCommand("npm", ["test"], { cwd: dir, config: { chat: { autoRunReadOnly: true } } });
  assert.ok(!r.stdout.includes("sk-ant-abcdefghijklmnopqrstuvwxyz1234567890"));
  assert.match(r.stdout, /REDACTED/);
});

test("runCommand: a networked (dev-server) command is tracked and killActiveChildren stops it", async () => {
  const dir = tmpProject();
  const r = await runCommand("npm", ["run", "dev"], {
    cwd: dir, config: { security: { allowNetworkCommands: true } }, approved: true,
  });
  // package.json has no "dev" script, so npm will exit quickly with an error — but it must
  // still have been spawned and tracked (that's what we're verifying, not npm's own success).
  assert.equal(r.longRunning, true);
  assert.ok(r.pid);
  killActiveChildren();
  assert.equal(getActiveChildren().size, 0);
});
