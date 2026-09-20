/**
 * tests/chat-grounded-qa.test.js — regression test for a real gap: the
 * grounded Q&A system prompt claimed findings and "the recent conversation"
 * were included in context, but the code never actually fed them in. This
 * proves the prompt now matches reality — a stub provider echoes back
 * whatever context it received so we can inspect it directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-groundedqa-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "groundedqa", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), `export function greet(){ return "hi"; }\nexport function farewell(){ return "bye"; }\n`);
  return dir;
}

/** A stub OpenAI-compatible server that echoes back the received user-content verbatim, so tests can inspect exactly what context reached the "model." */
function startEchoStubProvider() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const userMsg = parsed.messages.find((m) => m.role === "user")?.content ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: userMsg } }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

function runChat(dir, lines, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "chat", dir], {
      cwd: dir, // never inherit the test runner's cwd — a stray .env there must not leak into the fixture
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env, ANTHROPIC_API_KEY: "", KIMI_API_KEY: "",
        HOME: fs.mkdtempSync(path.join(os.tmpdir(), "mapd-fakehome-")), // a real ~/.env must never leak into a fixture expecting deterministic mode
        ...env,
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

test("chat Q&A: an open finding actually reaches the provider's context (not just claimed in the system prompt)", async () => {
  const dir = tmpProject();
  // create a real regression finding
  const { execFileSync } = await import("node:child_process");
  execFileSync(process.execPath, [CLI, "baseline", dir]);
  fs.writeFileSync(path.join(dir, "index.js"), `export function greet(){ return "hi"; }\n`); // drops farewell
  try { execFileSync(process.execPath, [CLI, "check", dir], { stdio: "ignore" }); } catch { /* expected non-zero exit on high-severity finding */ }

  const server = await startEchoStubProvider();
  const { port } = server.address();
  try {
    const { code, stdout } = await runChat(
      dir,
      ["Which findings are the highest risk?", "mapd chat end"],
      { OPENAI_API_KEY: "sk-test-not-real", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` },
    );
    assert.equal(code, 0);
    assert.match(stdout, /export-removed/, "the actual finding kind must appear in what the provider received");
    assert.match(stdout, /Open findings awaiting approval/);
    assert.match(stdout, /"evidence"/, "the provider should receive finding evidence, not just the queue row");
  } finally {
    server.close();
  }
});

test("chat Q&A: a baseline regression diff reaches the provider's context", async () => {
  const dir = tmpProject();
  const { execFileSync } = await import("node:child_process");
  execFileSync(process.execPath, [CLI, "baseline", dir]);
  fs.writeFileSync(path.join(dir, "index.js"), `export function greet(){ return "hi"; }\n`);

  const server = await startEchoStubProvider();
  const { port } = server.address();
  try {
    // A genuine open question (not one that maps to a command like /score delta)
    // so it reaches grounded Q&A, where the baseline diff must be in context.
    const { code, stdout } = await runChat(
      dir,
      ["Give me your read on the recent changes here.", "mapd chat end"],
      { OPENAI_API_KEY: "sk-test-not-real", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` },
    );
    assert.equal(code, 0);
    assert.match(stdout, /Regressions\/changes vs baseline/);
  } finally {
    server.close();
  }
});

test("chat Q&A: prior conversation turns actually reach the provider on a follow-up question", async () => {
  const dir = tmpProject();
  const server = await startEchoStubProvider();
  const { port } = server.address();
  try {
    const { code, stdout } = await runChat(
      dir,
      ["What does this project do?", "And what about the farewell function specifically?", "mapd chat end"],
      { OPENAI_API_KEY: "sk-test-not-real", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` },
    );
    assert.equal(code, 0);
    assert.match(stdout, /Recent conversation/);
    assert.match(stdout, /What does this project do\?/, "the earlier turn's question text must appear in the follow-up's context");
  } finally {
    server.close();
  }
});

test("chat Q&A: a fabricated file mention in the model's answer is mechanically caught and disclosed, not silently trusted", async () => {
  const dir = tmpProject();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: "The real logic actually lives in src/auth/session-manager.js, which handles all login flows." } }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const { code, stdout } = await runChat(
      dir, ["where does the auth logic live?", "mapd chat end"],
      { OPENAI_API_KEY: "sk-test-not-real", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` },
    );
    assert.equal(code, 0);
    assert.match(stdout, /src\/auth\/session-manager\.js/, "the fabricated claim must still be shown");
    assert.match(stdout, /not found in this project's real data/, "but flagged as unverified against the real file list");
  } finally {
    server.close();
  }
});

test("chat Q&A: an answer citing only real files never carries the grounding warning", async () => {
  const dir = tmpProject();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "Both greet and farewell are defined in index.js." } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const { code, stdout } = await runChat(
      dir, ["what functions does this project define?", "mapd chat end"],
      { OPENAI_API_KEY: "sk-test-not-real", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` },
    );
    assert.equal(code, 0);
    assert.doesNotMatch(stdout, /not found in this project's real data/, "a fully-grounded answer must never carry the warning");
  } finally {
    server.close();
  }
});

test("chat Q&A: package.json is valid project metadata, not a fabricated file warning", async () => {
  const dir = tmpProject();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "package.json declares index.js as the main entry." } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const { code, stdout } = await runChat(
      dir, ["what is the package entry?", "mapd chat end"],
      { OPENAI_API_KEY: "sk-test-not-real", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` },
    );
    assert.equal(code, 0);
    assert.match(stdout, /package\.json/);
    assert.doesNotMatch(stdout, /not found in this project's real data/);
  } finally {
    server.close();
  }
});
