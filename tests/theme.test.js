/**
 * tests/theme.test.js — terminal color helpers: must degrade to plain text
 * when NO_COLOR is set or output isn't a TTY (never pollute --json/piped
 * output with escape codes), and the list-wrapping helper must actually wrap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

test("theme: colors are disabled when NO_COLOR is set, even if FORCE_COLOR-like conditions might otherwise apply", async () => {
  process.env.NO_COLOR = "1";
  delete process.env.FORCE_COLOR;
  const { green } = await import(`../src/core/theme.js?t=${Date.now()}`);
  assert.equal(green("OK"), "OK");
  delete process.env.NO_COLOR;
});

test("theme: FORCE_COLOR enables color even without a TTY", async () => {
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = "1";
  const { green } = await import(`../src/core/theme.js?t=${Date.now()}`);
  assert.match(green("OK"), /\x1b\[32mOK\x1b\[0m/);
  delete process.env.FORCE_COLOR;
});

test("wrapList: short lists fit on one line", async () => {
  const { wrapList } = await import("../src/core/theme.js");
  assert.equal(wrapList(["a", "b", "c"]), "a, b, c");
});

test("wrapList: long lists wrap onto multiple indented lines instead of one giant unreadable line", async () => {
  const { wrapList } = await import("../src/core/theme.js");
  const items = Array.from({ length: 30 }, (_, i) => `script-name-number-${i}`);
  const out = wrapList(items, { width: 60 });
  const lines = out.split("\n");
  assert.ok(lines.length > 1, "must actually wrap onto more than one line");
  for (const line of lines.slice(1)) assert.ok(line.startsWith("    "), "continuation lines must be indented");
  // every item must still be present — wrapping must never drop information
  for (const item of items) assert.ok(out.includes(item));
});

test("wrapList: empty list returns an empty string", async () => {
  const { wrapList } = await import("../src/core/theme.js");
  assert.equal(wrapList([]), "");
});
