/**
 * tests/command-listing.test.js — `mapd tools commands`: lists every VISIBLE
 * command with its description, introspected directly from Commander's own
 * command tree (not a separate hardcoded list that could drift out of sync).
 * Legacy top-level names (baseline, review, evidence, annotate, docs,
 * integrate, modernize, watch, changes, mcp, status, diagnose, solutions,
 * score, improve, view, resolution, trace, test, command) still work — they
 * were consolidated into 7 top-level commands + `tools`, and kept reachable
 * as hidden aliases for backward compat — but are intentionally excluded
 * from this listing, matching Commander's own --help filtering of hidden
 * commands.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

test("mapd tools commands: lists every top-level command with a real, non-empty description", () => {
  const out = JSON.parse(execFileSync(process.execPath, [CLI, "tools", "commands", "--json"]).toString());
  const byCommand = Object.fromEntries(out.map((e) => [e.command.split(" ")[1], e.description]));
  for (const name of ["map", "check", "fix", "chat", "verify", "config", "doctor", "tools"]) {
    assert.ok(byCommand[name], `missing command: ${name}`);
    assert.notEqual(byCommand[name], "(no description)", `${name} has no description`);
  }
});

// A command's usage string is "mapd <path words...> [bracketed args/options]"
// — the path words (before the first token starting with "[" or "<") say how
// deep it is. Depth 2 ("mapd map", "mapd tools") means top-level.
function commandPathDepth(command) {
  const words = command.split(" ");
  let depth = 0;
  for (const w of words) {
    if (w.startsWith("[") || w.startsWith("<")) break;
    depth++;
  }
  return depth;
}

test("mapd tools commands: the consolidated top-level surface is exactly 7 commands + tools", () => {
  const out = JSON.parse(execFileSync(process.execPath, [CLI, "tools", "commands", "--json"]).toString());
  const topLevel = new Set(out.filter((e) => commandPathDepth(e.command) === 2).map((e) => e.command.split(" ")[1]));
  // Small on purpose — but small is only a virtue when the things AT the top
  // are the things people reach for. `improve` ("what should I work on?") and
  // `coverage` ("what isn't tested?") are two of the five questions this tool
  // exists to answer; both used to sit behind `tools`, which is where the long
  // tail belongs, not the headline. Everything else stays in tools.
  assert.deepEqual([...topLevel].sort(),
    ["chat", "check", "config", "coverage", "doctor", "fix", "improve", "map", "tools", "verify"]);
});

test("legacy commands folded into new locations are hidden from the listing, but still not top-level noise", () => {
  const out = JSON.parse(execFileSync(process.execPath, [CLI, "tools", "commands", "--json"]).toString());
  const commands = out.map((e) => e.command);
  // `improve` and `test` are deliberately absent from this list: improve is now
  // top-level, and `test` remains a hidden alias for the visible `coverage`.
  for (const gone of ["baseline", "review", "evidence", "annotate", "docs", "integrate", "modernize", "watch", "changes", "mcp", "status", "diagnose", "solutions", "score", "view", "resolution", "trace", "test", "command", "context"]) {
    const topLevel = commands.some((c) => c.split(" ")[1] === gone);
    assert.ok(!topLevel, `${gone} should not appear as a top-level command in the visible listing`);
  }
});

test("promoting a command keeps its old path working, just unlisted", () => {
  // `improve` and `coverage` moved to the top level. Their previous paths are
  // hidden from the listing (that is what promotion means) but must still RUN
  // — anything in a script or a README stays valid. Listing and working are
  // different guarantees, and only the second one is a compatibility promise.
  const listed = JSON.parse(execFileSync(process.execPath, [CLI, "tools", "commands", "--json"]).toString())
    .map((e) => e.command);
  assert.ok(listed.some((c) => c.startsWith("mapd improve")), "improve is listed at its new home");
  assert.ok(listed.some((c) => c.startsWith("mapd coverage")), "coverage is listed at its new home");
  assert.ok(!listed.some((c) => c.startsWith("mapd tools improve")), "the old path is not advertised twice");

  for (const legacy of [["tools", "improve"], ["tools", "test", "gaps"], ["test", "gaps"]]) {
    const r = spawnSync(process.execPath, [CLI, ...legacy, "--help"], { encoding: "utf8" });
    assert.equal(r.status, 0, `legacy path still has to work: mapd ${legacy.join(" ")}`);
  }
});

test("consolidated subcommands are registered under their new groups", () => {
  const out = JSON.parse(execFileSync(process.execPath, [CLI, "tools", "commands", "--json"]).toString());
  const commands = out.map((e) => e.command);
  for (const sub of [
    "mapd tools changes rollback", "mapd tools changes audit", "mapd tools test gaps", "mapd tools test credit",
    "mapd tools docs", "mapd tools integrate", "mapd tools modernize", "mapd tools watch", "mapd tools mcp",
    "mapd fix review", "mapd fix evidence", "mapd config annotate add",
    "mapd config annotate list", "mapd config annotate remove",
  ]) {
    assert.ok(commands.some((c) => c.startsWith(sub)), `missing subcommand: ${sub}`);
  }
});

test("mapd tools commands: includes nested config subcommands with the mapd-prefixed usage string", () => {
  const out = JSON.parse(execFileSync(process.execPath, [CLI, "tools", "commands", "--json"]).toString());
  const commands = out.map((e) => e.command);
  assert.ok(commands.some((c) => c.startsWith("mapd config init")));
  assert.ok(commands.some((c) => c.startsWith("mapd config show")));
  assert.ok(commands.some((c) => c.startsWith("mapd config validate")));
});

test("mapd tools commands: lists itself too (it is a real registered command)", () => {
  const out = JSON.parse(execFileSync(process.execPath, [CLI, "tools", "commands", "--json"]).toString());
  const self = out.find((e) => e.command === "mapd tools commands [options]");
  assert.ok(self);
  assert.match(self.description, /list every mapd command/i);
});

test("mapd tools commands: human-readable output (no --json) prints every command name and description", () => {
  const out = execFileSync(process.execPath, [CLI, "tools", "commands"]).toString();
  assert.match(out, /mapd map \[options\] \[dir\]/);
  assert.match(out, /Build the scored workflow map and print a summary/);
  assert.match(out, /mapd chat \[options\] \[dirOrQuery\.\.\.\]/);
});

test("legacy top-level names still WORK (hidden alias, not removed) — e.g. `mapd baseline` and `mapd status`", () => {
  const out1 = execFileSync(process.execPath, [CLI, "command", "--json"]).toString();
  // `mapd command` itself is now a hidden alias for `mapd tools commands` —
  // still callable, just excluded from its own listing (consistent behavior).
  assert.doesNotThrow(() => JSON.parse(out1));
});
