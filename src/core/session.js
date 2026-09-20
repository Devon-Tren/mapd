/**
 * session.js — chat session memory: append-only turn log on disk, plus the
 * in-memory structured state (workflows discussed, files inspected, findings
 * discussed, commands run, patches proposed/applied, gate/retry history) that
 * chat/repl.js carries through a conversation.
 *
 * Summarization and budgeting here are deterministic (no LLM call) so chat
 * memory works identically with or without a configured provider.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MAPD = ".mapd";

function sessionsDir(rootDir) { return path.join(path.resolve(rootDir), MAPD, "sessions"); }

export function createSessionId() {
  return `sess-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

export function createSessionState(rootDir, sessionId = createSessionId()) {
  return {
    id: sessionId,
    rootDir: path.resolve(rootDir),
    startedAt: new Date().toISOString(),
    turns: [],
    filesInspected: new Set(),
    findingsDiscussed: new Set(),
    commandsExecuted: [],
    patchesProposed: [],
    patchesApplied: [],
    gateResults: [],
    retryHistory: [],
  };
}

function sessionFile(rootDir, sessionId) { return path.join(sessionsDir(rootDir), `${sessionId}.json`); }

/** Append-only: persist the session state's turn log to disk after each turn. */
export function persistSession(state) {
  fs.mkdirSync(sessionsDir(state.rootDir), { recursive: true });
  const serializable = {
    mapdSchema: 1,
    id: state.id,
    startedAt: state.startedAt,
    turns: state.turns,
    filesInspected: [...state.filesInspected],
    findingsDiscussed: [...state.findingsDiscussed],
    commandsExecuted: state.commandsExecuted,
    patchesProposed: state.patchesProposed,
    patchesApplied: state.patchesApplied,
  };
  fs.writeFileSync(sessionFile(state.rootDir, state.id), JSON.stringify(serializable, null, 2));
}

export function recordTurn(state, role, content) {
  state.turns.push({ role, content, at: new Date().toISOString() });
  return state;
}

/** Render a chat session as readable Markdown — prompts, answers, and the facts touched. */
export function exportTranscriptMarkdown(state) {
  const label = (role) => (role === "user" ? "🧑 You" : "🤖 Map'd");
  const lines = [
    `# Map'd chat transcript`,
    "",
    `- **Session:** \`${state.id}\``,
    `- **Started:** ${state.startedAt}`,
    `- **Project:** \`${state.rootDir}\``,
    `- **Turns:** ${state.turns.length}`,
    "",
    "## Conversation",
    "",
  ];
  if (!state.turns.length) lines.push("_(no turns yet)_");
  for (const t of state.turns) {
    lines.push(`### ${label(t.role)} · ${t.at}`);
    lines.push("");
    lines.push(t.content);
    lines.push("");
  }
  const facts = [];
  const listOf = (v) => (v instanceof Set ? [...v] : v ?? []);
  const filesInspected = listOf(state.filesInspected);
  const findings = listOf(state.findingsDiscussed);
  const commands = (state.commandsExecuted ?? []).map((c) => c.label ?? c.command ?? String(c));
  const applied = (state.patchesApplied ?? []).map((p) => p.id ?? String(p));
  if (filesInspected.length) facts.push(`- **Files inspected:** ${filesInspected.join(", ")}`);
  if (findings.length) facts.push(`- **Findings discussed:** ${findings.join(", ")}`);
  if (commands.length) facts.push(`- **Commands run:** ${commands.join(", ")}`);
  if (applied.length) facts.push(`- **Patches applied:** ${applied.join(", ")}`);
  if (facts.length) { lines.push("## Session facts", "", ...facts, ""); }
  return lines.join("\n");
}

/**
 * Deterministic conversation summarization: keep the most recent `keepLast`
 * turns verbatim; compress everything older into one line per turn (role +
 * first 80 chars). No LLM call — keeps memory functional with zero provider.
 */
export function summarizeConversation(turns, { keepLast = 6, maxChars = 4000 } = {}) {
  if (turns.length <= keepLast) return turns.map((t) => `${t.role}: ${t.content}`).join("\n").slice(0, maxChars);
  const older = turns.slice(0, turns.length - keepLast);
  const recent = turns.slice(turns.length - keepLast);
  const olderSummary = older.map((t) => `${t.role}: ${t.content.slice(0, 80)}`).join("\n");
  const recentText = recent.map((t) => `${t.role}: ${t.content}`).join("\n");
  return `[${older.length} earlier turn(s) summarized]\n${olderSummary}\n---\n${recentText}`.slice(0, maxChars);
}

/**
 * Priority-ranked, deduplicated, character-budgeted context assembly. Used
 * by chat/mcp/fix.js's context packages. `items`: [{text, priority, source}].
 * Higher `priority` wins; ties keep original order. Truncates the last item
 * that doesn't fully fit rather than dropping it outright.
 */
export function buildContextBudget(items, maxChars) {
  const seen = new Set();
  const deduped = items.filter((i) => {
    const key = i.text.trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const ranked = [...deduped].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  const included = [];
  let used = 0;
  let omitted = 0;
  for (const item of ranked) {
    if (used >= maxChars) { omitted++; continue; }
    const remaining = maxChars - used;
    if (item.text.length <= remaining) {
      included.push(item);
      used += item.text.length;
    } else {
      included.push({ ...item, text: item.text.slice(0, remaining), truncated: true });
      used = maxChars;
    }
  }
  return { included, omittedCount: omitted, usedChars: used };
}
