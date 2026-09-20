/**
 * tests/diagnose.test.js — deterministic diagnosis of Map'd's own
 * understanding limits: weak signals, runtime blind spots, and env contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildDiagnosis, renderDiagnosis } from "../src/core/diagnose.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-diagnose-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "diagnose-fixture",
    type: "module",
    main: "server.js",
    scripts: {
      start: "node server.js",
      dev: "vite --host 0.0.0.0",
      test: "node --test tests/*.test.js",
    },
  }));
  fs.writeFileSync(path.join(dir, "server.js"), `
export function start(plugins, name){
  const port = process.env.PORT;
  const token = process.env["API_TOKEN"];
  const { FEATURE_FLAG } = process.env;
  plugins[name].run();
  missingRuntimeHook();
  return [port, token, FEATURE_FLAG];
}
`);
  return dir;
}

test("buildDiagnosis: names env contract and runtime blind spots without reading secret values", () => {
  const dir = fixture();
  const data = buildDiagnosis(dir, { top: 10 });

  assert.equal(data.summary.fileCount, 1);
  assert.ok(data.env.keys.some((k) => k.key === "PORT"));
  assert.ok(data.env.keys.some((k) => k.key === "API_TOKEN"));
  assert.ok(data.env.keys.some((k) => k.key === "FEATURE_FLAG"));
  assert.equal(data.env.hasExampleFile, false);

  assert.ok(data.runtime.runtimeScripts.some((s) => s.name === "start" && s.mappedAsEntry));
  assert.ok(data.runtime.unmappedRuntimeScripts.some((s) => s.name === "dev"));
  assert.ok(!data.runtime.runtimeScripts.some((s) => s.name === "test"));
  assert.ok(data.runtime.unresolvedCalls.some((c) => c.name === "missingRuntimeHook"));
  assert.ok(data.runtime.dynamicCalls.some((c) => c.name === "plugins"));
  assert.ok(data.recommendations.some((r) => /runtime scripts/.test(r)));

  const rendered = renderDiagnosis(data);
  assert.match(rendered, /Runtime blind spots/);
  assert.match(rendered, /unmapped script "dev"/);
  assert.match(rendered, /API_TOKEN/);
  assert.doesNotMatch(rendered, /super-secret|sk-|token-value/i);
});

test("mapd diagnose: prints structured JSON for agents and rendered text for humans", () => {
  const dir = fixture();
  const json = JSON.parse(execFileSync(process.execPath, [CLI, "diagnose", dir, "--json"]).toString());
  assert.equal(json.root, dir);
  assert.ok(json.runtime.unmappedRuntimeScripts.some((s) => s.name === "dev"));

  const text = execFileSync(process.execPath, [CLI, "diagnose", dir]).toString();
  assert.match(text, /Map'd diagnosis/);
  assert.match(text, /Next actions/);
});
