# Plan: vault-lock-epoch (#885)

Background operations in the MV3 service worker start while the vault is unlocked and keep running across a lock: lock, lock then re-unlock, or a token change. Afterwards they still deliver decrypted data, write the cache, write to the server, or sign.

`clearVault()` (`extension/src/background/index.ts`) nulls the key state but records nothing an in-flight operation could compare against.

The two existing correct patterns are:
- `hydrateFromSession`, which re-checks `hydrationSuperseded` after every await;
- `refreshTenantPolicy`, which compares the token after its fetch.

This plan turns that into a single primitive and applies it to every member.

## Project context

- **Type:** `mixed`. Only `extension/src/background/` changes, plus tests.
- **Test infrastructure:** `unit tests only` (vitest + jsdom; `background.test.ts` drives the real service-worker module with mocked `fetch` / `chrome`), plus CI.
- **VE1:** a manual check that unlock / lock / unlock in quick succession behaves in Chrome. Status: `blocked-deferred`, to be done by the user before merge. The race windows are milliseconds wide and cannot be reproduced reliably by hand, so the unit tests, which hold each await on a deferred promise, are the primary evidence. VE1 only confirms that nothing regresses in normal use.

## Requirements

- **FR1:** an operation that began in one vault epoch never performs a sink in another. A sink is any of:
  - a cache write (`cachedEntries`, `teamKeyCache`);
  - `sendResponse` / a return value carrying entry data, metadata or secrets;
  - a page delivery (`tabs.sendMessage`, `executeScript` args);
  - a clipboard write;
  - a server write (POST / PUT / DELETE);
  - a WebAuthn signature or attestation;
  - `pendingSavePrompts` writes.
- **FR2:** consumers can tell "locked" from "no entries". A stale epoch surfaces as `VAULT_LOCKED` (or the caller's existing locked shape), never as `[]`. If it were `[]`, login-save would offer a duplicate and the passkey path would report no duplicate.
- **FR3:** `UNLOCK_VAULT` never commits key state if a lock, a token change or a reconnect happened during its awaits. It never leaves `currentVaultSecretKeyHex` set on a failed unlock.
- **FR4:** the `decryptTeamOverviews` invalidate-and-retry deletes the key that `getTeamEncryptionKey` actually stored (`${userId}:${teamId}:${v}`).

## Contracts

### C1: the vault epoch

- **Primitive** (in `index.ts`):
  - `let vaultEpoch`, incremented in `clearVault()`;
  - `currentVaultEpoch(): number`;
  - `class VaultLockedError extends Error`;
  - `assertVaultEpoch(epoch: number): void`, which throws `VaultLockedError` when `epoch !== vaultEpoch`.
- **Deps:** `LoginSaveDeps` and `PasskeyProviderDeps` gain `getVaultEpoch: () => number`.
- **Invariant (app-enforced):** every member captures the epoch at its start, before its first await, and calls `assertVaultEpoch` immediately before each sink. A `VaultLockedError` maps to that path's locked response.
- **Control class:** `fail-closed verification gate`. A stale epoch denies the sink.
- **Adjudication authority:** the module-local counter. `clearVault` is the only way key state is cleared; `hydrateFromSession`'s catch arms run only while that state is already null.
- **Member set (R42).** The class is every code path that reads vault key state (`encryptionKey`, `currentUserId`, `ecdhPrivateKeyBytes`, `currentVaultSecretKeyHex`, `teamKeyCache`, or `deps.getEncryptionKey()`) and then crosses an `await` before a sink.
  - **Derivation:** `grep -nE "encryptionKey|getEncryptionKey\(|teamKeyCache|ecdhPrivateKeyBytes|currentVaultSecretKeyHex|getCachedEntries\(|getCachedSnapshot\(" extension/src/background/*.ts`, then walk each function containing a hit for an `await` before a sink.
  - **Seed (from the #885 issue; Phase 2 re-derives it and records any delta):** A1–A19.
    - **Cache and team keys:**
      - A1 `getCachedEntries` / `getCachedSnapshot`
      - A2 `fetchAllTeamEntries`
      - A3 `getTeamEncryptionKey`
      - A4 `FETCH_PASSWORDS`
    - **Secret delivery:**
      - A5 `fetchAndDecryptTeamBlob`
      - A6 `performAutofillForEntry` and all of its delivery points
      - A7 `COPY_PASSWORD`
      - A8 `COPY_TOTP`
      - A9 the copy commands
    - **Content and page bridges:**
      - A10 `resolveInlineMatches`
      - A11 `handleLoginDetected` and the `LOGIN_DETECTED` handler
      - A16 the passkey get-matches and duplicate check
      - A19 the `tabs.onUpdated` pending-save push
    - **Server writes and signing:**
      - A12 `handleSaveLogin`
      - A13 `handleUpdateLogin`
      - A14 `doSignAssertion`
      - A15 `handlePasskeyCreateCredential`
    - **Menu and unlock:**
      - A17 `doUpdateMenu`: already covered by #887's synchronous generation claim and post-snapshot lock re-check. Verify; no change expected.
      - A18 `UNLOCK_VAULT` (see C2).
- **Forbidden pattern:** `pattern: cachedEntries = |teamKeyCache\.set\(` outside the epoch-checked writer. Reason: an unchecked cache write is the A1/A3 defect.

### C2: `UNLOCK_VAULT` commits only for the state it started in

- Capture `vaultEpoch` and the current token (or `connectionGeneration`) at entry.
- Re-check both immediately before the first assignment to key state, and again before the ECDH unwrap result is assigned. On a mismatch, abort with `VAULT_LOCKED` and assign nothing.
- `currentVaultSecretKeyHex` is assigned only once the passphrase has been verified.
- **Control class:** `fail-closed verification gate`.

### C3: team-key retry key (FR4)

- The retry in `decryptTeamOverviews` deletes the same key format that `getTeamEncryptionKey` writes.
- A single helper builds the key, so the two cannot drift apart again.

## Testing strategy

- **Harness:** in `background.test.ts` (and the login-save / passkey test files), each member gets one test. The test holds the member's first await on a deferred promise (a fetch, decrypt or sign mock), sends `LOCK_VAULT`, releases the promise, and asserts all three of:
  1. the sink was not reached (no `sendMessage` / clipboard / POST / `teamKeyCache` entry / cache entry, no signature);
  2. the response is the locked shape;
  3. a lock → unlock → stale-release variant also denies.
- **Positive control:** the same harness without the lock reaches the sink (RT8 / RT10).
- **Red-proof:** remove each member's `assertVaultEpoch` on a scratch copy and confirm its test goes red.
- **C2:** lock during each unlock await, token change during an unlock, and a wrong passphrase leaves `currentVaultSecretKeyHex` null.
- **C3:** a team-key rotation retry deletes the stored key (spy on the map).
- **Full run:** `cd extension && npx vitest run` (with a seed sweep), `npx tsc --noEmit -p .`, `npm run build`, `scripts/pre-pr.sh`.

## Scope contract

- **SC1:** `#884` (hidden-field fill) and `#886` (focus-scoped fill) are the next PR.
- **SC2:** `#878` (removing the direct-autofill twin) is out of scope.
- **SC3:** content-side consumers (the dropdown, the popup UI) are unchanged, apart from receiving `VAULT_LOCKED` where they used to receive data.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | vault epoch + member-set coverage | pending |
| C2 | unlock commits only for its starting state | pending |
| C3 | team-key retry key | pending |

## Round-1 review decisions (supersede the sections above where they differ)

Plan review round 1 had three reviewers. The functionality and security reviewers converged on every design point. All findings are folded in here; Phase 2 implements from this section.

- **D1. Leaf module.** `extension/src/background/vault-epoch.ts` holds the epoch primitive, so `login-save` and `passkey-provider` can import it without an import cycle. It contains:
  - the counter, with `bumpVaultEpoch()` and `currentVaultEpoch()`;
  - `VaultLockedError` (message `VAULT_LOCKED`, so `normalizeErrorCode` passes it through);
  - `assertVaultEpoch(epoch)`.
- **D2. Epoch moves on every key-state or connection change.** The bump happens in:
  - `clearVault()`;
  - every `connectionGeneration` increment;
  - `discardRestoredSession()`.

  The catch arms of `hydrateFromSession` (DPoP, derive, ECDH) return early when `hydrationSuperseded` is set, so they never clear live state. With these bumps, C2 needs only the epoch; a token comparison is dropped because a refresh rotates the token within one connection.
- **D3. Sinks that await internally own the check.**
  - `swFetch(path, init, { epoch })` asserts after its internal awaits, immediately before each authenticated send, including both 401 retries. Every non-GET call from a member passes its epoch.
  - `copyToClipboard(text, epoch)` asserts after `ensureOffscreen`.
- **D4. Multi-step sinks check each step.**
  - **Autofill delivery:** inside each `resendUntilReceived` send thunk, before each direct `executeScript`, and before the TOTP copy.
  - **Signing:** before `signAssertion`, before the PUT (via D3), and before returning the signature. A signature is a credential, so it is denied after a lock.
  - **Passkey create:** before the POST (via D3).
- **D5. Post-commit policy.** Once a server write has committed, a non-secret result (`ok`, entry id, attestation / public key) is still returned. Only a following destructive write is skipped when stale, i.e. the passkey replace-DELETE. This avoids duplicate saves and duplicate passkeys.
- **D6. Locked mapping.** Every catch arm that would turn `VaultLockedError` into "no entries" or a non-locked code checks `instanceof VaultLockedError` first and returns the path's locked shape. The arms:
  - GET_(CC_/IDENTITY_)MATCHES_FOR_URL;
  - passkey get-matches and the duplicate check;
  - COPY_PASSWORD and COPY_TOTP;
  - FETCH_PASSWORDS;
  - the performAutofill inner catches;
  - the `allSettled` aggregation in `getCachedSnapshot` (the epoch is asserted after `allSettled`, before the cache write);
  - `fetchAllTeamEntries`;
  - the context menu (the locked item).

  `getCachedSnapshot` throws `VaultLockedError` when it starts locked, and the locked early-`[]` returns of `decryptOverviews` / `fetchAllTeamEntries` throw instead.
- **D7. Members added by the review:**
  - `registerActivity`, the alarm re-arm in `hydrateFromSession`, and the `UNLOCK_VAULT` tail. The vault-lock alarm and keepalive are sinks.
  - `recordUnlockPresence`, which takes the unlock's epoch.
  - `updateBadgeForTab`, which must not set a per-host count after a lock.
  - The UNLOCK ECDH catch arm, which must not null the next unlock's state.
  - `secretKey.fill(0)` on every new abort path.
- **D8. C3.** The team-key cache key comes from one helper that takes the userId captured at the operation's start.
- **D9. Tests** (testing review F1–F9):
  - **Hold point:** hold the last await before each sink (e.g. the overview / blob `decryptData`, `deriveTeamEncryptionKey`, the `executeScript` probe, `signAssertion`). Use member-unique ciphertexts, and use one-shot holds armed after `settleMenu()`.
  - **Assertions:** assert on observable proxies. These include fetch counts, `CHECK_PENDING_SAVE`, `persistSession` (with `STATIC_TEST_JKT`), clipboard messages carrying the secret, `executeScript` args, and the returned signature or PUT.
  - **Harness per member:** team members in `team-entries.test.ts`; A9 in `background-commands.test.ts`; the unit files use a mutable fake epoch, plus one index-level wiring test per deps module.
  - **Shared helper:** `helpers/deferred.ts` provides the shared hold helpers.
  - **C2 tests:** a reconnect mid-unlock denies; a refresh mid-unlock still commits.
  - **Red-proof:** remove one assert site at a time.
