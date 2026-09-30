# Publishing mapd to npm

## How releases work

**Automatic.** Every push to `main` that changes what ships (`src/**`,
`package.json`, `package-lock.json`) is released by
`.github/workflows/publish.yml`:

1. `npm ci` + the full test suite — a red suite publishes nothing.
2. Version = the next patch after what npm has (0.21.0 → 0.21.1). To cut a
   minor/major, bump `package.json` by hand (`npm version 0.22.0
   --no-git-tag-version`) and push; a version above npm's is used as-is.
3. `npm publish` over GitHub OIDC trusted publishing — no token, no OTP.
4. The bump is committed back to `main` as `release vX.Y.Z [skip ci]` and
   tagged `vX.Y.Z`. Pull before your next edit.

Opt out for one push: put `[skip release]` in the commit message. Docs-only
pushes never release. A manual release: Actions → publish → Run workflow.

Users see new releases: an installed `mapd` checks npm at most once a day and
prints `mapd X is available — npm install -g @dev-tren/mapd` after a command
(silent in CI, pipes, `--json`, `mcp`, or with `MAPD_NO_UPDATE_CHECK=1`).

## One-time setup

1. **First publish (manual, once).** The trusted-publisher setting lives on the
   package's page, so the package has to exist first. Use npm 11+, whose 2FA
   step opens the browser and accepts the security key (npm 10's `EOTP` prompt
   is what caused the recovery-code trap):
   ```bash
   npx npm@latest login
   npx npm@latest publish
   ```
   Do **not** use a recovery code for this — using one suspends publishing
   for 72 hours.
2. **Attach the trusted publisher.** npmjs.com → `@dev-tren/mapd` → Settings →
   Trusted publishing → GitHub Actions: owner `Devon-Tren`, repository `mapd`,
   workflow `publish.yml`.
3. **Optional hardening:** in the same settings page, set publishing access to
   "Require two-factor authentication and disallow tokens" — trusted
   publishing keeps working.

## Background: the 2FA trap (2026-09)

With npm 10 the CLI only accepted a 6-digit OTP. This account has no TOTP
app (npm does not offer enrollment) and a WebAuthn key cannot produce an OTP,
so the only CLI path was a recovery code — which triggers npm's 72-hour
publishing suspension. Browser-based auth (npm 11+) and trusted publishing
both avoid it. Recovery codes pasted anywhere should be regenerated at
https://www.npmjs.com/settings/~/recovery-codes.

## Why the name is scoped

npm's typosquatting filter rejected the unscoped `mapd`:

> Package name too similar to existing packages gopd, mcp1, depd, hapi, tap, tape, add

That check runs **at publish time only** — the registry returning 404 for
`/mapd` meant unclaimed, not allowed. Any unscoped alternative risks the same
rejection after burning another recovery code. A scope skips the check
entirely.

The CLI is unaffected: `bin` still maps to `mapd`, so users type `mapd`. Only
the install line changes to `npm install -g @dev-tren/mapd`.

## After it publishes

- [ ] Verify: `npm view @dev-tren/mapd` and a clean `npm i -g @dev-tren/mapd`
- [ ] Update User-Tests' README — it still says `npm install -g mapd`
- [x] Trusted publishing set up (2026-09-29); releases are automatic on push
