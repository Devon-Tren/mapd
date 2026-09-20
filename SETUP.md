# Map'd — Setup Guide

From zero to mapping your own repo in about five minutes. For what Map'd *is* and how it makes decisions, read `README.md`; for the acceptance-test plan, `UAT.md`.

## Prerequisites

- Node.js ≥ 20 (`node --version`)
- git (needed for the `stability` confidence signal and `mapd integrate`; everything else works without it)
- A JavaScript/TypeScript project. Other languages are reported as unmapped — that's expected, not broken.

## Install

```bash
unzip mapd-v0.5.zip -d mapd && cd mapd
npm install
npm test            # gate zero: expect 20 pass, 0 fail before trusting anything
npm link            # exposes `mapd` globally
```

`npm link` on Windows/macOS/Linux all work; if you'd rather not link globally, invoke via `node /path/to/mapd/src/cli.js <command>`.

## First run on your repo

```bash
cd ~/your-project

mapd map .                    # scored workflow map in the terminal
mapd docs . -o MAP.md         # documentation with mermaid diagrams (renders on GitHub)
mapd baseline .               # snapshot ground truth → .mapd/baseline.json
mapd check .                  # from now on: diff reality against the baseline
```

Read the first `mapd map` output critically: workflows should correspond to entry points you recognize (bin, main, npm scripts, HTTP route files). If the call-resolution percentage is low, that's the map telling you how much of your codebase resolves statically — CommonJS-heavy repos land lower than ESM ones (measured: 55% on Express vs ~92% on an ESM codebase).

Commit `.mapd/baseline.json` if you want `mapd check` to work in CI; add `.mapd/findings.json` and `.mapd/integration/` to `.gitignore`.

## Enable the LLM layer (optional)

Every command runs fully without a key — deterministic mode. With a key you get doc narration, fix proposals, merge resolutions, and migration plans:

```bash
export ANTHROPIC_API_KEY=sk-ant-...        # PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."
export MAPD_MODEL=claude-sonnet-4-6        # optional; verify current model names at
                                           # https://docs.claude.com/en/api/overview
```

Get a key at https://console.anthropic.com. Architectural note you can verify in `src/agents/llm.js`: agents narrate and propose; they cannot write files, mutate the map, or emit confidence numbers. Removing the key changes nothing about correctness, only prose.

## Daily workflow

```bash
mapd watch .                        # live mode: re-maps on save (~100ms warm), streams
                                    # confidence deltas + regressions. Run it in a VS Code
                                    # split terminal for the side-panel experience.

mapd check . --propose              # after a work session: regressions + LLM fix drafts
mapd review                         # unified approval queue
mapd review --approve <id>          # apply a verified proposal / mark a finding approved
mapd review --dismiss <id> --reason "intentional"

mapd integrate feature-branch --propose      # classify + resolve merge conflicts (gated)
mapd modernize . --mode light                # every push: dependency findings only
mapd modernize . --mode heavy --propose      # periodic: full scan + migration plans
```

Exit codes are CI-friendly: `mapd check` exits 2 on high-severity findings, 1 on operational errors, 0 otherwise.

## CI integration

The repo ships `.github/workflows/ci.yml` (test matrix: ubuntu/windows/macos × Node 20/22). To gate *your* project's PRs on workflow regressions:

```yaml
- run: npm install -g /path/to/mapd   # or npm i -D once published
- run: mapd check .                   # fails the job on high-severity regressions
```

## GitHub App wrapper (SaaS path — optional)

```bash
MAPD_WEBHOOK_SECRET=<from your GitHub App settings> npm start   # :8787
curl localhost:8787/healthz
```

The server verifies HMAC signatures (timing-safe) and refuses to boot without a secret unless you pass `--insecure-dev`. What still requires your GitHub App registration before this path is production-real: installation-token auth and Octokit posting of check-runs/reviews (marked `TODO(deploy)` in `src/adapters/github-app.js`), plus persistent baseline storage keyed by repo. Local-only test recipe is in the header comment of `src/server.js`.

## Platform notes

- Developed and benchmarked on Linux; CI covers Windows and macOS but treat your first Windows run as verification, and prefer WSL if anything path-related misbehaves.
- Baselines are schema-versioned. After upgrading Map'd, a stale baseline fails loudly with instructions to re-snapshot — it will never silently mis-diff.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `mapd: command not found` | `npm link` didn't land on PATH — use `node src/cli.js ...` or re-link |
| Low call resolution on a CJS repo | Expected (measured floor ~55%); prototype-method indexing is the tracked improvement |
| `Baseline schema vN does not match` | Upgraded Map'd — run `mapd baseline` to re-snapshot |
| `--propose` prints "requires ANTHROPIC_API_KEY" | Key not exported in this shell |
| Watch mode misses changes in huge repos | Raise `--interval`; verify the directory isn't in the default ignore set (node_modules, dist, build, coverage, .next, out) |
| Server won't start | `MAPD_WEBHOOK_SECRET` unset — that refusal is intentional |
