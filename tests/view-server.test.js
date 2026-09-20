/**
 * tests/view-server.test.js — `mapd view --serve`: a localhost server that
 * serves the view + backs an embedded READ-ONLY chat. It runs analysis/reporting
 * commands and answers, but refuses anything that writes to the project.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { startViewServer, answerReadOnly } from "../src/core/viewServer.js";
import { renderViewHtml, buildViewModel } from "../src/core/view.js";
import { createChatContext } from "../src/chat/repl.js";

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-vs-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "entry.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "entry.js"), `import { h } from "./h.js";\nexport function run(){ return h(); }\nrun();\n`);
  fs.writeFileSync(path.join(dir, "h.js"), `export function h(){ return 1; }\n`);
  return dir;
}

const post = (port, message) => new Promise((res, rej) => {
  const body = JSON.stringify({ message });
  const req = http.request({ host: "127.0.0.1", port, path: "/api/chat", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
    (r) => { let b = ""; r.on("data", (c) => b += c); r.on("end", () => res(JSON.parse(b).reply)); });
  req.on("error", rej); req.end(body);
});
const get = (port, p) => new Promise((res, rej) => { http.get({ host: "127.0.0.1", port, path: p }, (r) => { let b = ""; r.on("data", (c) => b += c); r.on("end", () => res(b)); }).on("error", rej); });

test("serve mode HTML includes the embedded chat panel; static mode does not", () => {
  const model = buildViewModel(project());
  assert.match(renderViewHtml(model, { serve: true }), /Ask Map'd/);
  assert.doesNotMatch(renderViewHtml(model), /Ask Map'd/);
});

test("answerReadOnly runs read-only commands and refuses writes/mutations", async () => {
  const ctx = createChatContext(project());
  assert.match(await answerReadOnly("what should I work on", ctx), /Improve plan/);
  assert.match(await answerReadOnly("what's the honest ceiling", ctx), /ceiling/i);
  assert.match(await answerReadOnly("fix the highest-severity finding", ctx), /disabled|terminal/i);
  assert.match(await answerReadOnly("/baseline", ctx), /disabled|writes/i);
});

test("the server serves the page and answers chat over HTTP", async () => {
  const { server, port } = await startViewServer(project(), { open: false });
  try {
    assert.match(await get(port, "/"), /Ask Map'd/);
    assert.match(await post(port, "is the project passing"), /verify|verdict/i);
    assert.match(await post(port, "fix finding abc12345"), /disabled|terminal/i);
  } finally {
    server.close();
  }
});
