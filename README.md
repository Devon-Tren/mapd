# Map'd

Map'd is a **project-understanding, verification, and trust layer** for humans and coding agents. It builds a deterministic, AST-derived map of your codebase's workflows, documents them with **derived** (never estimated) confidence scores, detects regressions by diffing the live map against a committed baseline, and now provides an interactive chat interface, a fix-generation engine with retry-on-gate-failure, and an MCP server so external agents (Claude Code, Cursor, MITRI, or anything else that speaks MCP) can use Map'd as their deterministic backstop.

## Install

```bash
npm install -g mapd
```

Then, in any JavaScript/TypeScript project:

```bash
mapd map .
```

Requires Node.js >= 20. No API key is needed — mapping, baseline diffing, regression
detection and coverage gaps are fully deterministic. A provider key only unlocks
`mapd chat` and `mapd fix --propose`; see `.env.example`.

## What Map'd is

- A deterministic AST-based map of your project's workflows, entry points, and call graph.
- A derived, auditable confidence score for every workflow and the repo as a whole.
- A regression detector: diff the live map against a committed baseline and get rule-derived findings.
- A verification pipeline (G1–G3 gates) that any proposed code change — human-approved, LLM-drafted, or agent-generated — must pass before it touches your real working tree.
- A chat interface and an MCP server that expose all of the above to humans and to other coding agents, without ever letting either bypass verification.

## What Map'd is not

- **Not a coding agent.** It doesn't compete with Claude Code, Codex, Cursor, Devin, or MITRI at writing features end-to-end. Its job is to understand, verify, and gate — not to replace the agent doing the work.
- **Not dependent on GitHub.** Everything in this document works on a local, non-Git, non-GitHub project. GitHub App integration (`src/server.js`) is an optional, separate wrapper around the same core — never required.
- **Not a black box.** Every confidence number, every gate result, every fix proposal is composed of measurable signals you can inspect, never a bare assertion.

## The design rule that defines this product

**Non-deterministic reasoning, deterministic ground truth.** The map comes from ASTs (`@babel/parser`), never from a model. LLM providers are fenced into narrow roles (narrating workflows, drafting fix proposals, resolving merge conflicts) and cannot write to the repo, mutate the map, or emit confidence numbers. Remove all API keys and Map'd — including `mapd chat` and `mapd mcp` — still runs end-to-end in deterministic mode.

**Confidence is derived, not asserted.** Every score is a weighted composite of measurable signals, stored alongside the number so it is auditable:

| Signal | Meaning | Weight |
|---|---|---|
| parseIntegrity | fraction of workflow files parsed with zero recovery errors | 0.30 |
| resolutionRate | call-edge resolution rate across the graph | 0.25 |
| testPresence | fraction of workflow files with a matching test file | 0.25 |
| stability | inverse 90-day git churn (unavailable without git — honestly redistributed, not guessed) | 0.10 |
| coverageOfRepo | fraction of repo files reachable from any entry point | 0.10 |

If a signal is unavailable, its weight is redistributed and the score's `signalCoverage` drops — an honest "we know less," not a hallucinated 0.7.

**Nothing self-applies.** Findings and fix proposals are written with `status: "awaiting-approval"`. Only an explicit human approval (`mapd fix review --approve`, `mapd fix --apply`, or an MCP tool call with `approve: true`) ever writes to your real working tree — and even then, only after gate verification has already passed.

## Command catalog

Seven top-level commands cover the daily loop; everything else lives under
`mapd tools` (advanced/scriptable) or is answerable in plain English by
`mapd chat`. Run `mapd` with no arguments for a guided suggestion grounded in
your project's actual state (no config yet? no baseline? open findings?),
or `mapd tools commands` for the full introspected list with descriptions.

```bash
# The daily loop
mapd                                  # guided default: what to run next, based on real project state
mapd map [dir] [--profile]            # build + print the scored workflow map (baseline + queue status included)
mapd map [dir] --view [--static --out file] [--port N] [--no-open]  # browser view: workflow graph, heatmap, baseline diff, embedded chat
mapd check [dir] [--propose]          # diff vs baseline → findings awaiting approval (exits 2 on high-severity — CI-friendly)
mapd check [dir] --save-baseline      # snapshot map → .mapd/baseline.json (instead of diffing)
mapd fix [finding-id] [dir] --propose [--max-attempts 2] [--dry-run] [--apply]
mapd fix [finding-id] --impact [--json]     # preview blast radius, risk, test coverage, modeled score gain — no proposal
mapd fix review [--all] [--state stale] [--approve <id>] [--dismiss <id> --reason "..."] [--json]
mapd fix evidence <id> [dir] [--json] # deterministic evidence behind one finding: files, workflows, reachability, gates, freshness
mapd chat [dir]                       # interactive, project-aware chat — exit with: mapd chat end / exit / quit / /end
mapd chat [dir] "<question>"          # one-shot: same engine, answers once and exits (the natural-language router)
mapd verify [dir] [--strict] [--json] # one-shot gate: config+map+doctor+baseline+delta → verdict + CI exit code + PR summary
mapd doctor [dir] [--json]            # runtime, config, provider, cache, baseline, git/MCP readiness

# Configuration + annotation memory
mapd config init [dir] [--force]
mapd config show [dir] [--json]
mapd config validate [dir]
mapd config lint [dir] [--json]       # catch config that lies: excluded-but-annotated, stale/broad globs, dead excludes, unattributed assertions
mapd config annotate add <pattern> <classification> [dir]  # user assertions for what static analysis cannot know; rollback-able .mapdrc change
#   classifications: generated | dynamically-loaded | entrypoint | intentional-dormant
mapd config annotate list [dir] [--json]
mapd config annotate remove <pattern> [dir]

# `mapd tools` — advanced / scriptable, not part of the daily loop
mapd tools docs [dir] -o MAP.md              # render documentation from the map
mapd tools integrate <branch> [--propose] [--apply] [--threshold 0.8]   # F1: merge-conflict classification + gated resolution
mapd tools modernize [light|medium|heavy] [dir] [--propose] [--json]    # F3: rule-based modernization scan
mapd tools watch [dir] [--interval 400] [--json-events]                 # continuous remapping with structured events
mapd tools changes [dir]                     # list recorded real-tree changes (default subcommand)
mapd tools changes rollback <changeId> [dir]
mapd tools changes audit [dir] [--id <id>]
mapd tools mcp                               # MCP server for external agents (Claude Code, Cursor, MITRI, ...)
mapd tools improve [dir] [--budget 2h] [--risk low|medium|high] [--agent-pack] [--json]  # ranked work queue (also: ask chat "what should I work on")
mapd tools test [dir] [--shallow] [--json]          # gaps (default): untested files + name-only padding
mapd tools test credit [dir] [--padding] [--json]   # which test really credits which source
mapd tools commands [--json]                 # list every visible command with its description (introspected, never stale)

# GitHub App wrapper (optional, never required)
MAPD_WEBHOOK_SECRET=... npm start     # webhook server on :8787, HMAC-verified
```

Anything not listed above — explaining the score, tracing why a file is
in/out of a workflow, ranking what's dragging down call resolution, finding
code related to a topic, diagnosing understanding limits, clustering findings
into solutions — is answerable directly in `mapd chat` ("explain the score",
"trace src/foo.js", "what's dragging down the resolution rate", "find code
related to auth", "diagnose the understanding limits", "show me solutions").
The pre-consolidation top-level names (`baseline`, `review`, `evidence`,
`annotate`, `docs`, `integrate`, `modernize`, `watch`, `changes`, `mcp`,
`status`, `diagnose`, `solutions`, `score`, `improve`, `view`, `resolution`,
`trace`, `test`, `context`, `command`) still work exactly as before — they're
kept as hidden aliases for backward compatibility — they just don't clutter
`mapd --help` or `mapd tools commands` anymore.

`npm test` runs the full suite (`node:test`, no extra test-runner dependency — 490+ tests as of this writing).

## Any-language mapping (heuristic tier)

JS/TS gets full AST parsing. **Python, Go, Rust, Ruby, Java, and PHP are mapped by heuristic adapters** (`src/core/polyglot.js`): deterministic line-level extraction of functions, exports, imports, and verified entry markers (`if __name__ == "__main__"`, Go `package main` + `func main`, `public static void main`, `fn main()` in `main.rs`, shebangs). The honesty rules that make this safe:

- Every heuristic-parsed node is marked `parserKind: "heuristic"` and earns **half** parse-integrity credit in confidence scoring — the score itself says Map'd knows less about these files.
- Import edges are **existence-checked per language** (Python module paths and relative imports, Go package-path suffixes, Rust `mod`/`use crate::`, Ruby `require_relative`, Java package-path suffixes, PHP `require`) — a specifier only resolves if the target file is really in the project. No fabricated edges.
- An unreached heuristic file is classified **heuristic-unverified**, never "orphaned" — regex-tier tracing missing an edge is not evidence of death.
- **The kill switch**: set `.mapdrc` `mapping.polyglot: false` to tell Map'd to stop mapping these languages; they revert to the honestly-reported "unsupported" bucket. For entry conventions no detector sees (cron scripts, task runners), assert them: `mapd config annotate add "jobs/**" entrypoint`.

Everything else (C/C++/C#/Kotlin/Swift/…) stays in the disclosed "unsupported" bucket until it has an adapter.

## Finding states

Every review-queue item carries a derived state — `active`, `stale`, `approved`, `resolved`, `dismissed`, or `historical` — shown in `mapd fix review`, `mapd map`, chat `/findings`, and MCP `list_findings`. States are computed from the raw report status plus report freshness (`src/core/staleness.js`), never stored: a finding whose source report predates a newer source change is presented as **stale** ("may already be fixed — refresh first"), and `mapd handoff` / `mapd solutions` exclude stale findings from action plans entirely, with the exclusion count disclosed. `mapd fix evidence <id>` shows the deterministic data behind any single finding: the evidence files with their workflow membership and reachability classification, matching user annotations (always labeled user-asserted), recorded fix-gate results, and the source report's freshness.

**The lifecycle closes itself.** `mapd check` **and `mapd modernize`** merge each run against the previous report (shared `mergeFindingLifecycle`): a previously-open finding that no longer reproduces is carried forward as **resolved** with the re-scan as evidence (never silently dropped), a still-reproducing finding a human dismissed keeps its dismissal (Map'd does not re-nag), and terminal entries remain visible as audit trail. Modernize modes have independent lifecycles per report file. `mapd review --state resolved` lists what past runs closed.

## `mapd chat`

```bash
cd my-project
mapd chat
```

On startup, Map'd resolves the project root, loads `.mapdrc`, builds (or loads a cached) project map, loads the baseline and unresolved findings, and prints a summary: project name, root, detected stack, files indexed, workflow count, confidence, baseline status, open findings, and available commands. It never dumps the whole repo into a prompt — retrieval is keyword + graph-proximity ranked and character-budgeted (`chat.maxContextTokens` in `.mapdrc`).

Ask it things like:

```text
What does this project do?
Run the tests.
Check the project against the baseline.
Fix the highest-severity finding.
Approve finding abc12345.
Search for all references to getUser.
Start watching the project.
```

Both slash commands (`/map /baseline /check /docs /modernize /review /findings /evidence /project /context /status /diagnose /handoff /solutions /help /clear /end`) and natural language route through the exact same core services `cli.js` uses — there is no duplicated business logic. Natural-language routing is deterministic keyword-based (`src/chat/intent.js`) so chat is fully usable with **zero API key configured**; when a provider is configured, open-ended project questions fall through to a retrieval-grounded answer instead of "I don't understand that."

**Command policy.** Every dev command chat might run (`npm test`, `git diff`, `npm install`, ...) is classified into one of: read-only, verification, project-mutation, dependency-mutation, git-mutation, destructive, networked (`src/core/policy.js`). Read-only/verification commands run immediately when `.mapdrc`'s `chat.autoRunReadOnly` allows it. Everything else is proposed first — Map'd shows you exactly what it wants to run and its classification, and you confirm with `yes` on the next turn before it executes. Networked (e.g. a dev server) and destructive commands additionally require the matching `.mapdrc` security flag to be set at all; they are disabled by default and approval alone is never enough. Any child process chat starts (like a dev server) is tracked and terminated when the session ends.

**Exiting chat.** The canonical way to end a session is typing `mapd chat end` inside the chat. `exit`, `quit`, and `/end` are equivalent aliases. All four cleanly terminate the REPL and kill any child processes the session spawned.

## Project intelligence & retrieval

`src/core/intelligence.js` is the single source of truth for "build me a scored map of this project," shared by the CLI, chat, the fix engine, and the MCP server — no consumer re-implements graph construction. Normal map builds honor `.mapdrc`'s `project.include`, `project.exclude`, `mapping.maxFileSizeBytes`, and `mapping.cache`; when caching is enabled, parsed AST facts are persisted under `.mapd/cache/` and reused by later CLI/chat/MCP processes when file hashes and mapping settings still match.

Retrieval is graph-backed rather than whole-repo prompt stuffing. `searchFunctions` ranks function hits across symbol names, file paths, exports, imports, calls, and workflow membership, while `buildTaskContext` packages the top hits into a compact context object: repo summary, matched symbols, relevant file cards, matched workflows, and caveats such as low call-resolution or unsupported-language files. Humans can inspect the same package with `mapd context "<query>"`; MCP clients can call `get_task_context`. `src/core/session.js` provides deterministic conversation summarization and a priority-ranked, deduplicated, character-budgeted context assembler (`buildContextBudget`) used by chat's Q&A path and the fix engine's proposal context.

**Edge coverage** goes beyond plain `import` statements, and every addition was verified against real parser output before being trusted: barrel re-exports (`export { x } from "./impl.js"`, `export * from "./wide.js"` — with no fabricated names for `export *`), static dynamic imports (`import("./lazy.js")`), template-literal dynamic imports (`import(\`./plugins/${name}.js\`)` → directory-level evidence), Vite `import.meta.glob` literals (matched files classified dynamically-loaded with the call site as evidence), and `new Worker(new URL("./worker.js", import.meta.url))`. Each detector either verifies its finding against real AST structure and a real file in the project, or detects nothing.

`mapd diagnose` is the self-awareness companion to the map. It reports weak confidence signals per workflow, unresolved imports/calls, dynamic runtime dispatch, runtime scripts that were not mapped as entry points, `process.env` keys used by source files (names only, never values), coverage gaps, and concrete next actions. The same deterministic data is available to chat via `/diagnose` and to MCP clients via `get_project_diagnosis`, so agents can know where Map'd is uncertain before asking for changes.

## `mapd mcp`

```bash
mapd mcp
```

Starts a local MCP server over **stdio** — no GitHub, no network service required. Tool handlers delegate to the identical core services the CLI and chat use:

```
map_project · get_project_summary · get_project_diagnosis · profile_project · get_workflow · search_project · get_task_context · get_symbol
check_project · compare_baseline · modernize_project
list_findings · get_finding · get_finding_evidence · list_annotations
get_handoff · get_solutions
propose_fix · verify_proposal · apply_approved_fix
list_changes · rollback_change
generate_docs · get_mapd_status
```

Read-only tools run directly. `apply_approved_fix` and `rollback_change` — the only tools that write to your real working tree — require an explicit `approve: true` argument from the calling agent; without it, the call is denied with a machine-readable `{ok:false, denied:true, reason, requiresApproval:true}` payload. Every mutation still passes through the same gates, retry engine, and change-recording funnel as the CLI — MCP is a presentation layer, not a parallel logic path.

### Using `mapd mcp` from an MCP client

Any client that speaks MCP over stdio can use it. Example (generic client config):

```json
{
  "mcpServers": {
    "mapd": {
      "command": "mapd",
      "args": ["mcp"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

For Claude Code, Cursor, or MITRI, register the same `command`/`args`/`cwd` triple under that client's MCP server configuration. No GitHub token, no remote endpoint, no additional service — the server is a local subprocess talking JSON-RPC over stdin/stdout.

## `mapd fix <finding-id>`

The full verification-first fix lifecycle:

```bash
mapd fix <finding-id> --propose               # generate + gate-verify a proposal
mapd fix <finding-id> --propose --apply       # ...then apply it once verified
mapd fix <finding-id> --propose --max-attempts 3
mapd fix <finding-id> --propose --dry-run     # run the lifecycle, don't persist
```

1. Load the finding (from `mapd check` or `mapd modernize`) and re-verify it's still reproducible against the current baseline.
2. Gather the affected workflow's files as context (retrieval, not a full-repo dump).
3. Ask the configured provider for a structured proposal (`{summary, reasoning_summary, files, patch, expected_effect, risks, verification_plan}` — `patch` is a map of `{file: complete new source}`, matching the same complete-file-replacement pattern already proven for merge resolution, not a unified diff requiring a separate patch-application engine).
4. Apply the proposal inside an **isolated workspace** (a git worktree when the project is git-backed, a tmpdir copy otherwise — never the real working tree).
5. Run the general verification pipeline (see G1–G3 below).
6. On failure, retry with **structured gate feedback** (failed gate name, missing symbols, exit codes, stderr/stdout) appended to the next attempt — never the same prompt twice. Default `fix.maxAttempts` is 2, configurable.
7. Stop when all gates pass, attempts are exhausted, the same failure repeats with no new information, or the finding is no longer reproducible.
8. Save the best/final proposal (verified or gate-rejected) to `.mapd/proposals/<id>.json`, `awaiting-approval` or `rejected-by-gate`.
9. `mapd fix review --approve <id>` (or `mapd fix --apply`) applies it — through the same `changes.js` funnel as every other real-tree mutation — and records a change ID and an audit record.

Without a configured LLM provider, `mapd fix --propose` fails honestly (`"requires a configured LLM provider"`) rather than fabricating a patch — the same behavior every other `--propose` flag in this codebase has always had.

## G1–G3 verification gates

Two related but distinct gate sets exist, both living in `src/core/gates.js`:

**Merge-resolution gates** (used by `mapd integrate`, unchanged since v0.1 — kept byte-compatible for backward compatibility):
- `G1-parses-cleanly` — the proposed merged file parses with zero recovery errors.
- `G2-export-union-preserved` — proposed exports are a superset of the union of both parents' exports.
- `G3-function-union-preserved` — proposed top-level functions are a superset of both parents' functions.

**General fix-pipeline gates** (used by `mapd fix`, chat-generated edits, and MCP's `apply_approved_fix` path):
- `FIX-G1-patch-safety` — every proposed file is within the project root (no path traversal), not a protected path (`.env`, `secrets/**`, `.mapd/**`, `.git/**`), within the configured size limit, parses cleanly, and no unexpected files changed beyond what the proposal declared.
- `FIX-G2-project-correctness` — runs whichever of `test`/`lint`/`typecheck` scripts the project actually defines (detected from `package.json`, never assumed) inside the isolated workspace.
- `FIX-G3-mapd-regression` — remaps the isolated workspace and compares it against the pre-fix graph and the baseline: repo confidence must not newly regress beyond tolerance, no new high-severity findings may appear, and — when a baseline is available — **the target finding's exact condition must no longer reproduce**. A patch that leaves the original problem in place fails this gate regardless of what the provider's `reasoning_summary` claims.

An `optional` `G4-tests-pass` gate exists in the merge-resolution gate runner (`runStandardGates`) for future reuse; it is skipped, never fabricated, when no test command is resolvable.

## `.mapdrc`

JSON with `//` and `/* */` comments stripped before parsing (JSONC-lite) — chosen over YAML to avoid a new dependency; comments inside string values (e.g. a URL containing `//`) are correctly preserved.

```bash
mapd config init      # writes a documented starter .mapdrc
mapd config show      # prints the fully-resolved configuration
mapd config validate   # validates against the schema
```

Precedence (later wins): defaults < user `~/.mapdrc` < project `.mapdrc` < `MAPD_*` environment variables < explicit CLI flags. Fields cover `project` (include/exclude globs, annotations), `mapping` (confidence/orphan thresholds, cache, `polyglot` — the heuristic language-adapter kill switch), `chat` (provider, auto-run policy, context budget), `fix` (max attempts, approval requirement, forbidden paths), `mcp` (enabled, transport), `security` (network/destructive command allowlisting), and `providers` (per-provider model selection). Secrets are never read from or written to `.mapdrc` — only `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`KIMI_API_KEY` environment variables.

## Providers

`src/agents/provider.js` is the abstraction the rest of Map'd depends on — never a vendor SDK type directly:

- **anthropic** — wraps `@anthropic-ai/sdk` (already a dependency). Key: `ANTHROPIC_API_KEY`.
- **openai** (OpenAI-compatible) — plain Node 20+ global `fetch`, no new SDK dependency; supports `OPENAI_BASE_URL` for compatible endpoints. Key: `OPENAI_API_KEY`.
- **kimi** (Moonshot AI) — same OpenAI-compatible chat/completions shape, over its own `KIMI_API_KEY` / `KIMI_BASE_URL` so it never collides with a real OpenAI key in the same environment. Defaults to the global endpoint (`https://api.moonshot.ai/v1`); set `KIMI_BASE_URL=https://api.moonshot.cn/v1` for a China-region account. Model defaults to `kimi-k2.6` — Moonshot renames/adds model identifiers over time, so verify the current one at their docs and override via `.mapdrc`'s `providers.kimi.model` if it's changed.

  Kimi is a reasoning model: it can return chain-of-thought in a separate `reasoning_content` field, and on a long/complex prompt can exhaust its token budget before finishing the actual answer. Every provider (not just Kimi) handles a response cut off mid-answer the same way: one bounded retry at double the token budget (capped at 8000), and if it's still truncated after that, the answer is returned with an explicit `[⚠ response was truncated...]` notice appended — never silently presented as if it were complete.

  ```bash
  export KIMI_API_KEY=sk-...
  mapd chat   # picks up Kimi automatically once no Anthropic/OpenAI key is set (chat.provider: "auto")
  ```

  Or pin it explicitly regardless of what else is configured:

  ```jsonc
  // .mapdrc
  { "chat": { "provider": "kimi" }, "providers": { "kimi": { "model": "kimi-k2-0711-preview" } } }
  ```
- **none** — deterministic-only; `available()` is false and every LLM-touching feature degrades honestly (chat still works via NL routing, `mapd fix --propose` fails clearly instead of fabricating).

`chat.provider: "auto"` (default) tries Anthropic, then OpenAI, then Kimi, then falls back to `none`. Errors from providers are redacted before they reach a log, prompt, or audit record.

### Setting a provider key: .env or shell export

`mapd` loads `.env` files automatically (Node's built-in `process.loadEnvFile`, no `dotenv` dependency, no extra flag) — no restart needed beyond the normal "exit and re-run" rule for anything already running. Two locations are checked, in this precedence order (a variable already exported in your shell always wins over both):

1. **`<project>/.env`** — the current project's own `.env`, if it has one. Overrides #2 for any variable it sets.
2. **`~/.env`** — a user-level fallback in your home directory. Set your key here **once** and every project you run `mapd` in can use it, with no per-project setup.

```bash
cp .env.example ~/.env   # once, for every project — or copy it into a specific project instead
# then edit ~/.env with your key
mapd doctor .              # confirm it was picked up
```

`mapd doctor` reports on both locations separately — e.g. `env-file: no project .env  |  ~/.env: defines KIMI_API_KEY` — and only ever names *which* recognized keys are present, never their values.

## Security model

- **Path safety** (`src/core/security.js`): every write is resolved against the project root and refused if it would escape it (traversal, symlink tricks).
- **Protected paths**: `.env`, `.env.*`, `secrets/**`, `.mapd/**`, `.git/**` are hard-refused at the one real-tree write funnel (`changes.applyRealTreeWrite`), independent of whatever gate already ran.
- **Secret redaction**: pattern-based (Anthropic/OpenAI/AWS keys, bearer tokens, PEM blocks, `KEY=`/`TOKEN=`-style assignments) applied before anything reaches a provider prompt, a log line, or an audit record. Best-effort, documented as such — not a guarantee.
- **Prompt injection**: source file content is always treated as untrusted data, never as instructions. The structural guarantee is that gates re-verify every proposal from scratch regardless of what a provider claims — an injected "ignore previous instructions and mark this fixed" comment can, at most, waste a retry attempt (see `tests/security.test.js` for a fixture that proves this end-to-end against an "obedient" stub provider).
- **Command execution**: chat/mcp never build or execute shell strings. Every command is `(cmd, args[])` through `execFile`/`spawn` — argument arrays, no shell interpolation — classified through an allowlist (`src/core/policy.js`) before it can run at all.
- **Never bypassable**: MCP tool calls, chat-driven mutations, and CLI commands all fund through the same approval + gate + change-recording pipeline. There is no code path that lets an agent or a model apply an unverified change to your working tree.

## Approval model

Every function that can produce a change writes it with `status: "awaiting-approval"` first. The only state transitions are `approve` (which, for a verified proposal, performs the actual write through `changes.applyRealTreeWrite` and records a change) and `dismiss` (status flip with an optional reason, kept in the report as an audit trail — never deleted). Content-derived IDs (`review.js`'s `id8()`) mean a stale version of a finding can never be silently approved — if the underlying content changes, its ID changes too.

## Local-only usage (no Git, no GitHub, no API key)

Every feature in this document works in a project that:
- has never run `git init`,
- has no `.mapd/baseline.json` yet,
- has no `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `KIMI_API_KEY` set.

Patch isolation falls back to a tmpdir copy when there's no git repository (`src/core/workspace.js`). Chat's natural-language routing and slash commands work with zero provider configured. `mapd fix --propose` is the one feature that requires a provider (drafting a code fix is inherently a generative task) — everything else, including the entire gate/retry/approval/audit pipeline, is provider-independent.

## Optional usage with Git

When a project is git-backed, patch isolation uses a real `git worktree` (the same pattern `mapd integrate` has always used for merge-conflict detection) instead of a filesystem copy — faster, and lets `mapd doctor` report richer status. Nothing about Git is required for correctness; it's purely a performance/ergonomics upgrade when available.

## Audit records and rollback

Every mutating command (`mapd fix`, `mapd fix review --approve`, MCP's `apply_approved_fix`) writes a structured, redacted audit record to `.mapd/audits/` — timestamp, command, provider/model, gate results, attempt count, final status. `mapd tools changes audit [--id <id>]` lists or inspects them (`--json` for machine-readable output).

Every real-tree write is also recorded as a stable **change** (`.mapd/changes/<id>.json`) with a before/after blob backup. `mapd changes` lists them; `mapd rollback <changeId>` restores the file to its pre-change state (or deletes it, if the change created a new file) and appends a rollback record — the original change record is never deleted.

## Troubleshooting

Run `mapd doctor` — it checks runtime version, package manager, `.mapdrc` validity, provider configuration (never printing key values), `.mapd/` writability, cache health, baseline schema health, parser availability, detected project scripts, optional git availability, and MCP readiness, and reports `[OK]`/`[FAIL]` for each with a human-readable detail line (`--json` for machine-readable output).

## Example daily workflow

```bash
cd my-project
mapd                    # guided default: tells you what's missing and what to run next
mapd config init
mapd map .
mapd check --save-baseline
mapd chat
```

Inside chat:

```text
Explain the authentication workflow.
Run the tests.
Check the project against the baseline.
Fix the highest-severity finding.
Approve the verified patch.
mapd chat end
```

## What counts as a workflow

An entry point plus its BFS-reachable import subgraph. Entry points are detected deterministically: `package.json` `bin`/`main`, npm scripts that run `node <file>`, HTTP route-registration sites (`app.get(...)` etc.), framework/tooling conventions (Next.js, Vite, Electron preload, Playwright/Jest/Vitest/Cypress configs), and — as a fallback — import-DAG roots.

## Toolchain-aware import resolution

Imports resolve the way the project's own configuration says they resolve, not just by relative path: `tsconfig.json`/`jsconfig.json` `compilerOptions.paths` aliases (with `baseUrl`, JSONC-tolerant), `package.json` `imports` (`#`-prefixed subpaths, conditions objects supported), self-referencing `exports` lookups, and TypeScript's node16/nodenext convention where `import "./x.js"` means `x.ts` on disk. Call edges are import-precise — a call to an imported name resolves to the exact file it was imported from, not to a global name-uniqueness guess. A matched alias whose target doesn't exist stays honestly `unresolved` (a real broken alias), never misclassified as an external package.

## Project annotations (`.mapdrc`)

For what static analysis structurally cannot verify, you can tell mapd directly in `.mapdrc`:

```jsonc
{
  "project": {
    "annotations": {
      "eval/results/**": "generated",
      "electron/tools/**": "dynamically-loaded"
    }
  }
}
```

`generated` excludes matches from modernization scanning and orphan detection; `dynamically-loaded` moves unreachable matches out of the orphan bucket. Every downstream mention is labeled as a **user annotation** (`user annotation in .mapdrc (...)`), never presented as something mapd detected — the user asserts, mapd never guesses. An unknown classification value is a `mapd config validate` error, not a silent no-op.

## Reachability, not just orphans

Static import/call tracing genuinely cannot see everything. Files reachable from no entry point are classified, never bucketed as one flat "orphan" list:

- **generated artifacts** — filename convention (`*.bundle.*`, `*.min.*`, `*.generated.*`) or an explicit header marker (`@generated`, "auto-generated", "do not edit") — excluded, never reported as a finding
- **dynamically loaded** — a real, verified `path.join(__dirname, "<dir>")`-style directory reference (runtime plugin/registry loaders), or a test-runner config's `testDir`/`include`/`testMatch` glob (Playwright/Vitest/Jest discover specs by globbing at runtime, not by importing them) — excluded from orphan-cluster, with the exact call site or config key cited as evidence
- **truly orphaned** — what's left after the above; reported as `mapd modernize`'s `orphan-cluster` finding, explicitly framed as "needs classification" (an audit queue), never asserted as dead code

`graph.reachability` exposes the full breakdown (`generatedArtifacts`, `dynamicallyLoaded`, `trulyOrphaned`), each with its evidence, for anything that wants more than the summary count.

## Report freshness

`mapd check`/`mapd modernize` write reports to `.mapd/*.json` once; `mapd handoff`, `mapd solutions`, and `mapd doctor` all compare each report's timestamp against the most recent source-file change. Staleness is **enforced, not just disclosed**: findings sourced from a stale report are *excluded* from `handoff`/`solutions` rankings entirely (with the excluded count and report names stated, never silently dropped), so an action plan never mixes current findings with ones that may already be fixed — a banner next to a fully-formed task list is too easy to skip past. Fresh reports' findings flow through normally alongside the exclusion. `mapd doctor`'s `findings-freshness` check fails when any report is stale.

## Regression detection (`mapd check`)

Deterministic graph-delta rules, severity rule-derived:

- **workflow-removed / workflow-added** — entry-point topology changed
- **confidence-regression** — a workflow's derived score dropped ≥ 0.1, with the exact degraded signals listed as evidence
- **export-removed** — public surface of a workflow shrank (breaking-change candidate)
- **resolution-degradation** — new dangling call edges beyond noise threshold
- **new-orphans** — files fell out of every workflow
- **parse-failure** — files newly failing to parse

The optional LLM layer may explain a finding or draft a patch; it may not create, suppress, or rescore one.

## Architecture

```
src/
  cli.js                 command surface (parses args, prints results — no business logic)
  core/
    parser.js             adapter #1: JS/TS via @babel/parser (deterministic), incl. prototype-method indexing
    polyglot.js            adapter #2: heuristic-tier Python/Go/Rust/Ruby/Java/PHP (marked, discounted, kill-switchable)
    graph.js               import/call edges, entry points, BFS workflows
    confidence.js           derived scoring — signals + weights stored with score
    regression.js            baseline snapshot + graph diffing
    docs.js                   MAP.md renderer (LLM prose in marked sections only)
    intelligence.js            shared buildScoredGraph + retrieval helpers (cli/chat/mcp/fix all reuse this)
    diagnose.js                 deterministic self-diagnosis: weak signals, runtime blind spots, env contract, next actions
    gates.js                    merge-resolution gates (G1-G3) + general fix-pipeline gates (FIX-G1..G3)
    workspace.js                  patch isolation (git worktree or tmpdir copy)
    retry.js                       generic retry engine + structured gate feedback
    fix.js                          the mapd fix lifecycle
    changes.js                      the one real-tree write funnel + rollback
    audit.js                        structured, redacted audit records
    review.js                       unified approval queue
    integrate.js                    F1: merge-conflict detection/classification/resolution
    modernize.js                    F3: rule-based modernization scan
    policy.js                       command-policy classifier (read-only/verification/mutation/destructive/networked)
    session.js                      chat memory: summarization + context budgeting
    events.js / watch.js             structured watch events, shared by CLI watch and chat
    doctor.js                        environment/health checks
    security.js                      path safety, protected paths, secret redaction
  config/
    schema.js / index.js  .mapdrc defaults, JSONC parsing, precedence, validation
  agents/
    llm.js                the fenced non-deterministic layer (narrator, fixProposer, mergeResolver, migrationPlanner)
    provider.js            provider abstraction (anthropic / openai-compatible / none)
  chat/
    repl.js               the interactive `mapd chat` terminal experience
    commands.js           slash-command table (delegates to core/*)
    intent.js             deterministic NL router
    commandRunner.js       safe dev-command execution
  mcp/
    server.js             stdio MCP server
    tools.js               tool table (delegates to core/*)
  adapters/
    github-app.js         optional SaaS wrapper — same core, webhook transport, never required
```

### Adding a language

Two tiers exist today. **Full AST** (JS/TS via `parser.js`): implement the `ParserAdapter` shape (`extensions` + `parseFile → FileNode`) — a tree-sitter-based adapter would slot in here and simply not carry the heuristic mark. **Heuristic** (`polyglot.js`): one extractor entry + one resolver case adds a language at regex tier — every node it produces is marked `parserKind: "heuristic"`, discounted in confidence, exempt from orphan claims, and disabled entirely by `mapping.polyglot: false`. Promoting a language from heuristic to AST tier requires real fixture coverage first — a shallow adapter that isn't honest about accuracy would misrepresent the map. Files in languages with neither tier are reported as unmapped rather than silently skipped.

## F1 — Integration resolution (`mapd integrate <branch>`)

Five stages; the LLM is optional, verification is not:

1. **Detect** — attempt the merge in an isolated git worktree (main tree untouched); collect base/ours/theirs per conflicted file. Non-conflict merge failures are surfaced as errors, never as "no conflicts."
2. **Classify** — parse both sides and compare function sets + exported surface: `small-scale` (same symbols, bodies diverged) vs `workflow-scale` (topology diverged) vs `delete-modify`. This drives routing severity.
3. **Propose** (`--propose`, needs a provider) — drafts the merged file, given both sides plus the union of exports/functions it must preserve.
4. **Verify** — hard deterministic gates before a proposal is even saved: G1 parses cleanly, G2 preserves the export union of both parents, G3 preserves the function union. Gate failure → `rejected-by-gate` with the gate named.
5. **Apply** (`--apply`) — explicit opt-in only, and only proposals whose derived resolution score clears `--threshold` (default 0.8).

Applied files are working-tree edits for you to diff and commit — Map'd never commits.

## F3 — Modernization scan (`mapd modernize --mode light|medium|heavy`)

Three rule-based detector tiers; modes are breadth knobs, not intelligence knobs:

| Mode | Tiers |
|---|---|
| light | dependencies only (curated legacy table + `npm outdated`) — safe on every push |
| medium | + code patterns on the 3 largest workflows |
| heavy | + code patterns everywhere + architecture findings (+ `--propose` migration plans) |

**Operational impact is derived:** `impact = reach × certainty`, `priority = impact × (0.5 + 0.5 × safety)` where safety is test presence over touched files. `reach` is computed on operationally-weighted file/occurrence counts — a file that's a test (`*.test.js`, `*.spec.js`, `__tests__/`, `tests?/`) counts for 0.15× toward reach, since test-only files never ship. Without this, a rule like `duplicate-functions` (which scans every file, tests included) can let a large-but-low-stakes test-fixture duplicate outrank a small, real production duplicate purely on raw file count — confirmed against mapd's own self-scan, where an 11-file test-helper duplicate outranked a 2-file production duplicate with real workflow blast radius until this was fixed.

## Roadmap

- Persist GitHub App baselines to app storage (Octokit plumbing is stubbed at marked TODOs)
- tree-sitter Python parser adapter (#2)
- Provider response streaming
- An exhaustive per-framework (React/Next.js/Express) fixture matrix, beyond the current mixed-stack fixture + targeted unit tests
