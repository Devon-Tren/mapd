/**
 * tests/proc.test.js — package-manager spawns work on Windows (.cmd shims need
 * a shell) without letting shell metacharacters through.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { platformCommand } from "../src/core/proc.js";

test("non-Windows and non-shim commands pass through untouched", () => {
  assert.deepEqual(platformCommand("npm", ["test"], { cwd: "/x" }, "darwin"), { file: "npm", args: ["test"], options: { cwd: "/x" } });
  assert.deepEqual(platformCommand("git", ["status"], {}, "win32"), { file: "git", args: ["status"], options: {} });
});

test("on Windows, npm runs as npm.cmd through the shell with args quoted", () => {
  const pc = platformCommand("npm", ["run", "my script"], { cwd: "C:\\p" }, "win32");
  assert.equal(pc.file, "npm.cmd");
  assert.deepEqual(pc.args, ["run", '"my script"']);
  assert.equal(pc.options.shell, true);
  assert.equal(pc.options.cwd, "C:\\p");
});

test("on Windows, arguments carrying shell metacharacters are refused, never escaped", () => {
  for (const bad of ["a&calc", "x|y", "%PATH%", 'q"uote', "a\nb", "^", "<in"]) {
    assert.throws(() => platformCommand("npm", ["run", bad], {}, "win32"), /refusing/);
  }
});
