/**
 * config/schema.js — the .mapdrc shape and defaults.
 *
 * Format: JSONC-lite. Plain JSON with `//` and `/* *\/` comments stripped
 * before JSON.parse (see index.js). Chosen over YAML to avoid adding a new
 * dependency; every field below maps 1:1 onto the project's documented
 * configuration surface.
 */

export const DEFAULTS = Object.freeze({
  project: {
    root: ".",
    include: [],
    exclude: ["node_modules/**", "dist/**", "build/**", "coverage/**", "eval/results/**", ".next/**", ".git/**"],
    // User-asserted classifications for things static analysis structurally
    // cannot know: glob pattern -> "generated" | "dynamically-loaded".
    // e.g. { "eval/results/**": "generated", "electron/tools/**": "dynamically-loaded" }
    // Output always labels these as user-asserted, never as detected.
    annotations: {},
  },
  mapping: {
    confidenceThreshold: 0.8,
    orphanThreshold: 0.5,
    maxFileSizeBytes: 1_000_000,
    cache: true,
    // Heuristic mapping of non-JS/TS languages (Python/Go/Rust/Ruby/Java/PHP)
    // — see core/polyglot.js. Set false to tell Map'd to stop mapping those
    // languages entirely; they revert to the honest "unsupported" bucket.
    polyglot: true,
  },
  chat: {
    provider: "auto",
    model: "auto",
    autoRunReadOnly: true,
    requireApprovalForWrites: true,
    allowShell: false,
    maxContextTokens: 30_000,
    maxCommandOutputCharacters: 30_000,
  },
  fix: {
    maxAttempts: 2,
    requireApproval: true,
    allowedPaths: [],
    forbiddenPaths: [".env", ".env.*", "secrets/**"],
    runTests: true,
    runTypecheck: true,
    runLint: true,
  },
  mcp: {
    enabled: true,
    transport: "stdio",
  },
  security: {
    allowNetworkCommands: false,
    allowDestructiveCommands: false,
    allowedCommands: [],
    deniedCommands: [],
  },
  providers: {
    anthropic: { model: "" },
    openai: { model: "" },
    kimi: { model: "" },
  },
});

/**
 * The only annotation classifications Map'd accepts — shared by the schema
 * validator and `mapd annotate`. These are the "tell Map'd" levers for what
 * static analysis structurally cannot know:
 *   generated           — build/tool output; quarantined from scans
 *   dynamically-loaded  — loaded at runtime by a pattern no detector sees
 *   entrypoint          — a real entry point (any language); grows a workflow
 *   intentional-dormant — deliberately kept code; never reported as an orphan
 */
export const ANNOTATION_CLASSIFICATIONS = Object.freeze(["generated", "dynamically-loaded", "entrypoint", "intentional-dormant"]);

/** Field-level validators. Each returns an error string, or null if valid. */
const VALIDATORS = {
  "project.include": (v) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? null : "must be an array of glob strings"),
  "project.exclude": (v) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? null : "must be an array of glob strings"),
  "mapping.confidenceThreshold": (v) => (typeof v === "number" && v >= 0 && v <= 1 ? null : "must be a number between 0 and 1"),
  "mapping.orphanThreshold": (v) => (typeof v === "number" && v >= 0 && v <= 1 ? null : "must be a number between 0 and 1"),
  "mapping.maxFileSizeBytes": (v) => (typeof v === "number" && v > 0 ? null : "must be a positive number"),
  "chat.maxContextTokens": (v) => (typeof v === "number" && v > 0 ? null : "must be a positive number"),
  "chat.maxCommandOutputCharacters": (v) => (typeof v === "number" && v > 0 ? null : "must be a positive number"),
  "fix.maxAttempts": (v) => (Number.isInteger(v) && v >= 1 ? null : "must be an integer >= 1"),
  "mapping.polyglot": (v) => (typeof v === "boolean" ? null : "must be a boolean"),
  "mcp.transport": (v) => (v === "stdio" ? null : "only 'stdio' transport is currently supported"),
  "project.annotations": (v) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return "must be an object mapping glob patterns to classifications";
    const allowed = new Set(ANNOTATION_CLASSIFICATIONS);
    for (const [pattern, raw] of Object.entries(v)) {
      // an annotation value may be a bare classification string, or an object
      // { classification, reason?, source?, date? } carrying attribution
      // (see `mapd config lint` — attribution is optional but recommended).
      const cls = typeof raw === "string" ? raw : (raw && typeof raw === "object" && !Array.isArray(raw) ? raw.classification : undefined);
      if (typeof cls !== "string" || !allowed.has(cls)) {
        return `"${pattern}": classification must be one of ${[...allowed].map((a) => `"${a}"`).join(", ")} (got "${typeof raw === "object" ? JSON.stringify(raw) : raw}")`;
      }
      if (raw && typeof raw === "object") {
        for (const k of Object.keys(raw)) {
          if (!["classification", "reason", "source", "date"].includes(k)) return `"${pattern}": unknown attribution field "${k}" (allowed: classification, reason, source, date)`;
        }
      }
    }
    return null;
  },
};

export function validateAgainstSchema(config) {
  const errors = [];
  for (const [pathKey, validate] of Object.entries(VALIDATORS)) {
    const value = pathKey.split(".").reduce((o, k) => o?.[k], config);
    if (value === undefined) continue;
    const err = validate(value);
    if (err) errors.push(`${pathKey}: ${err}`);
  }
  return errors;
}
