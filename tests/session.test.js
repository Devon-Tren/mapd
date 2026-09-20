/**
 * tests/session.test.js — chat session memory: turn log persistence,
 * deterministic summarization, and context budgeting/dedup/ranking.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSessionState, recordTurn, persistSession,
  summarizeConversation, buildContextBudget,
} from "../src/core/session.js";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapd-sess-"));
}

test("recordTurn + persistSession: writes an append-only session log to .mapd/sessions", () => {
  const dir = tmpProject();
  const state = createSessionState(dir);
  recordTurn(state, "user", "What does this project do?");
  recordTurn(state, "assistant", "It's a workflow mapper.");
  persistSession(state);

  const file = path.join(dir, ".mapd", "sessions", `${state.id}.json`);
  assert.ok(fs.existsSync(file));
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.turns.length, 2);
  assert.equal(saved.turns[0].role, "user");
});

test("summarizeConversation: short histories are kept verbatim", () => {
  const turns = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
  const summary = summarizeConversation(turns, { keepLast: 6 });
  assert.equal(summary, "user: hi\nassistant: hello");
});

test("summarizeConversation: long histories compress older turns but keep recent ones verbatim", () => {
  const turns = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `message number ${i} with some extra padding text` }));
  const summary = summarizeConversation(turns, { keepLast: 4, maxChars: 10_000 });
  assert.match(summary, /16 earlier turn\(s\) summarized/);
  assert.match(summary, /message number 19/, "most recent turn must be present verbatim");
});

test("buildContextBudget: deduplicates identical items and ranks by priority", () => {
  const items = [
    { text: "low priority item", priority: 1 },
    { text: "high priority item", priority: 10 },
    { text: "low priority item", priority: 1 }, // duplicate
  ];
  const { included } = buildContextBudget(items, 1000);
  assert.equal(included.length, 2);
  assert.equal(included[0].text, "high priority item");
});

test("buildContextBudget: truncates to fit the character budget and reports what was omitted", () => {
  const items = [
    { text: "a".repeat(50), priority: 10 },
    { text: "b".repeat(50), priority: 5 },
    { text: "c".repeat(50), priority: 1 },
  ];
  const { included, omittedCount, usedChars } = buildContextBudget(items, 70);
  assert.equal(usedChars, 70);
  assert.equal(included[0].text.length, 50);
  assert.equal(included[1].truncated, true);
  assert.equal(included[1].text.length, 20);
  assert.equal(omittedCount, 1);
});
