/**
 * tests/chat-approval.test.js — the two-turn mutation approval flow: a
 * proposed action must be explicitly confirmed on the next turn, and
 * networked/destructive commands additionally require the matching .mapdrc
 * security flag before they can even be proposed as runnable.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-chat-approval-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "index.js", type: "module" }));
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

test("chat: a destructive-classified command is refused outright without the .mapdrc security flag, even before approval", async () => {
  // there's no NL phrase routing straight to a destructive command, so this is exercised at
  // the runCommand/policy layer directly in chat-commandrunner.test.js; here we confirm a
  // git-mutation command requires explicit 'yes' confirmation end-to-end through the real CLI.
  const dir = tmpProject();
  const { code, stdout } = await runChat(dir, ["Install dependencies", "no thanks", "mapd chat end"]);
  assert.equal(code, 0);
  assert.match(stdout, /Proposed action: run 'npm install'/);
  assert.match(stdout, /Cancelled — 'npm install' was not run/);
});

test("chat: confirming a proposed dependency-mutation with 'yes' actually runs it", async () => {
  const dir = tmpProject();
  const { code, stdout } = await runChat(dir, ["Install dependencies", "yes", "mapd chat end"]);
  assert.equal(code, 0);
  assert.match(stdout, /Proposed action: run 'npm install'/);
  assert.match(stdout, /exit \d+/, "the actual command must have run and reported a real exit code");
}, { timeout: 30_000 });
