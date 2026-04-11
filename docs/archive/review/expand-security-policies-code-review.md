# Code Review: expand-security-policies
Date: 2026-04-11
Review rounds: 3

## Summary
109 files changed, +5422/-284 lines across 16 commits.

## Round 1 (initial)
F-01 invalidateLockoutThresholdCache: Resolved
F-03/S-02 cross-field validation bypass: Resolved (schema defaults)
S-01 timing-unsafe comparison: Resolved (XOR loop)
S-03 missing userId in audit: Resolved
C-01/C-02 missing tests: Resolved (23 new tests)

## Round 2
BUG-01 teamId not passed: Resolved
BUG-02 null writes to non-nullable: Resolved
F3 audit-emit rate limit: Resolved (20/min per user)
ISSUE-01 null IP blocking: Resolved

## Round 3 (final)
F3 confirmLockout type check: Resolved (typeof boolean validation)
Sec-F1 timingSafeEqual length leak: Resolved (scan all bytes)
Sec-F3 passkeyAuditEmitted unbounded: Resolved (max 1000 entries)
Test-F1 BYPASS_PURPOSE mock value: Resolved
Test-F2 extra maxSessionDurationMinutes: Resolved

## Low severity items (documented, not blocking)
- F1/F2: non-nullable null silent skip — intentional design
- F4: PASSKEY_ENFORCEMENT_BLOCKED scope TENANT — correct for admin visibility
- F5: requireRepromptForAll edit bypass — existing design pattern
- F6: sessionCache 30s TTL — documented trade-off
- Sec-F2: GET rate limit — admin-only endpoint
- Sec-F5: plaintext session tokens — existing TODO
