/**
 * testGuidance.js — Test Guidance: make the testPresence signal honest.
 *
 * confidence.js credits a source file as "tested" if ANY file on a test path
 * merely contains its basename as a substring (see hasTestFor). That is cheap
 * to satisfy and easy to fool: an empty `foo.test.js`, or a `foobar.test.js`
 * that never touches foo, both earn full credit.
 *
 * This module re-derives that relationship from real structure — the parsed
 * imports and exports already on every graph node — and separates:
 *   tested-real     a matching test imports THIS module AND references ≥1 export
 *   tested-shallow  a matching test imports the module XOR references an export
 *   tested-nameonly the basename rule credits it, but no import/symbol link
 *                   exists → padding: it inflates the score without evidence
 *   untested        no test matches by the basename rule at all
 *
 * It never rewrites the score here (that would move every baseline). It reports
 * how much of testPresence is real vs padding, so the inflation is visible —
 * and `mapd score` can be hardened as an explicit, separate decision.
 */

import path from "node:path";

/** The LITERAL rules confidence.js uses — imported nowhere else, mirrored here so the report can quote them exactly. */
export const TEST_PATH_RE = /(\.test\.|\.spec\.|__tests__\/|tests?\/)/;
export const SRC_EXT_RE = /\.(js|ts|jsx|tsx|mjs|cjs|py|go|rs|rb|java|php)$/;

const basenameKey = (file) => path.posix.basename(file).replace(SRC_EXT_RE, "");
const stripExt = (file) => file.replace(SRC_EXT_RE, "");

/** Resolve a relative import from `importer` to a repo-relative path without extension; null for bare/external. */
function resolveImport(importer, source) {
  if (!source || !source.startsWith(".")) return null;
  return stripExt(path.posix.normalize(path.posix.join(path.posix.dirname(importer), source)));
}

const QUALITY_RANK = { real: 3, shallow: 2, nameonly: 1 };

function suggestTestName(file, hasTopTestsDir) {
  const ext = (file.match(SRC_EXT_RE)?.[0] ?? ".js").slice(1);
  const testExt = ext === "mjs" || ext === "cjs" ? "js" : ext;
  const base = basenameKey(file);
  return hasTopTestsDir ? `tests/${base}.test.${testExt}` : `${path.posix.dirname(file)}/${base}.test.${testExt}`;
}

/**
 * The canonical per-source test-credit classification, derived from real parsed
 * imports/exports. Returns one record per non-test source file. This is the
 * SINGLE definition of "is this file really tested" — confidence.js consumes it
 * so the score and this report can never disagree.
 */
export function classifyTestCredit(graph) {
  const files = graph.files ?? [];
  const testFiles = files.filter((f) => TEST_PATH_RE.test(f.file));
  const srcFiles = files.filter((f) => !TEST_PATH_RE.test(f.file));
  const wfFiles = new Set(graph.workflows.flatMap((w) => w.files)); // only these move testPresence
  const hasTopTestsDir = files.some((f) => /^tests?\//.test(f.file));

  // Precompute each test file's resolved import targets + imported symbol names.
  const testMeta = testFiles.map((t) => {
    const targets = new Set();
    const names = new Set();
    for (const imp of t.imports ?? []) {
      // A type-only import exercises nothing at runtime, so it must not earn
      // test credit — otherwise `import type { Finding }` reads as coverage.
      if (imp.typeOnly) continue;
      const r = resolveImport(t.file, imp.source);
      if (r) targets.add(r);
      for (const n of imp.names ?? []) names.add(n);
    }
    return { file: t.file, targets, names };
  });

  return srcFiles.map((s) => {
    const key = basenameKey(s.file);
    const sNoExt = stripExt(s.file);
    const exportSet = new Set(s.exports ?? []);

    // Credit a test that NAMES this file (tests/logger.test.ts) OR one that
    // simply IMPORTS it. Gating on the filename alone missed real coverage:
    // tests/setup.test.ts imports redactSecrets from src/logger.ts, exercises
    // it properly, and was reported as untested purely because the test is not
    // called "logger". An import is stronger evidence than a filename.
    const nameMatched = testMeta.filter((t) => t.file.includes(key) || t.targets.has(sNoExt));

    const credits = nameMatched.map((t) => {
      const pathLinked = t.targets.has(sNoExt);
      const symbolLinked = exportSet.size > 0 && [...exportSet].some((e) => t.names.has(e));
      const quality = pathLinked && symbolLinked ? "real"
        : pathLinked || symbolLinked ? "shallow"
        : "nameonly";
      return { test: t.file, quality, pathLinked, symbolLinked };
    }).sort((a, b) => QUALITY_RANK[b.quality] - QUALITY_RANK[a.quality]);

    const best = credits[0];
    const status = !nameMatched.length ? "untested"
      : best.quality === "real" ? "tested-real"
      : best.quality === "shallow" ? "tested-shallow"
      : "tested-nameonly";

    return {
      file: s.file,
      inWorkflow: wfFiles.has(s.file),
      exportCount: exportSet.size,
      status,
      credits,
      suggestedTest: suggestTestName(s.file, hasTopTestsDir),
    };
  });
}

/** Files that count toward the HONEST testPresence signal (real or shallow credit). */
export function honestlyTestedFiles(graph) {
  return new Set(classifyTestCredit(graph)
    .filter((s) => s.status === "tested-real" || s.status === "tested-shallow")
    .map((s) => s.file));
}

/**
 * Analyze every workflow source file's test relationship. Returns per-file
 * classification + credit map + an honest-vs-current testPresence summary.
 */
export function analyzeTestCoverage(rootDir, graph) {
  const perSource = classifyTestCredit(graph);

  const wf = perSource.filter((s) => s.inWorkflow);
  const count = (st) => wf.filter((s) => s.status === st).length;
  const real = count("tested-real"), shallow = count("tested-shallow");
  const nameOnly = count("tested-nameonly"), untested = count("untested");
  const total = wf.length || 1;

  return {
    rule: {
      honest: 'a source file counts toward testPresence only if a matching test IMPORTS the module (path-linked) and/or REFERENCES one of its exports (symbol-linked) — real or shallow credit',
      looseLegacy: 'the retired substring rule credited any test whose path merely contained the basename; name-only matches now earn nothing',
    },
    summary: {
      workflowFiles: wf.length,
      real, shallow, nameOnlyPadding: nameOnly, untested,
      // testPresence is now the HONEST value and matches what confidence.js scores.
      testPresence: Number(((real + shallow) / total).toFixed(3)),
      // what the retired substring rule would have counted — kept only to show the gap.
      looseRuleWouldCredit: Number(((real + shallow + nameOnly) / total).toFixed(3)),
      paddingRejected: Number((nameOnly / total).toFixed(3)),
    },
    files: perSource,
  };
}

// ── views ──────────────────────────────────────────────────────────────────

/** Files that lower testPresence: untested, plus name-only padding (credited but unbacked). */
export function testGaps(analysis, { includeShallow = false } = {}) {
  const wanted = new Set(["untested", "tested-nameonly", ...(includeShallow ? ["tested-shallow"] : [])]);
  return analysis.files
    .filter((s) => s.inWorkflow && wanted.has(s.status))
    .sort((a, b) => a.status.localeCompare(b.status) || a.file.localeCompare(b.file));
}

/** The source→test crediting map. `paddingOnly` narrows to the anti-padding view. */
export function testCredit(analysis, { paddingOnly = false } = {}) {
  return analysis.files.filter((s) => {
    if (!s.credits.length && !paddingOnly) return s.inWorkflow; // untested workflow files still shown
    if (paddingOnly) return s.status === "tested-nameonly";
    return s.credits.length > 0;
  });
}

// ── renderers ────────────────────────────────────────────────────────────────

export function renderTestGaps(analysis, gaps, theme) {
  const { bold, dim, red, green, yellow, cyan } = theme;
  const s = analysis.summary;
  const lines = [`\n${bold("Test gaps")} — ${s.workflowFiles} workflow file(s)`];
  lines.push(`  testPresence (honest, scored): ${s.testPresence < 0.5 ? red(s.testPresence) : green(s.testPresence)}${s.paddingRejected > 0 ? dim(`  (the retired substring rule would have inflated this to ${s.looseRuleWouldCredit})`) : ""}`);
  lines.push(`  ${green(`${s.real} real`)} · ${cyan(`${s.shallow} shallow`)} · ${yellow(`${s.nameOnlyPadding} name-only padding (earns nothing)`)} · ${red(`${s.untested} untested`)}`);
  lines.push(dim(`  rule: ${analysis.rule.honest}`));
  if (!gaps.length) { lines.push(green("\n  No gaps — every workflow file has a real or shallow test.")); return lines.join("\n"); }
  const label = { "untested": red("untested"), "tested-nameonly": yellow("name-only padding"), "tested-shallow": cyan("shallow") };
  for (const g of gaps) {
    lines.push(`\n  ${label[g.status] ?? g.status}  ${bold(g.file)}${g.exportCount === 0 ? dim(" (no exports)") : ""}`);
    if (g.status === "tested-nameonly") {
      lines.push(dim(`      credited by ${g.credits.map((c) => c.test).join(", ")} — but no import or export reference; the credit is a filename coincidence`));
    } else if (g.status === "untested") {
      lines.push(dim(`      suggested: ${g.suggestedTest}  (import ${g.file}, exercise ${g.exportCount ? "its exports" : "its behavior"})`));
    } else {
      lines.push(dim(`      credited by ${g.credits[0].test} — ${g.credits[0].pathLinked ? "imports the module but references no export" : "references an export but doesn't import the module"}`));
    }
  }
  return lines.join("\n");
}

export function renderTestCredit(rows, theme, { paddingOnly = false } = {}) {
  const { bold, dim, red, green, yellow, cyan } = theme;
  const qColor = { real: green, shallow: cyan, nameonly: yellow };
  const lines = [`\n${bold(paddingOnly ? "Test credit — padding suspects" : "Test credit")}`];
  if (!rows.length) { lines.push(green(paddingOnly ? "\n  No padding suspects — all credits are real or shallow." : "\n  No credited files.")); return lines.join("\n"); }
  for (const r of rows) {
    if (!r.credits.length) { lines.push(`\n  ${red("untested")}  ${bold(r.file)}  ${dim(`→ suggest ${r.suggestedTest}`)}`); continue; }
    lines.push(`\n  ${bold(r.file)}  ${dim(`(${r.exportCount} export(s))`)}`);
    for (const c of r.credits) {
      const links = [c.pathLinked ? "imports module" : null, c.symbolLinked ? "uses export" : null].filter(Boolean).join(" + ") || "name match only";
      lines.push(`      ${qColor[c.quality](c.quality.padEnd(8))} ${c.test}  ${dim(`(${links})`)}`);
    }
  }
  return lines.join("\n");
}
