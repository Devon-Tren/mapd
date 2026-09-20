/**
 * improve.js — the planner. `mapd improve --budget 2h --risk low`.
 *
 * Turns the scored graph into a ranked, honest work queue: every candidate task
 * is a real deficiency in a real signal, its expected lift is measured by
 * re-running the actual scorer (simulateScore — never a guess), and each task
 * carries what NOT to fake so the plan can't be satisfied deceptively. It also
 * states the honest ceiling up front, so it never implies 1.0 is reachable when
 * it isn't.
 *
 * It proposes; it never edits. The verification block tells you how to prove the
 * work landed.
 */

import { buildScoredGraph } from "./intelligence.js";
import { simulateScore, ceilingScore } from "./score.js";
import { classifyTestCredit } from "./testGuidance.js";
import { bold, dim, red, green, yellow, cyan, confidenceColor } from "./theme.js";

const RISK_RANK = { low: 1, medium: 2, high: 3 };

/** "2h" | "90m" | "120" → minutes. Missing/unparseable → Infinity (no cap). */
export function parseBudget(b) {
  if (b == null) return Infinity;
  const m = String(b).trim().match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)?$/i);
  if (!m) return Infinity;
  const n = parseFloat(m[1]);
  return (m[2] || "m").toLowerCase().startsWith("h") ? n * 60 : n;
}

const fmtEffort = (min) => min >= 60 ? `~${Math.floor(min / 60)}h${min % 60 ? `${Math.round(min % 60)}m` : ""}` : `~${Math.round(min)}m`;

/** Generate every candidate task from real graph deficiencies, each with a measured marginal lift. */
function candidates(rootDir, graph) {
  const out = [];
  const wfOf = (file) => graph.workflows.filter((w) => w.files.includes(file)).map((w) => w.id);
  const lift = (mutations) => simulateScore(rootDir, graph, mutations).delta;

  const credit = classifyTestCredit(graph).filter((s) => s.inWorkflow);

  // 1. untested workflow files → write a real test
  for (const s of credit.filter((c) => c.status === "untested")) {
    out.push({
      kind: "add-test", files: [s.file], signal: "testPresence", risk: "low",
      title: `Add a real test for ${s.file}`,
      why: `untested file in ${wfOf(s.file).join(", ") || "a workflow"}`,
      doStep: `import ${s.file} and exercise ${s.exportCount ? `its ${s.exportCount} export(s)` : "its behavior"}`,
      dontFake: "an empty or import-only test earns nothing — testPresence now credits only tests that import the module and use its exports",
      workflows: wfOf(s.file), effortMin: 15 + 5 * Math.min(s.exportCount, 5),
      lift: lift({ addTests: [s.file] }),
    });
  }

  // 2. name-only padding → replace the fake test with a real one
  for (const s of credit.filter((c) => c.status === "tested-nameonly")) {
    out.push({
      kind: "replace-padding", files: [s.file], signal: "testPresence", risk: "low",
      title: `Replace padding test for ${s.file}`,
      why: `credited only by filename coincidence (${s.credits.map((c) => c.test).join(", ")}) — earns nothing today`,
      doStep: `make the existing test actually import ${s.file} and assert on its exports`,
      dontFake: "this file already LOOKS tested; the honest move is a real test, not a more convincing-looking fake",
      workflows: wfOf(s.file), effortMin: 20,
      lift: lift({ addTests: [s.file] }),
    });
  }

  // 3. AST parse errors in workflow files → fix them
  const astErr = graph.files.filter((f) => f.parserKind !== "heuristic" && f.parsed && f.parseErrors > 0 && wfOf(f.file).length);
  for (const f of astErr) {
    out.push({
      kind: "fix-parse", files: [f.file], signal: "parseIntegrity", risk: "medium",
      title: `Fix parse recovery errors in ${f.file}`,
      why: `${f.parseErrors} parse error(s) reduce parseIntegrity for ${wfOf(f.file).join(", ")}`,
      doStep: "resolve the syntax the parser recovered from (unsupported syntax, missing config)",
      dontFake: "excluding the file to hide the error lowers coverage instead — fix the parse, don't mask it",
      workflows: wfOf(f.file), effortMin: 15,
      lift: lift({ fixParse: [f.file] }),
    });
  }

  // 4. call resolution — one aggregate task (can't attribute per call site here)
  const unresolved = (graph.stats.totalCalls ?? 0) - (graph.stats.resolvedCalls ?? 0);
  if (unresolved > 0 && (graph.stats.callResolutionRate ?? 1) < 0.999) {
    out.push({
      kind: "resolve-calls", files: [], signal: "resolutionRate", risk: "medium",
      title: `Resolve ${unresolved} unresolved call site(s)`,
      why: `call resolution is ${(graph.stats.callResolutionRate * 100).toFixed(1)}% — dynamic dispatch / anonymous functions hide edges`,
      doStep: "name anonymous functions and make dynamic require()/import() static where safe",
      dontFake: "some calls into external packages genuinely can't resolve — don't force those; leave them and note it",
      workflows: [], effortMin: Math.min(unresolved * 10, 240),
      lift: lift({ resolutionRate: 1 }),
    });
  }

  // 5. orphans → wire the top few into a workflow (coverage)
  const allFiles = graph.files.length || 1;
  const coveredNow = new Set(graph.workflows.flatMap((w) => w.files)).size;
  (graph.orphans ?? []).slice(0, 5).forEach((file, i) => {
    out.push({
      kind: "wire-coverage", files: [file], signal: "coverageOfRepo", risk: "medium",
      title: `Reach ${file} from a workflow`,
      why: "orphan file reached by no entry point — lowers coverageOfRepo",
      doStep: "import it from a reachable module, or confirm it is truly dead code",
      dontFake: "if it is intentionally dormant, annotate it `intentional-dormant` — do NOT wire dead code in just to lift coverage",
      workflows: [], effortMin: 15,
      lift: lift({ coverageOfRepo: (coveredNow + i + 1) / allFiles }),
    });
  });

  return out;
}

/**
 * Build a budget- and risk-bounded plan. Ranks by lift-per-effort, greedily
 * fills the budget, then measures the COMBINED projected score by simulating all
 * selected tasks at once (so the headline number isn't a sum of rounded parts).
 */
export function planImprovements(rootDir, { budget, risk = "low" } = {}) {
  const graph = buildScoredGraph(rootDir);
  const budgetMin = parseBudget(budget);
  const riskCap = RISK_RANK[risk] ?? RISK_RANK.low;

  const eligible = candidates(rootDir, graph)
    .filter((c) => RISK_RANK[c.risk] <= riskCap && c.lift > 0)
    .sort((a, b) => (b.lift / b.effortMin) - (a.lift / a.effortMin) || b.lift - a.lift);

  const selected = [];
  let spent = 0;
  for (const c of eligible) {
    if (spent + c.effortMin > budgetMin) continue;
    selected.push(c);
    spent += c.effortMin;
  }

  // combined projection — merge every selected task's mutation and simulate once
  const merged = { addTests: [], fixParse: [], coverageOfRepo: undefined, resolutionRate: undefined };
  for (const c of selected) {
    if (c.kind === "add-test" || c.kind === "replace-padding") merged.addTests.push(...c.files);
    if (c.kind === "fix-parse") merged.fixParse.push(...c.files);
    if (c.kind === "resolve-calls") merged.resolutionRate = 1;
    if (c.kind === "wire-coverage") {
      const coveredNow = new Set(graph.workflows.flatMap((w) => w.files)).size;
      const wired = selected.filter((s) => s.kind === "wire-coverage").length;
      merged.coverageOfRepo = (coveredNow + wired) / (graph.files.length || 1);
    }
  }
  const projection = simulateScore(rootDir, graph, merged);
  const ceiling = ceilingScore(rootDir, graph);

  const doNotDo = [];
  const padding = classifyTestCredit(graph).filter((c) => c.inWorkflow && c.status === "tested-nameonly");
  if (padding.length) doNotDo.push(`${padding.length} name-only padding test(s) already earn nothing — replacing them is real work; making them look more like tests is not.`);
  doNotDo.push("Don't create empty or import-only test files to move testPresence — Map'd credits only real/shallow test links now.");
  if ((graph.orphans ?? []).length) doNotDo.push("Don't wire intentionally-dormant files into a workflow to lift coverage — annotate them `intentional-dormant` instead.");
  if (ceiling.ceilingSignalCoverage < 1) doNotDo.push(`1.0 is not honestly reachable: even maxed, signalCoverage caps at ${ceiling.ceilingSignalCoverage} (${ceiling.caps.map((c) => c.cap).join(", ")}).`);

  return {
    budget: budgetMin === Infinity ? "unbounded" : fmtEffort(budgetMin),
    risk,
    current: graph.repoConfidence,
    projected: projection.after,
    totalLift: projection.delta,
    effortMin: spent,
    ceiling: { value: ceiling.ceiling, signalCoverage: ceiling.ceilingSignalCoverage },
    tasks: selected,
    deferred: eligible.length - selected.length,
    doNotDo,
    verify: ["mapd check --save-baseline   # once, to set the honest reference before you start", "# …do the work…", "mapd check   # or ask `mapd chat`: \"why did the score change\""],
  };
}

/** A compact, paste-ready task pack for Codex / Claude Code — exact files, risk, expected lift, and what not to fake. */
export function renderAgentPack(plan) {
  const lines = [
    "# Map'd improvement task pack",
    "",
    `Repo confidence **${plan.current} → target ${plan.projected}** (+${plan.totalLift}) within ${plan.budget}, risk ≤ ${plan.risk}. Honest ceiling ${plan.ceiling.value} (signalCoverage ${plan.ceiling.signalCoverage}).`,
    "Do the tasks in order. Every lift below is measured by Map'd's real scorer — do not fake signals to hit the number.",
    "",
    "## Tasks",
    "",
  ];
  if (!plan.tasks.length) lines.push("_No tasks fit this budget/risk with a positive score lift._", "");
  plan.tasks.forEach((t, i) => {
    lines.push(`### ${i + 1}. ${t.title}  \`[risk: ${t.risk} · expected +${t.lift}]\``);
    lines.push(`- **Files:** ${t.files.length ? t.files.map((f) => `\`${f}\``).join(", ") : "(project-wide)"}`);
    lines.push(`- **Why it matters:** ${t.why} (signal: ${t.signal})`);
    lines.push(`- **Do:** ${t.doStep}`);
    lines.push(`- **Do NOT fake:** ${t.dontFake}`);
    if (t.workflows?.length) lines.push(`- **Workflows touched:** ${t.workflows.join(", ")}`);
    lines.push("");
  });
  lines.push("## Do not do", "");
  for (const d of plan.doNotDo) lines.push(`- ${d}`);
  lines.push("", "## Verify when done", "", "```");
  for (const v of plan.verify) lines.push(v);
  lines.push("```");
  return lines.join("\n");
}

export function renderImprovePlan(plan) {
  const lines = [`\n${bold("Improve plan")} — budget ${plan.budget}, risk ${plan.risk}`];
  lines.push(`  ${confidenceColor(plan.current)(plan.current)}  →  projected ${confidenceColor(plan.projected)(plan.projected)}  ${green(`+${plan.totalLift}`)} ${dim(`from ${plan.tasks.length} task(s), ${fmtEffort(plan.effortMin)}`)}`);
  lines.push(`  ceiling ${confidenceColor(plan.ceiling.value)(plan.ceiling.value)} ${dim(`(signalCoverage ${plan.ceiling.signalCoverage})`)}`);

  if (!plan.tasks.length) {
    lines.push(green("\n  Nothing fits this budget/risk with a positive score lift."));
  } else {
    lines.push(`\n${bold("  Ranked tasks")} ${dim("(best lift per effort first)")}`);
    plan.tasks.forEach((t, i) => {
      const rc = t.risk === "low" ? green : t.risk === "medium" ? yellow : red;
      lines.push(`\n  ${bold(`${i + 1}.`)} ${rc(`[${t.risk} · ${fmtEffort(t.effortMin)} · +${t.lift}]`)} ${t.title}`);
      lines.push(dim(`       why:  ${t.why}`));
      lines.push(dim(`       do:   ${t.doStep}`));
      lines.push(`       ${red("don't fake:")} ${dim(t.dontFake)}`);
    });
  }
  if (plan.deferred) lines.push(dim(`\n  ${plan.deferred} more eligible task(s) didn't fit the budget.`));

  lines.push(`\n${bold("  Do not do")} ${dim("(score-chasing / deceptive)")}`);
  for (const d of plan.doNotDo) lines.push(`   ${yellow("▪")} ${d}`);

  lines.push(`\n${bold("  Verify")}`);
  for (const v of plan.verify) lines.push(`   ${cyan(v)}`);
  return lines.join("\n");
}
