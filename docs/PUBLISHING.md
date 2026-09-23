# Publishing mapd to npm

Everything is staged. The only thing standing between here and a published
package is npm's account state — the code, the tests and the tarball are done.

---

## Where it stands

| | |
|---|---|
| Package | `@dev-tren/mapd@0.20.0` |
| Repo | `Devon-Tren/mapd`, `main`, pushed, clean |
| Tests | **499/499** |
| Tarball | 197 kB, 67 files, audited — no keys, no personal paths, no billing data |
| npm account | `dev-tren` |
| **Blocked until** | **2026-09-26 15:21 UTC** |

## Why it is blocked

npm **auto-suspends an account for 72 hours when a recovery code is used to
log in.** That is a security policy, not a punishment, and nothing is wrong
with the account. It went read-only at 2026-09-23 15:21 UTC: browsing and
installing still work, publishing does not.

The suspension was self-inflicted while working around a deeper problem — see
"the 2FA trap" below.

## Do these now (they still work while suspended)

1. **Regenerate recovery codes** — https://www.npmjs.com/settings/~/recovery-codes
   One code was pasted into a chat transcript on 2026-09-23 and must be
   treated as exposed. Regenerating invalidates the whole old set.
2. **Audit 2FA devices** — https://www.npmjs.com/settings/~/tfa/list
   Expect exactly one entry, `npm_security_key`. Remove anything unfamiliar.
3. **Rotate the password** — https://www.npmjs.com/settings/~/password
   Optional; nothing indicates anyone else touched the account.

---

## The 2FA trap, and why it must be solved before publishing

Three ways to satisfy npm's publish 2FA. On this account, all three fail:

| Method | Status |
|---|---|
| **TOTP** (6-digit authenticator app) | npm does not offer enrollment on this account — no QR code is shown |
| **WebAuthn security key** | Works for website login. **npm's CLI publish does not accept it** — it returns `EOTP` asking for a code the key cannot produce |
| **Recovery code** | Works, **and triggers the 72-hour suspension**. Single-use. Not a repeatable path |
| Granular token w/ 2FA bypass | Works today, but npm is restricting these: account changes Aug 2026, direct publishing **Jan 2027** |

So there is no sustainable manual path. Do not plan to publish `0.20.1` the
same way.

## The fix: trusted publishing via GitHub Actions

npm supports OIDC trusted publishing — GitHub Actions authenticates directly,
with **no token, no OTP, no 2FA prompt**, and npm marks the release as
provenance-verified. It is where npm is pushing everyone, and it sidesteps all
four rows of the table above.

Rough shape (set up before 2026-09-26 so the unblock is a one-liner):

1. On npmjs.com, add a **trusted publisher** for `@dev-tren/mapd`:
   repository `Devon-Tren/mapd`, workflow `.github/workflows/publish.yml`.
2. Add that workflow, triggered on a version tag, with
   `permissions: { id-token: write, contents: read }`, `npm ci`, `npm test`,
   `npm publish`.
3. Publish by tagging: `git tag v0.20.0 && git push --tags`.

Then releases never touch a recovery code again.

## If you just want it out on Friday

Once the suspension lifts (2026-09-26 15:21 UTC):

```bash
cd /Users/devontrenoskie/Downloads/mapd-v0
npm publish --otp=<a FRESH recovery code>
```

`--access=public` is already in `package.json`, so no flag is needed. **This
will suspend the account again for another 72 hours.** Acceptable once, if the
goal is simply to ship this weekend — but set up trusted publishing before the
next release.

---

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
