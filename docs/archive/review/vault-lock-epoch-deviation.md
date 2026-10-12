# Coding Deviation Log: vault-lock-epoch

## D1: `getVaultEpoch` dependency dropped
The plan (C1) put `getVaultEpoch` on `LoginSaveDeps` and `PasskeyProviderDeps`. The modules compared against the module-wide epoch (`assertVaultEpoch`) but captured through the dependency, so the two could disagree. `vault-epoch.ts` is a leaf module, so both modules now import `currentVaultEpoch` directly. The unit tests use the real module and simulate a lock with `bumpVaultEpoch()`.

## D2: guards covered by another guard on the same path

Removing one of these sites on its own leaves the tests green, because a second guard on the same path catches the case. Each group goes red when it is removed together. Sites are named by subject, because line numbers drift with every edit.

- The `fetchFreshEntries` epoch assert and the post-loop assert in `decryptOverviews` (pair).
- The `entriesForThisVault` recheck in `resolveInlineMatches`. `getCachedSnapshot` already throws on a stale epoch.
- The LOGIN resend catch recheck in `performAutofillForEntry`, and the `injectDirectAutofill` assert (pair).
- The recheck before the unserializable retry. The first `injectDirectAutofill` assert already throws.
- The asserts in `fetchAllTeamEntries` and `decryptTeamOverviews`, together with the `fetchFreshEntries` assert.
- The `fetchAndDecryptTeamBlob` return assert, together with `COPY_PASSWORD`'s own assert.
- The update-offer assert in `handleLoginDetected`. At index level, `getCachedEntries` throws first. On its own it goes red only in the unit test.
- The `clearToken` and `applyToken` epoch bumps. `clearVault`'s bump covers them on every path that clears key state.

### Defence in depth, not reachable by any test

- `getCachedSnapshot`'s `!encryptionKey` throw.
- `decryptOverviews`' throw-on-locked.
- `fetchAllTeamEntries`' throw-on-locked.
- The `encryptionKey !== null` half of `abandonCommittedUnlock`'s check. When a lock has already cleared the vault, the extra `clearVault()` it skips only re-nulls null state and bumps the epoch again, so no test can observe it.

Every caller checks `encryptionKey` synchronously before calling these. They are kept so that a future caller that skips that check still gets "locked" rather than `[]`.

The copy command's `VaultLockedError` swallow (no `warnBackground`) only changes logging.

## D3: swFetch 401-retry asserts
Both 401-retry asserts in `swFetch` (the token rotated by a concurrent refresh, and the near-expiry refresh) gained their own tests. The plan named both arms but listed no test for them.
