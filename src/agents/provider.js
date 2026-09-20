/**
 * provider.js — LLM provider abstraction. The rest of Map'd depends on this
 * interface, never on a vendor SDK type directly.
 *
 * `getProvider(config)` -> { name, model, available(), complete(system, user, maxTokens) }
 *
 * Implementations:
 *   - anthropicProvider    — reuses @anthropic-ai/sdk (already a dependency)
 *   - openaiCompatProvider — plain global fetch (Node 20+), no new SDK dependency
 *   - kimiProvider         — Moonshot AI's Kimi models, over the same
 *                            OpenAI-compatible chat/completions shape, its own
 *                            KIMI_API_KEY/KIMI_BASE_URL so it never collides
 *                            with a real OpenAI key in the same environment
 *   - nullProvider         — deterministic-only: available() is false, complete()
 *                            resolves null. This is what keeps chat/fix/mcp fully
 *                            functional with zero API key configured.
 *
 * Never persists credentials: API keys are read from process.env only, never
 * written to .mapdrc, config-state.json, or any audit record.
 */

import { createAnthropicClientLoader } from "./anthropicClient.js";

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
// Moonshot renames/adds Kimi model identifiers over time — verify the current
// one at https://platform.moonshot.ai/docs before relying on this default;
// override via .mapdrc `providers.kimi.model` at any time. (Confirmed present
// in Moonshot's own "Models and Pricing" listing as of this writing.)
const DEFAULT_KIMI_MODEL = "kimi-k2.6";

function redactForError(message) {
  return String(message ?? "")
    .replace(/sk-[A-Za-z0-9-_]{10,}/g, "sk-***redacted***")
    .replace(/\bBearer\s+[A-Za-z0-9-_.]{10,}/gi, "Bearer ***redacted***");
}

async function responseTextOrEmpty(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Shared client for any OpenAI-compatible chat/completions endpoint —
 * openaiCompatProvider and kimiProvider both delegate here so the fetch/
 * error-handling logic exists exactly once.
 */
const TRUNCATION_RETRY_CAP_TOKENS = 8000;
const TRUNCATION_NOTICE = "\n\n[⚠ response was truncated by the token limit even after one retry — this answer may be incomplete]";

function createOpenAiCompatibleProvider({ name, model, apiKeyEnv, baseUrl }) {
  async function callOnce({ apiKey, system, user, maxTokens, signal }) {
    let res;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        }),
        signal,
      });
    } catch (e) {
      throw new Error(`${name} provider network error: ${redactForError(e.message)}`);
    }
    if (!res.ok) {
      const body = await responseTextOrEmpty(res);
      throw new Error(`${name} provider error: HTTP ${res.status} ${redactForError(body).slice(0, 500)}`);
    }
    const json = await res.json();
    const choice = json.choices?.[0];
    const message = choice?.message;
    const content = message?.content?.trim();
    // Reasoning models (Kimi K2, and others behind this same OpenAI-compatible
    // shape) return chain-of-thought in `reasoning_content` separately from
    // the final answer in `content`. On a long/complex prompt the model can
    // spend its whole max_tokens budget reasoning and never reach `content`,
    // leaving it empty — falling back to reasoning_content surfaces *something*
    // real rather than nothing; it's the model's own scratchpad, not a
    // polished answer, so callers should treat it as a lower-confidence result.
    const reasoning = message?.reasoning_content?.trim();
    return { text: content || reasoning || null, truncated: choice?.finish_reason === "length" };
  }

  return {
    name,
    model,
    available: () => !!process.env[apiKeyEnv],
    async complete(system, user, maxTokens = 1500, { signal } = {}) {
      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) return null;
      let result = await callOnce({ apiKey, system, user, maxTokens, signal });
      // A response cut off mid-answer (finish_reason "length") is worse than
      // no answer — it can leave an incomplete claim looking finished, or (on
      // a reasoning model) leak unfinished chain-of-thought as if it were the
      // polished answer. One bounded retry with a larger budget resolves this
      // in most cases without unbounded cost/latency; if it's still truncated
      // after that, disclose it explicitly rather than silently returning a
      // cut-off answer as if it were complete.
      if (result.truncated && maxTokens < TRUNCATION_RETRY_CAP_TOKENS) {
        result = await callOnce({ apiKey, system, user, maxTokens: Math.min(maxTokens * 2, TRUNCATION_RETRY_CAP_TOKENS), signal });
      }
      if (!result.text) return null;
      return result.truncated ? `${result.text}${TRUNCATION_NOTICE}` : result.text;
    },
  };
}

export function anthropicProvider(config = {}) {
  const model = process.env.MAPD_MODEL || config.providers?.anthropic?.model || DEFAULT_ANTHROPIC_MODEL;
  const client = createAnthropicClientLoader();
  async function callOnce(c, { system, user, maxTokens, signal }) {
    const msg = await c.messages.create(
      { model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] },
      { signal },
    );
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    return { text: text || null, truncated: msg.stop_reason === "max_tokens" };
  }

  return {
    name: "anthropic",
    model,
    available: () => !!process.env.ANTHROPIC_API_KEY,
    async complete(system, user, maxTokens = 1500, { signal } = {}) {
      const c = await client();
      if (!c) return null;
      try {
        let result = await callOnce(c, { system, user, maxTokens, signal });
        // Same bounded-retry-then-disclose policy as the OpenAI-compatible
        // providers: a response cut off mid-answer must never be presented as
        // if it were complete.
        if (result.truncated && maxTokens < TRUNCATION_RETRY_CAP_TOKENS) {
          result = await callOnce(c, { system, user, maxTokens: Math.min(maxTokens * 2, TRUNCATION_RETRY_CAP_TOKENS), signal });
        }
        if (!result.text) return null;
        return result.truncated ? `${result.text}${TRUNCATION_NOTICE}` : result.text;
      } catch (e) {
        throw new Error(`anthropic provider error: ${redactForError(e.message)}`);
      }
    },
  };
}

export function openaiCompatProvider(config = {}) {
  return createOpenAiCompatibleProvider({
    name: "openai",
    model: config.providers?.openai?.model || DEFAULT_OPENAI_MODEL,
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  });
}

/**
 * Moonshot AI's Kimi models — an OpenAI-compatible chat/completions API, so
 * this reuses the same shared client as openaiCompatProvider. Uses its own
 * KIMI_API_KEY (not OPENAI_API_KEY) so a Kimi key and a real OpenAI key can
 * both be configured in the same environment without colliding. KIMI_BASE_URL
 * defaults to the global endpoint; override it for the China region
 * (https://api.moonshot.cn/v1) if that's where your account is registered.
 */
export function kimiProvider(config = {}) {
  return createOpenAiCompatibleProvider({
    name: "kimi",
    model: config.providers?.kimi?.model || DEFAULT_KIMI_MODEL,
    apiKeyEnv: "KIMI_API_KEY",
    baseUrl: process.env.KIMI_BASE_URL || "https://api.moonshot.ai/v1",
  });
}

export function nullProvider() {
  return {
    name: "none",
    model: null,
    available: () => false,
    async complete() { return null; },
  };
}

/**
 * Select a provider from config: "auto" tries anthropic, then openai, then
 * kimi, then null; an explicit name pins to that provider (falling back to
 * null if unavailable).
 */
export function getProvider(config = {}) {
  const requested = config.chat?.provider ?? "auto";
  const candidates = {
    anthropic: anthropicProvider(config),
    openai: openaiCompatProvider(config),
    kimi: kimiProvider(config),
    none: nullProvider(),
  };
  if (requested !== "auto") return candidates[requested] ?? nullProvider();
  if (candidates.anthropic.available()) return candidates.anthropic;
  if (candidates.openai.available()) return candidates.openai;
  if (candidates.kimi.available()) return candidates.kimi;
  return candidates.none;
}
