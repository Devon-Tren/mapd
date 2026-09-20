/**
 * anthropicClient.js - shared lazy Anthropic SDK client loader.
 *
 * Kept tiny on purpose: provider.js and llm.js both need the same
 * env-gated, cached dynamic import, but neither should know about the
 * other's higher-level provider/completion contract.
 */

export function createAnthropicClientLoader({ apiKeyEnv = "ANTHROPIC_API_KEY" } = {}) {
  let cached = null;
  return async function anthropicClient() {
    if (!process.env[apiKeyEnv]) return null;
    if (cached) return cached;
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    cached = new Anthropic();
    return cached;
  };
}
