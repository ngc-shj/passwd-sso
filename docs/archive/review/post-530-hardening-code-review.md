# Code Review: post-530-hardening

Date: 2026-06-11
Review round: 1

## Round 1 (on impl commit cf7b5881)

- **Functionality — No findings.** Verified: C2 three scrub points correctly placed/guarded (trace.op left alone, no double-processing); C3 migration SQL correct (current_database(), no hardcode, checksum clean) + the privilege-assertion test uses the right roles + DROP IF EXISTS/try-finally; C4 requiredForCompose affects ONLY REDIS_PASSWORD (.env.example diff is REDIS_PASSWORD-only, NOTE retained); C1 YAML valid; C5 afterEach fully removed. R14/R15/R16 clean (REVOKE touches only PUBLIC default; current_database(); CI bootstrap re-grants passwd_app CONNECT after migrate).
- **Security — No findings** (+ S1 [Info]). C3 availability re-verified independently: all 4 app/worker roles have explicit GRANT CONNECT, passwd_user/healthcheck is superuser, jackson connects to the jackson DB — no PUBLIC-dependent connector; the test proves the REVOKE took effect (probe FALSE, non-false-pass) and legit roles survive (4 TRUE). C2 covers all 3 token routes; redactCapabilityPaths not sanitizeUrl. No secret/PII committed. **S1 [Info]**: `event.tags` (Sentry auto-copies transaction→tags.transaction) was not scrubbed — same capability-URL class. → fixed.
- **Testing — No findings** (+ T1/T2 [Info]). C3 test is a real non-vacuous guard (reviewer empirically confirmed it FAILS if PUBLIC connect is restored); C2 fixtures red-able + non-breaking (reviewer confirmed only the 4 new cases fail pre-change); C4 assertions correct. The 4 failing integration tests confirmed unrelated (audit-anchor/sentinel/cache-rollback — pre-existing shared-DB noise, none connection-refused). T1 (flaky shared DB) / T2 (catalog-priv vs actual-connect — intentional) are Info, no fix.

## Resolution Status

- S1 [Info] → `e.tags` string values now pass `redactCapabilityPaths` (closes the transaction→tags.transaction auto-copy path); red-able test added. Fixed in the review commit.
- T1/T2 [Info] (shared-DB flakiness / catalog-vs-connect design) — accepted, no change (documented; CI fresh-DB is authoritative).

Code review CLOSED after 1 round: Functionality/Testing clean; Security 1 Info (fixed). No Major/Critical, no deferrals.
