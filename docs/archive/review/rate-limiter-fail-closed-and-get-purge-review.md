# Plan Review: rate-limiter-fail-closed-and-get-purge
Date: 2026-06-26
Review round: 1 (initial)

## Changes from Previous Round
Initial review. Three expert sub-agents (functionality / security / testing) reviewed the plan against the actual codebase.

## Functionality Findings
- **F1 (Major) — FIXED in plan**: C5 unused-import list was imprecise. `collectEntryAttachmentRefs` / `AttachmentBlobRef` in `team-password-service.ts` are STILL used by `deleteTeamPassword` and must be KEPT. Plan C5 now lists exact per-file import edits.
- **F2 (Minor) — recorded as risk**: removal assumes the `worker:retention-gc` process is deployed; without it, no trash auto-purge at all (storage growth only).
- **F3 (Minor) — recorded**: C4 fail-closed applies to the OAuth callback GET path too (in-flight login completion blocked during Redis outage). Within accepted trade-off.
- Verified clean: `checkRateLimitOrFail` accepts both `{limiter,key}` and `{result}` forms; C2 `[id]` local checkAuth swap preserves 401/403→429/503 ordering; breakglass existing SERVICE_UNAVAILABLE catch does not collide with new 503.

## Security Findings
- **S1 (Info)**: completeness confirmed — deferred limiters (scim-tokens, service-accounts, operator-tokens, reset-vault, mcp revokeAll, passwords list/create) are correctly EXCLUDED; each sits behind a session+admin or self-scoped auth gate, making fail-open an availability/self-harm concern, not a bypass. M1/M4/M5/M6 line drawn correctly.
- **S2 (Low) — recorded, confirm before close**: attachments upload limiter remains fail-open; acceptable if quota-bounded.
- **S3 (Medium design risk) — recorded in runbook note**: callback fail-closed makes Redis a hard dependency for SSO login (self-DoS on Redis flap). User accepted; ensure Redis HA.
- **S4/S6/S7 (Info, verified pass)**: `emitRateLimitFailClosed` is null-safe (pre-auth warn-only, no PII leak); C5 is a net security IMPROVEMENT (removes destructive GET + silent `.catch`); observability IMPROVED (worker emits atomic `TRASH_RETENTION_PURGED` audit vs old zero-audit purge).
- **S5 (Info)**: null-IP fail-open in `checkIpRateLimit` intentionally left unchanged — correct.
- No Critical findings → no escalation.

## Testing Findings
- **T1 (Major) — FIXED in plan**: autofill-token test has no rate-limit mock seam; must mock `@/lib/security/rate-limit-audit`.
- **T2 (Major) — FIXED in plan**: `withMagicLinkIpRateLimit` must be exported as `_withMagicLinkIpRateLimit` for testability.
- **T3 (Minor) — FIXED in plan**: corrected worker-coverage reference to `retention-gc-trash-purge.integration.test.ts` + `__tests__/sweep-trash.test.ts`.
- **T5 (Major) — FIXED in plan**: add executable "GET performs no deleteMany" regression guard; remove dead `deleteMany.mockResolvedValue` setup.
- **T6 (Minor) — recorded**: team GET route has no route test; read-only-ness is grep-enforced only.
- **T7/T8 (Minor) — FIXED in plan**: vacuous-test hardening (assert handler body did NOT run on 503); 429/redisErrored mapping owned by `rate-limit-audit.test.ts`; null-IP-proceeds test added.

## Resolution Status
All Major findings reflected in the plan. No Critical findings. Minor findings either reflected (T3, T5, T6, T7, T8) or recorded as risks/confirm-items (F2, F3, S2, S3). No blockers to Phase 2.

## Recurring Issue Check (consolidated)
- R1 (shared-util reuse): PASS — reuses `checkRateLimitOrFail` / `failClosedOnRedisError`.
- R3 (pattern propagation): PASS — fail-closed applied consistently to all 5 limiters; personal list/create limiters intentionally out of scope.
- R5 (transaction / no write on GET): PASS/IMPROVED — C5 removes `deleteMany` from GET.
- R17/R22 (helper adoption): PASS (with F1 import-precision fix).
- RT1/RT6 (vacuous tests / regression guard): FIXED via T5/T7 plan updates.
- Others: n/a.
