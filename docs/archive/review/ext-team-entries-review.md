# Plan Review: ext-team-entries
Date: 2026-03-08T22:30:00+09:00
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Critical] Team API endpoints do not accept extension tokens — RESOLVED
- **Problem**: `/api/teams/*` endpoints use `auth()` (session-only), not `authOrToken()`
- **Impact**: All team API calls from extension would return 401
- **Resolution**: Added step to change team endpoints to `authOrToken()` and add `teams:read` scope

### F2 [Major] Team API response format differs from personal API — RESOLVED
- **Problem**: Team API returns flat fields (`encryptedOverview` string + `overviewIv` + `overviewAuthTag`), personal API returns nested object
- **Impact**: Decryption would fail if using same RawEntry type
- **Resolution**: Added `RawTeamEntry` type definition and normalization step to plan

### F3 [Major] Message types lack teamId for routing — RESOLVED
- **Problem**: `COPY_PASSWORD` etc. only have `entryId`, no way to route to team API
- **Impact**: Cannot distinguish personal vs team entries in handlers
- **Resolution**: Added `teamId?` to all action message types, popup passes it from DecryptedEntry

### F4 [Minor] keyVersion cache key mismatch — RESOLVED
- **Problem**: Cache keyed by `teamId` alone would miss key rotation
- **Impact**: Entries encrypted with new key version would fail to decrypt for up to 5 min
- **Resolution**: Changed cache key to `teamId:keyVersion`, added retry-on-failure strategy

## Security Findings

### S1 [Critical] Same as F1 — team API auth — RESOLVED (see F1)

### S2 [Major] secretKey hex string cannot be zero-cleared — ACKNOWLEDGED
- **Problem**: `currentVaultSecretKeyHex` is an immutable JS string in `chrome.storage.session`
- **Impact**: ECDH private key can be re-derived from persisted secret key
- **Resolution**: Documented as existing design constraint (same threat model as personal vault). Added to Considerations section.

### S3 [Minor] keyVersion cache invalidation on decryption failure — RESOLVED
- **Problem**: Stale cache key could cause silent decryption failures for up to TTL
- **Resolution**: Added NF6: invalidate cache and retry once on decryption failure

### S4 [Minor] Team fetch count limit clarification — RESOLVED
- **Problem**: "max 10 concurrent" was ambiguous (concurrency vs total count)
- **Resolution**: Clarified: max 10 teams total (truncate if more)

## Testing Findings

### T1 [Major] No crypto round-trip test plan — RESOLVED
- **Problem**: Only mock tests planned for crypto functions
- **Resolution**: Added round-trip tests using real Web Crypto API (ECDH wrap/unwrap, ItemKey wrap/unwrap, AAD cross-validation)

### T2 [Major] No test file split strategy — RESOLVED
- **Problem**: All team tests would go into already-large background.test.ts
- **Resolution**: Added separate `__tests__/background/team-entries.test.ts` file

### T3 [Major] No cache behavior tests — RESOLVED
- **Problem**: TTL expiry, LRU eviction, cache clearing untested
- **Resolution**: Added specific cache test cases with vi.useFakeTimers

### T4 [Minor] No ecdhPrivateKeyBytes zero-clear test — RESOLVED
- **Problem**: fill(0) not verified in tests
- **Resolution**: Added clearVault security test

### T5 [Minor] No popup tests for team badge and filter — RESOLVED
- **Problem**: Team badge rendering and SECURE_NOTE filtering untested
- **Resolution**: Added MatchList.test.tsx test cases
