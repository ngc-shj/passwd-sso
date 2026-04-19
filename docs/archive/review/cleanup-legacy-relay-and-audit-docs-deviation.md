# Coding Deviation Log: cleanup-legacy-relay-and-audit-docs
Created: 2026-04-19

## Deviations from Plan

No code-level deviations. The implementation followed the plan §Implementation Checklist exactly:

- B1 (commit 3c4bcbdd, Steps 2–4 / F1–F3): 8 files modified as listed; 3 ported guard tests use the bridge-code shape and the test names specified by Round 2 T5 fix.
- B2 (commit 90b6632a, Steps 6–8 / F5/F6/F7): 3 files modified — `docs/security/threat-model.md` §5 bullet 3 rewritten to "Audit pipeline (durable outbox)"; `docs/security/security-review.md` §5 subsection rewritten to cite `audit_outbox` + `audit-chain` + `src/workers/audit-delivery.ts` (full path) + `lastError` METADATA_BLOCKLIST-bypass note + WORM disclaimer; `src/lib/audit-logger.ts` line 90 comment fixed to "or whose tenantId could not be resolved".
- B3 (commit 2f903cc3, Step 5 / F4): `docs/architecture/extension-token-bridge.md` 3 sites edited — validation-checks-table row, file-map-table row, Migration period subsection (renamed to Migration status). One-sentence note added immediately after the threat-model attack-vector table per Round 2 F2 fix placement directive.
- B4 (commit fe642b2a, Steps 9–10 / F8/F9): `src/lib/constants/app.ts` NIL_UUID JSDoc replaced (preserved RFC 4122 §4.1.7 first line per Round 2 F8 fix; added Note + Primary/Secondary use cases + structural-impossibility invariant + FK-transitivity + MUST NOT prescription + TODO(actorId-rename) marker); `prisma/schema.prisma` AuditLog.userId got `///` comment block + TODO marker; `src/lib/audit.ts` AuditLogParams.userId got JSDoc + TODO marker. All three TODO markers grep-able.
- B5 (commit b6f9eb93, Step 11 / F10): `src/app/api/mcp/token/route.ts:125` changed `userId: NIL_UUID` → `userId: resolveAuditUserId(null, "system")` + added `actorType: ACTOR_TYPE.SYSTEM`; `NIL_UUID` removed from import (line 12). Test extended at `route.test.ts:272-278` with `userId: SYSTEM_ACTOR_ID` and `actorType: "SYSTEM"` assertions; no import edit needed (already present at line 38 per Round 4 T-F10-1 fix).

## Notes (informational, not deviations)

- The extension test file `extension/src/__tests__/content/token-bridge.test.ts` ended up with 11 tests (8 bridge-code + 3 ported guards), down from 15 (8 bridge-code + 7 legacy). This matches the Round 2 T4-corrected count math.
- B2 implementation of the security-review.md rewrite included the phrase "Splunk HEC" in the AuditDeliverer concrete-deliverer list. This is a minor wording precision — the underlying enum is `SIEM_HEC` (Splunk's HTTP Event Collector protocol, also used by other SIEM products that adopted it). Not flagged as a deviation since the substantive claim (HEC delivery is supported) is correct; if Phase 3 code review flags it, it can be reworded to a generic "HEC" or "SIEM HEC" without behavioural impact.
- All 5 implementation commits use the conventional-commit prefix consistent with the plan §Implementation Checklist Commit Grouping section (refactor: / docs: / fix:). release-please will classify them correctly.

## Verification status (Phase 2 Step 2-4)

- `bash scripts/pre-pr.sh` — **9/9 checks passed** (e2e-selectors / lint / team-auth-rls / bypass-rls / crypto-domains / migration-drift / no-deprecated-logAudit / test / build).
- Web-app vitest: 7195 / 7195 tests passed across 567 files.
- Extension vitest: 659 / 659 tests passed across 42 files.
- `npx next build`: compiled successfully in 8.2s.
- `bash ~/.claude/hooks/check-migrations.sh`: no pending Prisma migrations.

### Pre-existing lint warning (Adjacent / out-of-scope)

- `scripts/manual-tests/share-access-audit.ts:1:1` — `Unused eslint-disable directive (no problems were reported from 'no-console')`. Verified pre-existing on `main` (the same warning appears when checking out `main` and running `npm run lint`); the file is NOT in `git diff main...HEAD`. ESLint exits 0 (warning, not error) so `pre-pr.sh` "Lint" step still passes. [Adjacent] — pre-existing in unchanged file; cleanup belongs in a separate sweep PR. Not flagged as a deviation since it does not affect this PR's verification status.
