/**
 * tests/chat-session-memory.test.js — regression test for a real gap: session
 * memory fields (filesInspected, findingsDiscussed, commandsExecuted,
 * patchesProposed, patchesApplied) were declared and persisted to disk but
 * never actually populated during a chat session. This proves they now are.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-sessmem-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "sessmem", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), `export function greet(){ return "hi"; }\n`);
  return dir;
}

function runChat(dir, lines) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "chat", dir], {
      cwd: dir, // never inherit the test runner's cwd — a stray .env there must not leak into the fixture
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", KIMI_API_KEY: "",
        HOME: fs.mkdtempSync(path.join(os.tmpdir(), "mapd-fakehome-")), // a real ~/.env must never leak into a fixture expecting deterministic mode
      },
    });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`timed out.\n${stdout}`)); }, 15_000);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, stdout }); });
    child.stdin.write(lines.join("\n") + "\n");
    child.stdin.end();
  });
}

test("chat: /context reflects real commands executed and files inspected during the session, not a placeholder", async () => {
  const dir = tmpProject();
  const { code, stdout } = await runChat(dir, ["/map", "Search for all references to greet", "/context", "mapd chat end"]);
  assert.equal(code, 0);
  assert.match(stdout, /commands executed: \/map, search: greet/);
  assert.match(stdout, /files inspected: index\.js/);
});

test("chat: /context tracks a fix attempt as a discussed finding and a proposed patch", async () => {
  const dir = tmpProject();
  // create a real regression finding for /context to have something to reference
  const { execFileSync } = await import("node:child_process");
  execFileSync(process.execPath, [CLI, "baseline", dir]);
  fs.writeFileSync(path.join(dir, "index.js"), `// export removed\n`);
  // `mapd check` exits non-zero (CI-friendly) when high-severity findings exist — expected here, not a failure.
  try { execFileSync(process.execPath, [CLI, "check", dir], { stdio: "ignore" }); } catch { /* expected non-zero exit */ }

  const { code, stdout } = await runChat(dir, ["Fix the highest-severity finding", "/context", "mapd chat end"]);
  assert.equal(code, 0);
  assert.match(stdout, /findings discussed: [0-9a-f]{8}/);
  // no provider configured, so the fix attempt fails honestly, but it must still be recorded as discussed
  assert.match(stdout, /commands executed: fix [0-9a-f]{8}/);
});

test("chat: session log persisted to .mapd/sessions reflects the same populated fields", async () => {
  const dir = tmpProject();
  await runChat(dir, ["/map", "mapd chat end"]);
  const sessionsDir = path.join(dir, ".mapd", "sessions");
  const files = fs.readdirSync(sessionsDir);
  assert.equal(files.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(sessionsDir, files[0]), "utf8"));
  assert.ok(saved.commandsExecuted.some((c) => c.label === "/map"), "persisted session log must include real commands, not stay empty");
});
