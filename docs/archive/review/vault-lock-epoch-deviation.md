# Coding Deviation Log: vault-lock-epoch

## D1: `getVaultEpoch` dependency dropped
The plan (C1) put `getVaultEpoch` on `LoginSaveDeps` and `PasskeyProviderDeps`. The modules compared against the module-wide epoch (`assertVaultEpoch`) but captured through the dependency, so the two could disagree. `vault-epoch.ts` is a leaf module, so both modules now import `currentVaultEpoch` directly. The unit tests use the real module and simulate a lock with `bumpVaultEpoch()`.

## D2: guards covered by another guard on the same path
Removing some assert sites on their own leaves the tests green, because a second guard on the same path catches the same case. Each group turns red when it is removed together, so none of the tests is vacuous. Source: the test author's red-proof runner.

| Path | Guards (index.ts unless noted) | Red-proof |
|------|--------------------------------|-----------|
| `fetchFreshEntries` / `decryptOverviews` | 399 / 1532 | pair |
| `resolveInlineMatches` recheck | 2398 | covered by `getCachedSnapshot` |
| LOGIN resend catch | 2085 | covered by another check on the path |
| direct-inject assert / its catch | 2252 / 2267 | pair |
| unserializable retry | 2294 | covered by another check on the path |
| unserializable retry | 2297 / 2267 | pair |
| `fetchAllTeamEntries` | 1736 / 1772 | with 399 |
| `fetchAndDecryptTeamBlob` | 1847 | with 2853 |
| login-save | 85 | index level only; red on its own in the unit test |

## D3: swFetch 401-retry asserts
Both 401-retry asserts in `swFetch` (the token rotated by a concurrent refresh, and the near-expiry refresh) gained their own tests. The plan named both arms but listed no test for them.
