/**
 * tests/fix-impact.test.js — `mapd fix --impact` previews a finding's blast
 * radius, risk, test coverage, and modeled score gain WITHOUT proposing a patch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const run = (args, cwd) => {
  try { return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { cwd }).toString() }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout ?? "").toString() }; }
};

test("fix --impact --json previews the auto-selected finding without proposing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-fiximpact-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "entry.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "entry.js"), `import { helper } from "./helper.js";\nexport function run(){ return helper(); }\nrun();\n`);
  fs.writeFileSync(path.join(dir, "helper.js"), `export function helper(){ return 1; }\nexport function extra(){ return 2; }\n`);
  run(["baseline", dir], dir);
  fs.writeFileSync(path.join(dir, "helper.js"), `export function helper(){ return 1; }\n`); // remove an export → finding
  run(["check", dir], dir);

  const { out } = run(["fix", dir, "--impact", "--json"], dir);
  const j = JSON.parse(out);
  assert.ok(j.id, "reports the finding id");
  assert.ok(["low", "medium", "high"].includes(j.risk));
  assert.ok(Array.isArray(j.files));
  assert.ok("blastRadius" in j && "modeledScoreGain" in j);
  // --impact must not create a proposal file
  const proposals = path.join(dir, ".mapd", "proposals.json");
  assert.ok(!fs.existsSync(proposals), "impact preview must not propose or persist anything");
});
