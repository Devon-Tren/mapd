/**
 * tests/chat-transcript.test.js — `/transcript` saves the session's prompts and
 * answers to readable Markdown.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionState, recordTurn, exportTranscriptMarkdown } from "../src/core/session.js";
import { createCommandTable } from "../src/chat/commands.js";

test("exportTranscriptMarkdown renders prompts and answers with headings", () => {
  const s = createSessionState(os.tmpdir(), "sess-test");
  recordTurn(s, "user", "what's the honest ceiling?");
  recordTurn(s, "assistant", "The ceiling is 0.9 — no git caps signalCoverage.");
  s.filesInspected.add("src/core/score.js");
  const md = exportTranscriptMarkdown(s);
  assert.match(md, /# Map'd chat transcript/);
  assert.match(md, /what's the honest ceiling/);
  assert.match(md, /The ceiling is 0\.9/);
  assert.match(md, /You/);
  assert.match(md, /Map'd/);
  assert.match(md, /src\/core\/score\.js/);
});

test("/transcript writes a Markdown file to disk", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-transcript-"));
  const session = createSessionState(dir, "sess-abc");
  recordTurn(session, "user", "run verify");
  recordTurn(session, "assistant", "verdict: PASS");
  const table = createCommandTable({ rootDir: dir, config: {}, session });
  const r = await table["/transcript"]([]);
  assert.equal(r.ok, true);
  const outPath = r.text.split("→")[1].trim();
  assert.ok(fs.existsSync(outPath), "transcript file should exist");
  assert.match(fs.readFileSync(outPath, "utf8"), /run verify/);
});

test("/transcript honors an explicit output filename", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-transcript-"));
  const session = createSessionState(dir, "sess-xyz");
  recordTurn(session, "user", "hi");
  const table = createCommandTable({ rootDir: dir, config: {}, session });
  const r = await table["/transcript"](["my-chat.md"]);
  assert.ok(fs.existsSync(path.join(dir, "my-chat.md")));
});
