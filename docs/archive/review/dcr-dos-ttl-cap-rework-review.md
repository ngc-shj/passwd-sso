# Plan Review: dcr-dos-ttl-cap-rework

Date: 2026-06-11
Review round: 1

## Round 1

Approach (pivoted from the rejected IP-hash per-IP-cap): shorten unclaimed-DCR TTL 1h→15min + raise global cap 100→1000, no schema, no IP storage.

- **Security — approach validated, S1 [Major]**. Both experts confirmed this is clearly BETTER than per-IP cap: per-IP is defeated by IPv6 /64 rotation (a /48 = 65536 /64s) at a privacy cost; this attacks the harm-conversion (hard low shared 503 ceiling + long 1h hold window) instead. Arithmetic verified: cap 1000 ÷ (20/h × 15min = 5 per /64) = 200 sustained /64s to HOLD the pool — a real one-shot→sustained shift, honestly framed as a ~10× cost increase, not elimination (SC1 residual accurate). No new resource-exhaustion risk (1000 ephemeral rows negligible; @@unique([tenantId,name]) NULL-distinct so unclaimed rows don't collide; per-register COUNT trivial). No security regression from 15min (nothing depends on the 1h value; claimed rows set dcrExpiresAt=null). Privacy: clean win (zero IP stored). Better alternatives (remove cap / per-tenant reservation / soft cap) evaluated and rejected as worse. **S1 [Major]**: the 503 `error_description` "in the last hour" (register/route.ts:176) drifts with the TTL — register/route.ts is in-diff (R34), must fix. → added as C1.5.
- **Functionality + Testing — approach feasible, F1/T1/T2**. SEC_PER_MINUTE already imported; both constants used only at register/route.ts:134,150 + lazy-cleanup/worker (which compare dcrExpiresAt<now(), value-independent — no breakage). UX floor: 15min clears the human register→authorize→Allow consent flow for all supported flows (no flow decouples register from authorize by >15min). The dcr-cleanup-worker-sweep integration test seeds explicit timestamps + imports MAX_UNCLAIMED_DCR_CLIENTS → auto-follows. **F1 [Major]** = S1 (503 message). **T1 [Major]**: the route.test.ts:321 "1-hour window" comment + assertion need updating with F1. **T2 [Minor]**: the integration cap test loops MAX individual INSERTs → 10× slower at 1000; refactor to bulk insert. **S3 [Info]**: worker interval (1h) > TTL (15min) is by design (lazy cleanup is primary).

## Resolution Status (Round 1)

S1/F1 → C1.5 (503 message time-window-independent + test comment). T1 → folded into C1.5. T2 → testing-strategy note (bulk insert). S3 → Considerations note. F2 → no finding (docs enumeration was correct). No skips. Plan review CLOSED; all contracts locked.
