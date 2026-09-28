# Publishing mapd to npm

## How releases work

Releases are published by GitHub Actions (`.github/workflows/publish.yml`) using
npm **trusted publishing**: GitHub authenticates to npm over OIDC, so there is
no token, no OTP and no 2FA prompt, and npm attaches a provenance attestation.

```bash
npm version 0.21.1 --no-git-tag-version   # bump package.json + lockfile
git commit -am "0.21.1" && git push
git tag v0.21.1 && git push origin v0.21.1   # this publishes
```

The workflow refuses to publish if the tag does not match `package.json`, and
runs the full test suite first.

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
- [ ] Set up trusted publishing so the next release is a tag
