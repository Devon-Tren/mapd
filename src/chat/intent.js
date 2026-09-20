/**
 * intent.js — deterministic, keyword/regex-based natural-language router.
 * No provider call, no API key required — this is what keeps chat fully
 * usable in deterministic-only mode. When a provider IS available, repl.js
 * may additionally ask it to choose from the same fixed action set; this
 * module is the zero-key fallback (and the first thing tried either way,
 * since it's free and instant).
 *
 * Returns a structured action, never free text to execute:
 *   { type: "slash", command }
 *   { type: "dev-command", cmd, args }
 *   { type: "review-action", action: "approve"|"dismiss", id, reason }
 *   { type: "fix", id, autoSelectHighestSeverity, autoApply? }
 *   { type: "search", query }
 *   { type: "watch" }
 *   { type: "unknown" }
 */

const SLASH_COMMANDS = new Set(["map", "baseline", "check", "docs", "modernize", "review", "findings", "evidence", "project", "context", "status", "diagnose", "handoff", "solutions", "score", "ceiling", "trace", "resolution", "find", "test-gaps", "test-credit", "improve", "verify", "transcript", "help", "clear", "end"]);

const RULES = [
  { re: /^run (a |the )?(project )?map\b/i, action: () => ({ type: "slash", command: "/map" }) },
  { re: /^(create|save) (a )?baseline\b/i, action: () => ({ type: "slash", command: "/baseline" }) },
  { re: /check (this|the) project against( its| the)? baseline/i, action: () => ({ type: "slash", command: "/check" }) },
  { re: /^generate (the )?docs\b/i, action: () => ({ type: "slash", command: "/docs" }) },
  { re: /run (the )?modernization scan\b/i, action: () => ({ type: "slash", command: "/modernize" }) },
  { re: /(show|list) (unresolved )?findings\b/i, action: () => ({ type: "slash", command: "/findings" }) },
  { re: /(show|list|start) (the )?(review|approval) queue\b/i, action: () => ({ type: "slash", command: "/review" }) },
  { re: /^(show|what.?s) (the )?(mapd )?status\b/i, action: () => ({ type: "slash", command: "/status" }) },
  { re: /^(diagnose|explain) (the )?(mapd )?(understanding|uncertainty|blind spots|limits)\b/i, action: () => ({ type: "slash", command: "/diagnose" }) },
  { re: /^(hand ?off|package (the )?(top )?findings|write a prompt for (claude code|codex))\b/i, action: () => ({ type: "slash", command: "/handoff" }) },
  { re: /^(run|show( me)?|give me) (the )?(top )?solutions\b/i, action: () => ({ type: "slash", command: "/solutions" }) },

  // Score Intelligence / Test Guidance / planner / verify — deterministic phrasings
  { re: /(what.?s|how high).*(honest )?ceiling|how high can (the )?(score|confidence) (honestly )?(go|get)|(is|can) (the score|confidence|it) (reach|hit|get to) 1(\.0)?/i, action: () => ({ type: "slash", command: "/score", args: ["ceiling"] }) },
  { re: /(explain|break ?down|what.?s (in|behind)) (the )?(score|confidence)/i, action: () => ({ type: "slash", command: "/score", args: ["explain"] }) },
  { re: /(why|how) (did|has) (the )?(score|confidence) (change|move|drop|rise|go up|go down)|(score|confidence) (delta|since (the )?baseline)/i, action: () => ({ type: "slash", command: "/score", args: ["delta"] }) },
  { re: /(show|list|what|which).*(test gaps|untested files|files (that )?(are )?untested|missing tests)/i, action: () => ({ type: "slash", command: "/test-gaps" }) },
  { re: /(show|find|which).*(padding|fake tests?|name-only tests?)/i, action: () => ({ type: "slash", command: "/test-credit", args: ["--padding"] }) },
  { re: /(show|which test).*(credits?|tests? cover(s|ing)?)/i, action: () => ({ type: "slash", command: "/test-credit" }) },
  { re: /(what should i (do|work on|fix)( next)?|best.*(cleanup|work|use of (my )?time)|(give me|make) (a|an) (improve|improvement|action) plan|how (do i|to) (improve|raise) (the )?(score|confidence))/i, action: () => ({ type: "slash", command: "/improve" }) },
  { re: /(run|do) (a |the )?verif(y|ication)|is (the )?project (ok|okay|good|passing|healthy|green)|are we (good|passing|green)|(run|pass) (the )?(ci )?gate/i, action: () => ({ type: "slash", command: "/verify" }) },
  { re: /(save|export|write) (the |this )?(chat |conversation |session )?transcript|(save|export) (the |this )?(chat|conversation|session)/i, action: () => ({ type: "slash", command: "/transcript" }) },

  { re: /(?:show|what.?s|explain)( the)? evidence (?:for|behind|on) (?:finding )?(\S+)/i, action: (m) => ({ type: "slash", command: "/evidence", args: [m[2]] }) },
  { re: /why (?:is|was) (?:finding )?(\S+) (?:flagged|reported|raised)/i, action: (m) => ({ type: "slash", command: "/evidence", args: [m[1]] }) },

  { re: /^trace (\S+)(?: to (\S+))?/i, action: (m) => ({ type: "slash", command: "/trace", args: [m[1], m[2]].filter(Boolean) }) },
  { re: /why (?:is|isn.?t) (\S+) (?:in|part of|out of) (?:the |a )?workflow/i, action: (m) => ({ type: "slash", command: "/trace", args: [m[1]] }) },
  { re: /(?:show|what.?s) the (?:import|call) chain (?:from|between) (\S+) (?:to|and) (\S+)/i, action: (m) => ({ type: "slash", command: "/trace", args: [m[1], m[2]] }) },
  { re: /(?:what.?s|which calls are) dragging down (?:the )?(?:call )?resolution( rate)?|(?:show|list) unresolved calls/i, action: () => ({ type: "slash", command: "/resolution" }) },
  { re: /^(?:find|look for|where is|where.?s) (?:code (?:related to|about) )?(.+)/i, action: (m) => ({ type: "slash", command: "/find", args: m[1].trim().split(/\s+/) }) },

  { re: /approve finding (\S+)/i, action: (m) => ({ type: "review-action", action: "approve", id: m[1] }) },
  { re: /dismiss finding (\S+)(?: because (.*))?/i, action: (m) => ({ type: "review-action", action: "dismiss", id: m[1], reason: m[2] ?? null }) },

  { re: /fix (the )?highest[- ]severity finding/i, action: () => ({ type: "fix", id: null, autoSelectHighestSeverity: true }) },
  { re: /fix finding (\S+)/i, action: (m) => ({ type: "fix", id: m[1], autoSelectHighestSeverity: false }) },
  { re: /apply (a )?fix (where|wherever|if) (you )?can/i, action: () => ({ type: "fix", id: null, autoSelectHighestSeverity: true, autoApply: true }) },
  { re: /apply (the )?fix (for )?finding (\S+)/i, action: (m) => ({ type: "fix", id: m[3], autoSelectHighestSeverity: false, autoApply: true }) },

  { re: /^run (the )?tests\b/i, action: () => ({ type: "dev-command", cmd: "npm", args: ["test"] }) },
  { re: /^run (the )?linter\b/i, action: () => ({ type: "dev-command", cmd: "npm", args: ["run", "lint"] }) },
  { re: /^(build|typecheck) the project\b/i, action: (m) => ({ type: "dev-command", cmd: "npm", args: ["run", m[1].toLowerCase() === "build" ? "build" : "typecheck"] }) },
  { re: /^install dependencies\b/i, action: () => ({ type: "dev-command", cmd: "npm", args: ["install"] }) },
  { re: /^start (the )?dev(elopment)? server\b/i, action: () => ({ type: "dev-command", cmd: "npm", args: ["run", "dev"] }) },
  { re: /(show|what).*\bgit diff\b/i, action: () => ({ type: "dev-command", cmd: "git", args: ["diff"] }) },

  { re: /search for (all )?references to (.+)/i, action: (m) => ({ type: "search", query: m[2].trim() }) },
  { re: /^start watching( the project)?\b/i, action: () => ({ type: "watch" }) },
];

export function classifyIntent(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("/")) {
    const command = trimmed.slice(1).split(/\s+/)[0].toLowerCase();
    if (SLASH_COMMANDS.has(command)) return { type: "slash", command: `/${command}`, args: trimmed.split(/\s+/).slice(1) };
  }
  for (const rule of RULES) {
    const m = rule.re.exec(trimmed);
    if (m) return rule.action(m);
  }
  return { type: "unknown", text: trimmed };
}
