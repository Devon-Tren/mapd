# Map'd v0.3 — UAT Script

Audience: 2–4 testers, ~45 min each. Prereqs: Node 20+, git, a JS/TS repo of their own (any size). `ANTHROPIC_API_KEY` optional — Scenarios 1–5 run without it; 6–7 need it.

Setup: unzip, `npm install && npm link && npm test`. **Gate zero: the suite must report 11+ pass, 0 fail before proceeding.**

## Positioning for testers

F2 (map/docs/regression) is the core product — judge it as a feature. F1 (integrate) and F3 (modernize) are beta — judge them as "is this direction trustworthy," not "is this finished." Report anything where Map'd *modified something without being told to* as severity-critical; the product's contract is that nothing self-applies.

## Scenario 1 — Map a real repo (F2)

Run `mapd map .` then `mapd docs . -o MAP.md` in your own repo.

PASS: workflows correspond to real entry points you recognize; every confidence score shows its signal table; unparsed/unsupported files are listed, not silently missing.
FAIL: a workflow claims files that aren't related; a score appears with no signals; files vanish from the report without being declared unmapped.

## Scenario 2 — Regression detection (F2)

`mapd baseline .` → delete an exported function something imports → `mapd check .`.

PASS: `export-removed` (HIGH) with the symbol named; exit code 2; `.mapd/findings.json` says awaiting-approval; your file is untouched. Restore the export → `mapd check` reports no regressions.
FAIL: regression missed; wrong symbol; anything auto-modified.

## Scenario 3 — Approval queue

After Scenario 2's findings exist: `mapd review` → `mapd review --dismiss <id> --reason "intentional"` → `mapd review` again.

PASS: item listed with a stable ID; dismissal removes it from the queue; `mapd review --all` still shows it with the reason (audit trail).
FAIL: IDs change between listings with no underlying change; dismissed items deleted from the report file.

## Scenario 4 — Merge conflict classification (F1, no key)

In a scratch repo, create the two-branch conflict from `tests/integrate.test.js` (or any real conflict). `mapd integrate <branch>`.

PASS: conflict detected with a `small-scale` / `workflow-scale` label that matches what you actually did; report saved; **your working tree and index are untouched** (`git status` clean).
FAIL: misclassification; any merge state left behind in your repo.

## Scenario 5 — Modernization modes (F3, no key)

`mapd modernize . --mode light` then `--mode heavy` on your repo.

PASS: light reports dependency findings only; heavy adds patterns/architecture; every finding shows `impact = reach × certainty` with safety; ordering feels defensible (untested-code findings damped). Offline: staleness signal reported as skipped, not guessed.
FAIL: light runs code-pattern rules; any finding without derived numbers; a priority you can't reproduce from the printed formula.

## Scenario 6 — LLM resolution with gates (F1, key required)

Scenario 4's conflict + `mapd integrate <branch> --propose`, then `mapd review --approve <id>` on a passing proposal.

PASS: proposal shows gate results; only gate-passing proposals reach awaiting-approval; approval writes the file to the working tree uncommitted; a workflow-scale proposal on untested code scores < 0.8.
FAIL: a proposal that dropped an export reached the queue; approval committed anything.

## Scenario 7 — Narration honesty (F2, key required)

`mapd docs .` with narration on. PASS: prose sits under the marked llm-narration comment, makes no numeric confidence claims, and says "purpose not determinable from structure" when it genuinely isn't. FAIL: narration invents scores or purposes.

## Scenario 8 — Finding states, evidence, and annotation memory (no key)

After Scenario 2's findings exist: `mapd review` (items show `(active)`), then touch any source file and run `mapd review` and `mapd status` again. Then `mapd evidence <id>` on one finding. Then `mapd annotate add "<some-generated-dir>/**" generated` → `mapd annotate list` → `mapd changes` → `mapd rollback <changeId>`.

PASS: after the source touch, items flip to `(stale)` with an explicit "may already be fixed — re-run" warning, and `mapd handoff` excludes them with a disclosed count; `mapd evidence` shows the finding's files with workflow membership and reachability class plus the report's freshness; the annotation write appears in `mapd changes` as an `[annotate]` entry and `mapd rollback` restores the previous `.mapdrc`.
FAIL: a stale finding presented as current with no disclosure; an evidence field that isn't traceable to a report/graph/config fact; an annotation edit that isn't recorded or can't be rolled back.

## Scenario 9 — Any-language mapping + lifecycle (no key)

In a mixed repo (or scratch: one JS entry, a `.py` with an `if __name__ == "__main__"` guard importing a second `.py`, a `.go` with `package main`): `mapd map .`. Then `mapd annotate add "<some-script>" entrypoint` for a script with no entry marker and re-map. Then Scenario 2's break → `mapd check` → undo the break → `mapd check` again.

PASS: Python/Go workflows form from verified entry markers with visibly LOWER confidence than the JS workflow (half parse-integrity credit, disclosed in `mapd map` output); unreached non-JS files are reported "heuristic-unverified, NOT claimed orphaned"; the annotated script grows a `wf:user-annotation:` workflow; the second check reports the finding auto-resolved ("not reproduced") and `mapd review --state resolved` lists it; setting `.mapdrc` `mapping.polyglot: false` drops those languages back to "unsupported".
FAIL: a non-JS import edge to a file that doesn't exist; a heuristic file claimed orphaned; a resolved finding silently vanishing instead of carrying re-check evidence; the kill switch not restoring old behavior.

## Known limitations — do not file as bugs

Full AST parsing is JS/TS only — Python/Go/Rust/Ruby/Java/PHP are heuristic-tier (regex extraction, half confidence credit, no call edges; disclosed everywhere), and other languages are reported as unmapped; cross-file call resolution requires unique exported names; `stability` signal needs git history; GitHub App server runs and verifies signatures but Octokit posting is stubbed at marked TODOs; LLM paths depend on API availability.

## Feedback format

Per scenario: PASS/FAIL, repo size (files/LOC), one thing that surprised you, one score or classification you disagreed with and why. The disagreements are the point — they calibrate the signal weights and the legacy-dep table.
