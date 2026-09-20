/**
 * tests/modernize-lifecycle.test.js — modernize reports get the same
 * lifecycle merge as check reports (found via dogfooding: a stale
 * modernize-heavy.json kept 20 findings open forever because re-scans
 * overwrote the report without resolving anything). Plus the CLI's
 * positional mode: `mapd modernize heavy` / `light` / bare = medium.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { saveModernizationReport } from "../src/core/modernize.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-modlife-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), `export function main(){ return 1; }\n`);
  return dir;
}

const readReport = (dir, mode) => JSON.parse(fs.readFileSync(path.join(dir, ".mapd", `modernize-${mode}.json`), "utf8"));
const mkFinding = (rule, detail, status = "awaiting-approval") => ({ rule, detail, status, tier: "code-pattern" });

test("saveModernizationReport: an unreproduced open finding is auto-resolved with re-scan evidence", () => {
  const dir = tmpProject();
  saveModernizationReport(dir, { mode: "heavy", generatedAt: new Date().toISOString(), findings: [mkFinding("var-usage", "3 var declarations")] });
  const saved = saveModernizationReport(dir, { mode: "heavy", generatedAt: new Date().toISOString(), findings: [] });

  assert.equal(saved.resolvedNow, 1);
  const rep = readReport(dir, "heavy");
  assert.equal(rep.findings[0].status, "resolved");
  assert.equal(rep.findings[0].resolved.by, "mapd modernize heavy");
});

test("saveModernizationReport: a dismissed finding that still reproduces stays dismissed", () => {
  const dir = tmpProject();
  saveModernizationReport(dir, { mode: "medium", generatedAt: new Date().toISOString(), findings: [mkFinding("var-usage", "3 var declarations", "dismissed")] });
  saveModernizationReport(dir, { mode: "medium", generatedAt: new Date().toISOString(), findings: [mkFinding("var-usage", "3 var declarations")] });
  assert.equal(readReport(dir, "medium").findings[0].status, "dismissed");
});

test("saveModernizationReport: modes have independent lifecycles (heavy resolving does not touch medium)", () => {
  const dir = tmpProject();
  saveModernizationReport(dir, { mode: "medium", generatedAt: new Date().toISOString(), findings: [mkFinding("a", "one")] });
  saveModernizationReport(dir, { mode: "heavy", generatedAt: new Date().toISOString(), findings: [mkFinding("b", "two")] });
  saveModernizationReport(dir, { mode: "heavy", generatedAt: new Date().toISOString(), findings: [] });
  assert.equal(readReport(dir, "medium").findings[0].status, "awaiting-approval");
  assert.equal(readReport(dir, "heavy").findings[0].status, "resolved");
});

test("CLI: `mapd modernize heavy <dir>` runs heavy; bare runs medium; `light` runs light", () => {
  const dir = tmpProject();
  const run = (...args) => execFileSync(process.execPath, [CLI, "modernize", ...args, "--no-registry"], { encoding: "utf8" });
  assert.match(run("heavy", dir), /Modernization scan \(heavy\)/);
  assert.match(run(dir), /Modernization scan \(medium\)/);
  assert.match(run("light", dir), /Modernization scan \(light\)/);
});

test("CLI: an unknown positional mode and a positional/--mode conflict both fail with actionable errors", () => {
  const dir = tmpProject();
  const fails = (...args) => {
    try {
      execFileSync(process.execPath, [CLI, "modernize", ...args, "--no-registry"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return null;
    } catch (e) {
      return `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
  };
  assert.match(fails("turbo", dir), /Unknown mode 'turbo'/);
  assert.match(fails("heavy", dir, "--mode", "light"), /Conflicting modes/);
});
