/**
 * tests/llm-intent.test.js — unit tests for the tier-2 LLM-assisted intent
 * classifier (src/chat/llmIntent.js). Uses fake in-process provider objects,
 * no network/subprocess — this is purely about the parsing/validation
 * contract: fail safe to "qa" on anything malformed, ambiguous, or outside
 * the fixed read-only command vocabulary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyIntentWithProvider, READ_ONLY_COMMANDS } from "../src/chat/llmIntent.js";

function fakeProvider(response) {
  return {
    available: () => true,
    complete: async () => response,
  };
}

test("llmIntent: recognizes a compound multi-command request", async () => {
  const provider = fakeProvider(JSON.stringify({ intent: "command", commands: ["/map", "/modernize", "/check"] }));
  const result = await classifyIntentWithProvider("run three commands map, modernize, and check for errors", provider);
  assert.deepEqual(result, { type: "sequence", commands: ["/map", "/modernize", "/check"] });
});

test("llmIntent: falls back to qa when the model says qa", async () => {
  const provider = fakeProvider(JSON.stringify({ intent: "qa" }));
  const result = await classifyIntentWithProvider("what does the confidence score mean?", provider);
  assert.deepEqual(result, { type: "qa" });
});

test("llmIntent: no provider configured -> qa without calling complete", async () => {
  const result = await classifyIntentWithProvider("run map", { available: () => false });
  assert.deepEqual(result, { type: "qa" });
});

test("llmIntent: unparsable response fails safe to qa", async () => {
  const provider = fakeProvider("not json at all");
  const result = await classifyIntentWithProvider("run map and modernize", provider);
  assert.deepEqual(result, { type: "qa" });
});

test("llmIntent: null/empty response fails safe to qa", async () => {
  const provider = fakeProvider(null);
  const result = await classifyIntentWithProvider("run map", provider);
  assert.deepEqual(result, { type: "qa" });
});

test("llmIntent: a thrown error from provider.complete fails safe to qa", async () => {
  const provider = { available: () => true, complete: async () => { throw new Error("network down"); } };
  const result = await classifyIntentWithProvider("run map", provider);
  assert.deepEqual(result, { type: "qa" });
});

test("llmIntent: commands outside the fixed vocabulary are silently dropped, never executed", async () => {
  const provider = fakeProvider(JSON.stringify({ intent: "command", commands: ["/fix", "/map", "rm -rf /"] }));
  const result = await classifyIntentWithProvider("fix everything and run map", provider);
  assert.deepEqual(result, { type: "sequence", commands: ["/map"] });
  for (const c of result.commands) assert.ok(READ_ONLY_COMMANDS.includes(c));
});

test("llmIntent: an all-disallowed command list falls back to qa (never an empty sequence)", async () => {
  const provider = fakeProvider(JSON.stringify({ intent: "command", commands: ["/fix", "/approve"] }));
  const result = await classifyIntentWithProvider("approve everything", provider);
  assert.deepEqual(result, { type: "qa" });
});

test("llmIntent: intent field anything other than 'command' is qa, even with a commands array present", async () => {
  const provider = fakeProvider(JSON.stringify({ intent: "maybe", commands: ["/map"] }));
  const result = await classifyIntentWithProvider("hmm", provider);
  assert.deepEqual(result, { type: "qa" });
});

test("llmIntent: duplicate commands in the response are deduplicated", async () => {
  const provider = fakeProvider(JSON.stringify({ intent: "command", commands: ["/map", "/map", "/check"] }));
  const result = await classifyIntentWithProvider("run map twice and check", provider);
  assert.deepEqual(result, { type: "sequence", commands: ["/map", "/check"] });
});

// ---- referential follow-ups ("run those commands"), resolved via conversation context ----

test("llmIntent: a referential follow-up passes conversation context to the provider so it can resolve 'those'", async () => {
  let capturedUser = null;
  const provider = {
    available: () => true,
    complete: async (system, user) => {
      capturedUser = user;
      return JSON.stringify({ intent: "command", commands: ["/map", "/modernize"] });
    },
  };
  const conversationContext = "assistant: You could run /map and /modernize to get a full picture.";
  const result = await classifyIntentWithProvider("run those commands", provider, conversationContext);
  assert.deepEqual(result, { type: "sequence", commands: ["/map", "/modernize"] });
  assert.match(capturedUser, /Recent conversation/);
  assert.match(capturedUser, /run those commands/);
});

test("llmIntent: no conversation context provided -> the user message is sent unmodified (unchanged behavior)", async () => {
  let capturedUser = null;
  const provider = {
    available: () => true,
    complete: async (system, user) => { capturedUser = user; return JSON.stringify({ intent: "qa" }); },
  };
  await classifyIntentWithProvider("run those commands", provider);
  assert.equal(capturedUser, "run those commands");
});

test("llmIntent: a referential follow-up with no resolvable prior commands still fails safe to qa", async () => {
  const provider = fakeProvider(JSON.stringify({ intent: "qa" }));
  const result = await classifyIntentWithProvider("run those commands", provider, "assistant: I'm not sure what you mean.");
  assert.deepEqual(result, { type: "qa" });
});
