# Code Review: verify-rls-predicate
Date: 2026-05-04
Review rounds: 2 (converged after fixing pre-pr.sh shell-quoting bug)

## Changes from Previous Round

Round 2 verified the Round 1 fixes and surfaced one Major issue (pre-pr.sh awk quoting) which was then fixed and re-verified.

## Functionality Findings (Round 1)

### F1 [Minor]: Negative-test header doesn't document seed prerequisite
- File: `scripts/rls-cross-tenant-negative-test.sh:1-30`
- Problem: Cases 0/4 invoke the full verify SQL which expects all 53 manifest tables seeded — running the script directly without seed produces confusing "FAIL case 0/4" output pointing at unrelated tables.
- Fix: Added explicit prerequisite paragraph to the script header (lines 32-36).

### F2 [Minor — DEFERRED]: Seed file not idempotent on re-run
- File: `scripts/rls-cross-tenant-seed.sql:57-59`
- Status: Not addressed — CI fresh DB per job; local re-runs use `prisma migrate reset` (already documented in plan §Manual test plan).
- Anti-Deferral check: acceptable risk
  - Worst case: confused developer error message on local re-run
  - Likelihood: low (documented workflow)
  - Cost to fix: ~5 lines + risk of `ON CONFLICT` masking real seed errors elsewhere

### F3 [Minor]: Coverage `%s` vs verify `%L` inconsistency
- File: `scripts/rls-cross-tenant-coverage.sql:50`
- Problem: ASSERT message uses `%s` while verify.sql:244,303,376 use `%L` for the same purpose
- Fix: Changed `%s` → `%L` for consistency

## Security Findings (Round 1)

**No findings.** The Security expert confirmed:
- `format('%I', t)` correctly identifier-quotes; `t` is sourced from `pg_class.relname` (trusted) + defensive regex assertion
- Block 4's `filter_clause` mixes `%I`/`%L` only with hardcoded UUID literals; documented as constants-only
- Privilege boundaries explicitly asserted in Block 1
- Negative test uses `set -euo pipefail` + trap-based cleanup
- `app.bypass_rls` soft-GUC limitation pre-existing; documented in SQL comment + tracked as follow-up
- No PII / secrets in committed artifacts

## Testing Findings

### T1 [Major]: Negative test coverage gap (Round 1)
- File: `scripts/rls-cross-tenant-negative-test.sh:139-177`
- Problem: Negative test covered only 5 of 8 stable error codes — `[E-RLS-COLPARITY]`, `[E-RLS-DISCOVER]`, `[E-RLS-MANIFEST-EXTRA]`, `[E-RLS-COUNT-B]` not exercised
- Fix: Added Case 6 (`[E-RLS-MANIFEST-EXTRA]`) and Case 7 (`[E-RLS-COLPARITY]`). Coverage gaps for `COUNT-B` (mirrors `COUNT-A`), `DISCOVER` (requires fragile catalog REVOKE), and `ROLE` (runner-role cannot self-test) explicitly documented in script header.

### T2 [Major]: pre-pr.sh stub validation scope (Round 1) + awk-quoting bug (Round 2)
- File: `scripts/pre-pr.sh:42-58`
- Problem (R1): Original `expected_tables=users` stub caused early-exit at Block 1 manifest assertion, leaving Blocks 2-5 unvalidated
- Fix (R1 → R2 attempt): Use full manifest from `scripts/rls-cross-tenant-tables.manifest`; accept `[E-RLS-*]` codes as parse-OK
- Problem (R2): The awk pipeline had broken `\\$1` quoting under `bash -c '...'` — bash interpreted `\$1` as the empty positional arg, awk crashed silently, `EXPECTED_TABLES` was empty, the broad regex masked the failure
- Fix (R2): Replaced awk with `sed -E "/^#/d; /^[[:space:]]*$/d; s/^[[:space:]]+//; s/[[:space:]]+$//"` — no `$`-ambiguity inside `bash -c`. Tightened the regex to a whitelist of canonical `[E-RLS-*]` codes (prevents typo-codes from being silently accepted).

### T3-T5 [Minor — DEFERRED]
- T3: Indirect-detection signal quality for vacuous mutations — acceptable; mutations ARE caught indirectly via Case 0 calibration mismatch
- T4: Block 2 + Block 3 coupled coverage — Block 3 mirrors Block 2 by design
- T5: Local-dev cleanup ergonomics — already idempotent via `DROP TABLE IF EXISTS` in setup heredoc

## Adjacent Findings

- Functionality expert noted no [Adjacent] findings for security or testing.
- Security expert had no findings, no [Adjacent].
- Testing expert had no [Adjacent] findings.

## Quality Warnings

None — no findings flagged for VAGUE / NO-EVIDENCE / UNTESTED-CLAIM. All findings include file:line references and concrete evidence from empirical verification.

## Recurring Issue Check

### Functionality expert
- R1 (DRY): OK — discovery query duplicated 5× across blocks; extracting would force temp view as passwd_app (deferred per plan)
- R2 (KISS): OK
- R3 (YAGNI): OK
- R5/R9 (transaction boundaries): OK — file header forbids BEGIN/COMMIT and `--single-transaction`; SET LOCAL scoping verified empirically
- R10 N/A
- R14 (DB role grants): OK — re-grants DML to passwd_app (matches existing pattern)
- R15 (hardcoded env values): OK — CI-only credentials
- R16 (dev/CI parity): OK — local docker exec sequence matches CI step order
- R20 (mechanical edits in structured constructs): OK — ci.yml insertion at correct rls-smoke job position
- R21 (sub-agent verification): OK — re-ran full pipeline empirically against passwd-sso-db-1
- R30 (schema drift): OK — manifest equality vs discovery enforced
- R31 (destructive ops): OK — seed runs as passwd_user (intended); negative-test trap-based DROP works
- R32 (runtime-shape boot test): OK — the new SQL/shell IS the runtime boot
- R33 (CI cross-config propagation): OK — `app` filter already covers `scripts/**`
- R34 (existing test reuse): OK — existing `rls-smoke-{seed,verify}.sql` are unmodified
- R35 (manual-test for deployed components): OK — manual test plan inlined in the plan
- R36: N/A

### Security expert
- R1-R30: OK or N/A (CI/SQL-only, no app code)
- R31: OK — DROP TABLE IF EXISTS targeted, ephemeral CI Postgres
- R32-R36: N/A
- RS1-RS3: OK (input validation at boundaries; no injection vectors)
- RS4: OK — UUIDs are deterministic test sentinels (`...A0`/`...B0`); emails use reserved `.test.local` TLD per RFC 6761

### Testing expert
- R1-R31: OK or N/A
- R32 (runtime-shape boot test): SATISFIED — verify IS a real-DB runtime test
- R33 (CI cross-config propagation): SATISFIED — single rls-smoke job
- R34: N/A
- R35 (manual test plan): SATISFIED — inlined in plan
- R36: N/A
- RT1 (mock-reality divergence): SATISFIED — no mocks; real Postgres
- RT2 (testability): SATISFIED — every assertion reachable in psql + DO blocks. After R2 fixes, all 8 negative-test cases (0-7) exercise distinct stable error codes
- RT3 (shared constants in tests): DEFERRED per plan T23 — UUIDs `...A0`/`...B0` duplicated across 4 files; tracked as follow-up

## Resolution Status

### F1 [Minor] Negative-test header doesn't document seed prerequisite — RESOLVED
- Action: Added "Prerequisite" paragraph to script header
- Modified file: `scripts/rls-cross-tenant-negative-test.sh:32-36`

### F2 [Minor] Seed not idempotent — DEFERRED (acceptable risk)
- Anti-Deferral check: acceptable risk
- Justification:
  - Worst case: confusing local re-run error
  - Likelihood: low (documented workflow uses `prisma migrate reset`)
  - Cost to fix: ~5 lines + risk of `ON CONFLICT` masking real seed errors
- Orchestrator sign-off: Anti-Deferral §3 satisfied (acceptable risk with quantified tradeoff)

### F3 [Minor] Coverage `%s` vs verify `%L` — RESOLVED
- Action: Changed `%s` → `%L` for consistency with verify.sql
- Modified file: `scripts/rls-cross-tenant-coverage.sql:50`

### T1 [Major] Negative test coverage gap — RESOLVED
- Action: Added Case 6 (MANIFEST-EXTRA) and Case 7 (COLPARITY) with custom helpers; updated cleanup trap to drop `rls_colparity_probe`; documented uncovered codes (COUNT-B / DISCOVER / ROLE) in script header
- Modified file: `scripts/rls-cross-tenant-negative-test.sh` (header lines 33-44, cleanup function line 50, new functions lines 178-229)
- Verification: all 8 cases (0-7) PASS empirically against local docker DB

### T2 [Major] pre-pr.sh validation scope + awk-quoting bug — RESOLVED
- Action (R1→R2): Switched stub `expected_tables=users` to full manifest derived from the manifest file
- Action (R2 Major-1 fix): Replaced awk pipeline (which had broken `$1`-quoting under `bash -c '...'`) with sed; tightened broad regex to specific `[E-RLS-*]` whitelist
- Modified file: `scripts/pre-pr.sh:40-58`
- Verification: pre-pr.sh now correctly fires `[E-RLS-COUNT-A]` (Block 2 fail when no seed); whitelist regex matches; pre-pr.sh exits 0 with all 13 checks pass

### T3 [Minor] Indirect-detection signal quality — DEFERRED
- Anti-Deferral check: acceptable risk
- Justification:
  - Worst case: confusing failure attribution during regression
  - Likelihood: low (Case 0 calibration mismatches are unambiguous)
  - Cost to fix: 1 case + helper; not worth the additional complexity
- Orchestrator sign-off: acceptable

### T4 [Minor] Block 2/3 coupled coverage — DEFERRED
- Anti-Deferral check: acceptable risk
- Justification: Block 3 is a structural mirror of Block 2; a "Block 3 only" defect is mechanically unlikely. Adding a tenant-A-only negative case would double the test complexity for marginal coverage gain
- Orchestrator sign-off: acceptable

### T5 [Minor] Local-dev cleanup ergonomics — RESOLVED (already idempotent)
- Action: Setup heredoc already starts with `DROP TABLE IF EXISTS rls_negative_test CASCADE` so re-runs are idempotent. Verified by inspection
- No code change needed

## Convergence verdict

**READY TO MERGE.** All Critical/Major findings resolved. Three Minors deferred with explicit Anti-Deferral justification. Empirical verification:
- Seed → coverage → verify (full pipeline): all exit 0 against local docker DB
- Negative test: all 8 cases (0-7) PASS
- pre-pr.sh: 13/13 checks pass including the new `Static: rls-cross-tenant SQL parse`
