/**
 * llmIntent.js — second-tier, LLM-assisted intent classification. Only
 * consulted when intent.js's deterministic regex router (tier 1) finds no
 * match AND a provider is configured; with no provider, behavior is
 * unchanged (falls straight to grounded Q&A, as before).
 *
 * Deliberately restricted to the read-only/verification command set — never
 * /fix, approve/dismiss, dev-command, or watch. Those stay deterministic-only
 * (exact phrasing via intent.js), so a misclassification here can at worst
 * run an unwanted read-only scan, never mutate the tree, run a shell command,
 * or apply a patch. This is the "no false positives that matter" boundary.
 *
 * Returns a structured, validated action list (never free text to execute):
 *   { type: "sequence", commands: ["/map", "/modernize", ...] }
 *   { type: "qa" }
 */

export const READ_ONLY_COMMANDS = [
  "/map", "/baseline", "/check", "/docs", "/modernize",
  "/review", "/findings", "/project", "/context", "/status", "/diagnose", "/handoff", "/solutions",
  "/score", "/ceiling", "/test-gaps", "/test-credit", "/improve", "/verify",
];

const SYSTEM_PROMPT = `You are an intent classifier for a CLI tool called Map'd. Your ONLY job is \
to decide whether the user's message is REQUESTING one or more of a fixed set \
of read-only project commands to be run, or is instead a question/discussion \
that should be answered in prose.

Fixed commands you may select (nothing else exists):
${READ_ONLY_COMMANDS.join(", ")}

What each does:
/map — build the project's workflow map (files, workflows, confidence)
/baseline — snapshot the current map as the regression baseline
/check — diff current map against baseline, surface regressions/errors
/modernize — scan for modernization issues (dead code, duplication, old syntax, optimization opportunities)
/docs — render project docs
/review — list the approval queue
/findings — list open findings
/project — project/workflow summary
/context — this session's conversation summary
/status — confidence + baseline + findings-count summary
/diagnose — explain current understanding limits: weak confidence signals, runtime blind spots, env contract, next actions
/handoff — package the top open findings into a ready-to-paste prompt for an external coding agent (Claude Code, Codex)
/solutions — cluster related findings into data-backed solutions ranked by real workflow blast radius (deeper analysis than /handoff, not just a repackaged list)
/score — explain the derived confidence: what each signal contributes and what each weak signal costs
/ceiling — the honest maximum confidence reachable under current constraints (no git, heuristic parsing, etc.), and why 1.0 may be unreachable
/test-gaps — list workflow files lowering testPresence: untested files and name-only "padding" tests, with suggested filenames
/test-credit — show which test really credits which source file (imports the module + uses its exports) vs name-only padding
/improve — a ranked, honest work queue: the tasks that raise confidence most per unit effort, with measured score lift and what NOT to fake
/verify — one-shot gate: config + map + doctor + baseline regression + score delta → a single pass/warn/fail verdict

Rules:
- Only select a command if the user is clearly asking for it to be RUN or \
EXECUTED right now — not just mentioning, asking about, or discussing it.
- If the message is ambiguous, phrased as a question, or asks for an opinion \
or explanation rather than an action, classify it as "qa". Never guess.
- A message may request multiple commands in one go (e.g. "run map, then \
modernize, then check for errors") — list them all, in the order implied.
- A message may also be a REFERENTIAL follow-up ("run those", "do it", "run \
them now") pointing at commands named earlier in the conversation. Below the \
user's message you may see "Recent conversation" — if it's present and the \
assistant's own prior turn named specific commands (by /name or in prose), \
resolve the reference against exactly those commands. If no prior turn named \
any commands from the fixed list, classify as "qa" rather than guessing.
- "look for errors" / "find problems" / "check for issues" / "what's breaking" means /check.
- "modernize" / "old syntax" / "dead code" / "duplication" means /modernize.
- "what should I work on" / "how do I raise the score" / "best use of my time" / "action plan" / "improve the confidence" means /improve (the ranked plan) — NOT /modernize.
- "explain the score" / "what contributes to confidence" / "why is confidence X" means /score.
- "what's the ceiling" / "how high can it honestly go" / "can it reach 1.0" means /ceiling.
- "which files are untested" / "test gaps" / "padding tests" / "fake tests" means /test-gaps (or /test-credit for the credit map).
- "is the project passing/healthy/green" / "run verification" / "run the gate" means /verify.
- "diagnose uncertainty" / "explain blind spots" / "what does Map'd not understand yet" means /diagnose.
- "write a prompt for Claude Code/Codex" / "package the findings" / "hand this off" means /handoff.
- "what's the real underlying problem" / "cluster the findings" / "what's the bigger picture" means /solutions.
- Never select anything outside the fixed list above — there is no /fix, \
/approve, /dismiss, or shell command in your vocabulary; if the user asks for \
one of those, classify as "qa" and let the deterministic router or grounded \
Q&A handle it instead.

Respond with ONLY a JSON object, no prose, no markdown fences. Examples:
  {"intent": "command", "commands": ["/map", "/modernize", "/check"]}
  {"intent": "qa"}`;

/**
 * `provider` is the same `{available(), complete(system, user, maxTokens)}`
 * shape used everywhere else. `conversationContext` (optional) is recent
 * prior turns as plain text — needed to resolve referential follow-ups like
 * "run those commands," which otherwise have nothing to resolve against and
 * fall through to grounded Q&A (which correctly, but unhelpfully, says it
 * can't run anything). Fails safe to `{ type: "qa" }` on no provider, no
 * response, unparsable JSON, or a response outside the fixed vocabulary.
 */
export async function classifyIntentWithProvider(text, provider, conversationContext = "") {
  if (!provider?.available?.()) return { type: "qa" };

  const user = conversationContext ? `Recent conversation:\n${conversationContext}\n\nUser's message: ${text}` : text;
  let raw;
  try {
    raw = await provider.complete(SYSTEM_PROMPT, user, 300);
  } catch {
    return { type: "qa" };
  }
  if (!raw) return { type: "qa" };

  let parsed;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch {
    return { type: "qa" };
  }

  if (!parsed || parsed.intent !== "command" || !Array.isArray(parsed.commands)) return { type: "qa" };
  const commands = [...new Set(parsed.commands.filter((c) => READ_ONLY_COMMANDS.includes(c)))];
  if (!commands.length) return { type: "qa" };
  return { type: "sequence", commands };
}
