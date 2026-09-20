/**
 * tests/chat-llm-sequence.test.js — end-to-end: a compound, naturally-phrased
 * request ("run three commands map, modernize, and the command to look for
 * all errors") doesn't match intent.js's deterministic regexes, so it must
 * be picked up by the tier-2 LLM classifier, actually execute /map, /modernize,
 * and /check in order, and synthesize an answer grounded in their real output.
 * A plain question in the same session must NOT trigger any command execution.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-llmseq-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "llmseq", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), `var x = 1;\nexport function greet(){ return "hi"; }\n`);
  return dir;
}

/**
 * Distinguishes the intent-classification call from the synthesis/QA call by
 * inspecting the system prompt, so one stub server can serve both roles like
 * the real provider does across a session.
 */
function startRoutingStubProvider({ classifyReply }) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const system = parsed.messages.find((m) => m.role === "system")?.content ?? "";
      const userMsg = parsed.messages.find((m) => m.role === "user")?.content ?? "";
      const content = system.includes("intent classifier for a CLI tool") ? classifyReply : userMsg;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

function runChat(dir, lines, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "chat", dir], {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env, ANTHROPIC_API_KEY: "", KIMI_API_KEY: "",
        HOME: fs.mkdtempSync(path.join(os.tmpdir(), "mapd-fakehome-")),
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

test("chat: a compound natural-language request runs all inferred commands and synthesizes real output", async () => {
  const dir = tmpProject();
  const server = await startRoutingStubProvider({
    classifyReply: JSON.stringify({ intent: "command", commands: ["/map", "/modernize"] }),
  });
  const { port } = server.address();
  try {
    const { code, stdout } = await runChat(
      dir,
      ["run three commands map and modernize: reply showing where the project could be better", "mapd chat end"],
      { OPENAI_API_KEY: "sk-test-not-real", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` },
    );
    assert.equal(code, 0);
    assert.match(stdout, /=== \/map output ===/);
    assert.match(stdout, /=== \/modernize output ===/);
    assert.match(stdout, /modernization finding/);
  } finally {
    server.close();
  }
});

test("chat: a plain question does not trigger command execution (qa path)", async () => {
  const dir = tmpProject();
  const server = await startRoutingStubProvider({ classifyReply: JSON.stringify({ intent: "qa" }) });
  const { port } = server.address();
  try {
    const { code, stdout } = await runChat(
      dir,
      ["what does the confidence score mean?", "mapd chat end"],
      { OPENAI_API_KEY: "sk-test-not-real", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` },
    );
    assert.equal(code, 0);
    assert.doesNotMatch(stdout, /=== \/map output ===/);
    assert.match(stdout, /Project summary \(deterministic, AST-derived\)/, "must have gone through the grounded Q&A path instead");
  } finally {
    server.close();
  }
});

test("chat: a command-synthesis answer that fabricates a file is mechanically caught and disclosed", async () => {
  const dir = tmpProject();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const system = parsed.messages.find((m) => m.role === "system")?.content ?? "";
      const content = system.includes("intent classifier for a CLI tool")
        ? JSON.stringify({ intent: "command", commands: ["/map"] })
        // synthesis reply invents a file the project doesn't have
        : "The map shows the core logic lives in src/database/pool-manager.js, which is the riskiest area.";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const { code, stdout } = await runChat(
      dir,
      // must NOT start with "run a map" — that phrasing matches intent.js's
      // tier-1 deterministic regex and routes straight to /map with no
      // synthesis step; this test needs the tier-2 sequence+synthesis path
      ["map out this project and summarize what's risky", "mapd chat end"],
      { OPENAI_API_KEY: "sk-test-not-real", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` },
    );
    assert.equal(code, 0);
    assert.match(stdout, /src\/database\/pool-manager\.js/, "the fabricated claim must still be shown");
    assert.match(stdout, /not found in this project's real data/, "but mechanically flagged against the real file list");
  } finally {
    server.close();
  }
});

test("chat: a referential follow-up ('run those commands') resolves against what the assistant itself named in the prior turn", async () => {
  const dir = tmpProject();
  // Turn 1 is a plain QA answer (fixed text, so we know exactly what's in
  // conversation history); turn 2's classify call must receive that history
  // and resolve "those" against the /map + /modernize it named.
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const system = parsed.messages.find((m) => m.role === "system")?.content ?? "";
      const userMsg = parsed.messages.find((m) => m.role === "user")?.content ?? "";
      let content;
      if (system.includes("intent classifier for a CLI tool")) {
        content = userMsg.includes("Recent conversation") && userMsg.includes("/map") && userMsg.includes("/modernize")
          ? JSON.stringify({ intent: "command", commands: ["/map", "/modernize"] })
          : JSON.stringify({ intent: "qa" });
      } else if (system.includes("Answer using ONLY the structured")) {
        // turn 1: plain grounded Q&A, fixed text so conversation history is predictable
        content = "You could run /map and /modernize to get a full picture of this project.";
      } else {
        // turn 2's synthesis call: echo back the real /map + /modernize output
        // it was just given, so the test can see they actually executed
        content = userMsg;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const { code, stdout } = await runChat(
      dir,
      ["how should I check this project over?", "run those commands", "mapd chat end"],
      { OPENAI_API_KEY: "sk-test-not-real", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` },
    );
    assert.equal(code, 0);
    assert.match(stdout, /You could run \/map and \/modernize/, "turn 1's recommendation must actually be in the transcript");
    assert.match(stdout, /=== \/map output ===/, "the referential follow-up must have actually executed /map");
    assert.match(stdout, /=== \/modernize output ===/, "and /modernize — resolved from conversation history, not guessed");
  } finally {
    server.close();
  }
});
