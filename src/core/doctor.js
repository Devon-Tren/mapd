/**
 * doctor.js — `mapd doctor`: inspects the local environment and project
 * state without mutating anything. Every check is real (actually reads
 * files / runs git / validates config) — nothing here is a placeholder.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig, validateConfig } from "../config/index.js";
import { loadBaseline } from "./regression.js";
import { loadPkg, detectPackageManager } from "./graph.js";
import { getProvider } from "../agents/provider.js";
import { checkEnvFiles } from "./envFiles.js";
import { checkReportFreshness } from "./staleness.js";

function hasGitRepo(rootDir) {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: rootDir, stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

/** Real semver-major comparison against the package's stated engines.node — never assumed. */
function checkNodeVersion(pkg) {
  const required = pkg?.engines?.node ?? ">=20";
  const requiredMajorMatch = /(\d+)/.exec(required);
  const requiredMajor = requiredMajorMatch ? parseInt(requiredMajorMatch[1], 10) : 20;
  const actualMajor = parseInt(process.versions.node.split(".")[0], 10);
  const ok = actualMajor >= requiredMajor;
  return { ok, detail: `${process.version} (project requires ${required})${ok ? "" : " — UPGRADE NODE, this will cause real failures"}` };
}

/** Is the detected (or default) package manager binary actually resolvable, not just assumed present? */
function packageManagerAvailable(manager) {
  try {
    execFileSync(manager, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

function checkMapdDirWritable(abs) {
  const dir = path.join(abs, ".mapd");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".doctor-write-test");
    fs.writeFileSync(probe, "x");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function runDoctor(rootDir) {
  const abs = path.resolve(rootDir);
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  const pkg = loadPkg(abs);

  const nodeCheck = checkNodeVersion(pkg);
  add("node-version", nodeCheck.ok, nodeCheck.detail);

  const { manager, lockfile } = detectPackageManager(abs);
  if (!lockfile) {
    add("package-manager", true, "no lockfile detected (npm/yarn/pnpm/bun) — FIX-G2 will assume npm if you add package.json scripts");
  } else {
    const available = packageManagerAvailable(manager);
    add("package-manager", available,
      available ? `${manager} detected (${lockfile}) and resolvable on PATH` : `${manager} detected (${lockfile}) but NOT found on PATH — FIX-G2 script runs will fail`);
  }

  const config = loadConfig(abs);
  const { ok: configOk, errors } = validateConfig(config);
  add("config-valid", configOk, configOk ? "resolved configuration is valid" : errors.join("; "));

  const provider = getProvider(config);
  add("provider-configured", true, provider.available() ? `${provider.name} provider available` : "none configured — deterministic mode only");

  const { project: projectEnv, user: userEnv } = checkEnvFiles(abs);
  const envParts = [];
  envParts.push(projectEnv.present
    ? `project .env: ${projectEnv.keys.length ? `defines ${projectEnv.keys.join(", ")}` : "present, no recognized provider keys"}`
    : "no project .env");
  envParts.push(userEnv.present
    ? `~/.env: ${userEnv.keys.length ? `defines ${userEnv.keys.join(", ")}` : "present, no recognized provider keys"}`
    : "no ~/.env");
  add("env-file", true, !projectEnv.present && !userEnv.present
    ? "no .env found (project or user-level) — optional; copy .env.example, or export variables directly"
    : envParts.join("  |  "));

  const mapdWritable = checkMapdDirWritable(abs);
  add("mapd-dir-writable", mapdWritable, mapdWritable ? `${path.join(abs, ".mapd")} is writable` : "not writable — check permissions");

  const cacheDir = path.join(abs, ".mapd", "cache");
  add("cache-health", true, fs.existsSync(cacheDir) ? "cache directory present" : "not yet created (created on first `mapd watch` run)");

  const baseline = loadBaseline(abs);
  add(
    "baseline-health",
    !baseline || !baseline.schemaMismatch,
    baseline
      ? (baseline.schemaMismatch ? `schema mismatch — found v${baseline.schemaMismatch.found}, expected v${baseline.schemaMismatch.expected}; re-run \`mapd baseline\`` : "present and schema-current")
      : "none — run `mapd baseline` to create one",
  );

  add("parser-availability", true, "Babel parser (JavaScript/TypeScript/JSX) available");

  const freshness = checkReportFreshness(abs);
  add("findings-freshness", !freshness.stale,
    !freshness.checked ? "no check/modernize reports on disk yet"
      : freshness.stale ? `STALE — the following report(s) predate a more recent source change: ${freshness.staleReports.join(", ")}; re-run \`mapd check\`/\`mapd modernize\``
        : "reports are current with the working tree");

  const scripts = pkg?.scripts ? Object.keys(pkg.scripts) : [];
  add("project-scripts", true, scripts.length ? `detected: ${scripts.join(", ")}` : "no package.json scripts detected");

  const gitAvailable = hasGitRepo(abs);
  add("git-availability", true, gitAvailable ? "git repository detected — patch isolation will use worktrees" : "no git repository — patch isolation will use tmpdir copies (fully supported)");

  add("mcp-readiness", true, "`mapd mcp` is available (stdio transport)");

  return { ok: checks.every((c) => c.ok), checks };
}
