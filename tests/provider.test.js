/**
 * tests/provider.test.js — provider abstraction: nullProvider, openai-compat
 * (against a stubbed local HTTP server, no real network), and selection logic.
 * No real API credentials are used anywhere in this file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { nullProvider, openaiCompatProvider, kimiProvider, getProvider } from "../src/agents/provider.js";

test("nullProvider: unavailable, complete() resolves null — deterministic mode never blocks", async () => {
  const p = nullProvider();
  assert.equal(p.available(), false);
  assert.equal(await p.complete("sys", "user"), null);
});

test("getProvider: with no keys configured, selection falls back to nullProvider", () => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const p = getProvider({ chat: { provider: "auto" } });
  assert.equal(p.name, "none");
  assert.equal(p.available(), false);
});

test("getProvider: explicit provider name pins selection even if unavailable", () => {
  delete process.env.ANTHROPIC_API_KEY;
  const p = getProvider({ chat: { provider: "anthropic" } });
  assert.equal(p.name, "anthropic");
  assert.equal(p.available(), false);
});

test("openaiCompatProvider: completes against a stubbed local HTTP server", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      assert.equal(parsed.messages[0].role, "system");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "stubbed response" } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  process.env.OPENAI_API_KEY = "sk-test-not-real";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  try {
    const p = openaiCompatProvider({});
    assert.equal(p.available(), true);
    const out = await p.complete("system prompt", "user prompt");
    assert.equal(out, "stubbed response");
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    server.close();
  }
});

test("openaiCompatProvider: surfaces a redacted error message on a non-2xx response", async () => {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("invalid key sk-abcdefghijklmnop");
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  process.env.OPENAI_API_KEY = "sk-test-not-real";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  try {
    const p = openaiCompatProvider({});
    await assert.rejects(() => p.complete("s", "u"), (err) => {
      assert.ok(!err.message.includes("sk-abcdefghijklmnop"), "raw key must never leak into error messages");
      assert.match(err.message, /redacted/);
      return true;
    });
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    server.close();
  }
});

test("kimiProvider: completes against a stubbed local HTTP server, using KIMI_API_KEY (not OPENAI_API_KEY)", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      assert.equal(parsed.messages[0].role, "system");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "kimi stubbed response" } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  delete process.env.OPENAI_API_KEY;
  process.env.KIMI_API_KEY = "kimi-test-not-real";
  process.env.KIMI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  try {
    const p = kimiProvider({});
    assert.equal(p.name, "kimi");
    assert.equal(p.available(), true);
    const out = await p.complete("system prompt", "user prompt");
    assert.equal(out, "kimi stubbed response");
  } finally {
    delete process.env.KIMI_API_KEY;
    delete process.env.KIMI_BASE_URL;
    server.close();
  }
});

test("kimiProvider: falls back to reasoning_content when content is empty — a real bug hit against the live Kimi API (reasoning models can exhaust max_tokens on chain-of-thought before ever writing `content`)", async () => {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "", reasoning_content: "internal chain-of-thought that got cut off before a final answer" }, finish_reason: "length" }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  process.env.KIMI_API_KEY = "kimi-test-not-real";
  process.env.KIMI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  try {
    const p = kimiProvider({});
    const out = await p.complete("s", "u");
    // finish_reason "length" means this really was cut off — even after the
    // one bounded retry (this stub always returns the same truncated
    // response) — so the truncation must be disclosed, never silently
    // presented as a complete answer.
    assert.match(out, /^internal chain-of-thought that got cut off before a final answer/);
    assert.match(out, /response was truncated by the token limit/);
  } finally {
    delete process.env.KIMI_API_KEY;
    delete process.env.KIMI_BASE_URL;
    server.close();
  }
});

test("kimiProvider: real content is always preferred over reasoning_content when both are present", async () => {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: "the real answer", reasoning_content: "scratch notes" } }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  process.env.KIMI_API_KEY = "kimi-test-not-real";
  process.env.KIMI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  try {
    const p = kimiProvider({});
    assert.equal(await p.complete("s", "u"), "the real answer");
  } finally {
    delete process.env.KIMI_API_KEY;
    delete process.env.KIMI_BASE_URL;
    server.close();
  }
});

test("kimiProvider: with neither content nor reasoning_content present, returns null honestly (never fabricates text)", async () => {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: {} }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  process.env.KIMI_API_KEY = "kimi-test-not-real";
  process.env.KIMI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  try {
    const p = kimiProvider({});
    assert.equal(await p.complete("s", "u"), null);
  } finally {
    delete process.env.KIMI_API_KEY;
    delete process.env.KIMI_BASE_URL;
    server.close();
  }
});

test("kimiProvider: a real OpenAI key alone does not make Kimi available — the two never collide", () => {
  delete process.env.KIMI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-real-openai-not-real";
  try {
    assert.equal(kimiProvider({}).available(), false);
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test("kimiProvider: model is configurable via providers.kimi.model in config", () => {
  const p = kimiProvider({ providers: { kimi: { model: "kimi-custom-model" } } });
  assert.equal(p.model, "kimi-custom-model");
});

test("getProvider: auto-selection falls through to kimi when only KIMI_API_KEY is set", () => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  process.env.KIMI_API_KEY = "kimi-test-not-real";
  try {
    const p = getProvider({ chat: { provider: "auto" } });
    assert.equal(p.name, "kimi");
  } finally {
    delete process.env.KIMI_API_KEY;
  }
});

test("openaiCompatProvider: a truncated response is retried once with a larger budget, and returns cleanly if the retry completes", async () => {
  let callCount = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      callCount++;
      const { max_tokens } = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      // first call: caller's own maxTokens (small) -> truncated; retry with a
      // larger budget (whatever the provider doubled it to) -> completes
      if (max_tokens <= 100) {
        res.end(JSON.stringify({ choices: [{ message: { content: "partial" }, finish_reason: "length" }] }));
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: "complete answer" }, finish_reason: "stop" }] }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  process.env.OPENAI_API_KEY = "sk-test-not-real";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  try {
    const p = openaiCompatProvider({});
    const out = await p.complete("s", "u", 100);
    assert.equal(out, "complete answer", "must transparently retry and return the completed answer, no truncation notice");
    assert.equal(callCount, 2, "must have retried exactly once");
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    server.close();
  }
});

test("openaiCompatProvider: still truncated after the retry -> discloses it explicitly rather than returning a silently cut-off answer", async () => {
  let callCount = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      callCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "still cut off" }, finish_reason: "length" }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  process.env.OPENAI_API_KEY = "sk-test-not-real";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  try {
    const p = openaiCompatProvider({});
    const out = await p.complete("s", "u", 100);
    assert.match(out, /^still cut off/);
    assert.match(out, /truncated by the token limit even after one retry/);
    assert.equal(callCount, 2, "must retry exactly once, never loop indefinitely");
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    server.close();
  }
});

test("openaiCompatProvider: a clean, non-truncated response is never retried and never carries a disclosure", async () => {
  let callCount = 0;
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      callCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "clean answer" }, finish_reason: "stop" }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  process.env.OPENAI_API_KEY = "sk-test-not-real";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  try {
    const p = openaiCompatProvider({});
    const out = await p.complete("s", "u");
    assert.equal(out, "clean answer");
    assert.equal(callCount, 1, "a clean response must never trigger a retry");
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    server.close();
  }
});
