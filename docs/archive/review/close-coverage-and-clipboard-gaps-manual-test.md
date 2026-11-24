# Manual Test: close-coverage-and-clipboard-gaps

Scope: the deployment-facing and security-relevant behaviour this branch changes that unit and integration tests cannot fully exercise (real browsers, real CI runners).

## Pre-conditions

- The branch is deployed to a dev instance (`npm run dev`).
- Two tenants are configured, and one user is a member of both.
- A vault is set up for that user, with at least one login entry and one credit-card entry.
- Browsers: Chrome (latest), Firefox (latest), Safari (latest).
- For the CI section, the PR is opened against `main` with GitHub Actions enabled.

## 1. CI wiring (`.github/workflows/ci.yml`)

1. Open the PR's `App: Coverage` job.
   - **Expected:** the merge step passes the per-file floor and the security-directory thresholds.
   - **Expected:** the step `node scripts/checks/check-coverage-scope.mjs coverage/coverage-summary.json` prints `check-coverage-scope: OK (<n> members measured)`, with n ≥ 1,120.
2. Push a throwaway commit that changes only `sentry.server.config.ts` (a comment edit).
   - **Expected:** `changes.app` is true, and `App: Test` and `App: Coverage` run.
   - Revert the commit afterwards.
3. Record each `App: Test` shard's wall time and the `App: Coverage` wall time.
   - **Expected:** each shard stays under 10 minutes, and `App: Coverage` under 7 minutes (plan, CI budget). If either is exceeded, follow the 4-shard rule in the plan.

**Rollback:** revert the `ci.yml` hunk. The coverage floors in `vitest.config.ts` can be reverted on their own; nothing persists outside the repository.

## 2. Clipboard handling of secret-bearing values

1. **Chrome.** Copy a share link from the share dialog, stay on the tab for 35 s, then paste into a text field.
   - **Expected:** the clipboard is empty.
   - **Expected:** the toast reads "Copied — this app will try to clear it in 30s. Clear your clipboard when you are done."
2. **Chrome.** Copy, switch to another application, wait 35 s, return to the tab, then paste elsewhere.
   - **Expected:** the clipboard is cleared once the tab regains focus.
3. **Chrome.** Same as step 2, but stay away for more than 10 minutes.
   - **Expected:** nothing is cleared on return. The retry window has expired; this is a documented residual.
4. **Firefox and Safari.** Repeat step 1.
   - **Expected:** the clipboard is NOT cleared, because these engines require a user gesture for every write. Record what you observe. The toast wording does not promise clearing.
5. **Safari.** Create an emergency-access grant.
   - **Expected:** the dialog stays open in its created state.
   - **Expected:** either "link copied" or "Grant created. Copy the invite link below." is shown, with the inline link.
   - **Expected:** press Done or Esc, then reopen. A blank form is shown and no link remains in the DOM.
6. **Share and Send dialogs.** Start creating a link, then press Esc while the request is in flight.
   - **Expected:** the dialog does not close until the request settles.
   - **Expected:** after it closes, reopening shows no previous URL or access password.

## 3. Share-link password gate (`/s/<token>`)

1. Enter a wrong password.
   - **Expected:** "wrong password" is shown and the attempt counter increments.
2. Revoke the link in another tab, then submit.
   - **Expected:** "this link is no longer available" is shown, and the attempt is not counted.
3. Make the rate limiter fail closed (stop Redis on the dev host).
   - **Expected:** "try again later" is shown, and the attempt is not counted.
   - Restart Redis afterwards.
4. Enter the correct password.
   - **Expected:** the input is masked and is emptied once the password is verified.

## 4. Vault unlock, travel mode and passphrase

1. Sign in with a passkey while the vault-unlock rate limit is exhausted.
   - **Expected:** the lock screen shows "rate limited", not "account locked".
2. Disable travel mode with a wrong passphrase until the account locks.
   - **Expected:** the message shows the remaining lock time.
3. Disable or enable travel mode after the session has expired (delete the session cookie first).
   - **Expected:** the sign-in-again dialog opens.
4. Change the passphrase while invalidation of the other sessions fails (inject a failure, e.g. stop the DB briefly between commit and invalidation in a debugger).
   - **Expected:** a persistent warning says the passphrase changed but other devices may still be signed in.
   - **Expected:** the next unlock uses the new passphrase.

## 5. Key rotation across tenants

1. Sign in to tenant A and tenant B in separate browsers. Rotate the vault key from tenant A.
   - **Expected:** the session in tenant B is signed out on its next request (cross-tenant revocation). The rotating session is signed out as well; this is intended.

## Adversarial scenarios

- **Lint bypass.** In a scratch branch, add each of the following to a component:
  - `navigator.clipboard.writeText(url)`;
  - `const { clipboard } = navigator`;
  - a dynamic `import("@/lib/clipboard/copy-secret")`;
  - an aliased `copySecretWithoutClear` import.

  **Expected:** `npm run lint` reports each one. Computed property access (`navigator["clip"+"board"]`) is a documented residual and is not expected to be reported.
- **Coverage-ignore pragma.** Add `/* v8   ignore next */` (extra spaces) to a security module.
  - **Expected:** `node scripts/checks/check-coverage-ignore-hints.mjs` fails.
- **Coverage escape.** Add a root-level `helper.ts` and import it from `proxy.ts`.
  - **Expected:** `check-coverage-scope` fails with `COVERAGE_IMPORT_UNMEASURED`.
- **Stale share secret.** Create a password-protected share link, close the dialog, and inspect React state with React DevTools.
  - **Expected:** `createdUrl` and `createdAccessPassword` are empty.
- **Edit-loader error text.** Corrupt an entry's ciphertext through the DB and open its edit dialog.
  - **Expected:** only a translated generic error is shown. No JSON or plaintext fragment appears.

## Rollback

Revert the branch merge. No schema migration, stored-data change, or key-format change is involved. The rotate-key invalidation scope change is the only server-behaviour change, and it only widens which sessions are revoked.
