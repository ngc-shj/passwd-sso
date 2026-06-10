# Code Review: passwords-concurrency-v1-consistency

Date: 2026-06-11
Review round: 2 (cumulative)

## Round 1 (on impl commit d78c8bf7)

- **Functionality F1 [Minor]** the FOR UPDATE snapshot read can return 0 rows if the entry is deleted between the early `existing`/`existingEntry` read and the lock → `cur` undefined → unhandled 500. (No regression — pre-fix the same race hit P2025/500 — but a 500→404 improvement worth making.) → fixed.
- **Security — No findings.** Verified: `${id}/${passwordId}/${teamId}::uuid` are bound params (no SQLi, no $queryRawUnsafe); the raw SELECT...FOR UPDATE runs under RLS (tenant GUC + FORCE ROW LEVEL SECURITY + all-command policy) so it cannot lock/read another tenant's row; team adds the `team_id` predicate; no lock-wait existence oracle (early 404 gate precedes the lock); snapshot-from-`cur` changes no authz decision (early `existing` stays authoritative for ownership/404); C2 actually enforces tenant IP restriction on the SA path and actorType=SERVICE_ACCOUNT does not bypass enforcement; C2 is correctly scoped to vault/status (v1 passwords routes reject SA tokens outright); C3 Set cannot smuggle an unowned tag; C4 throttle never touches the validity decision and lastUsedAt is display-only.
- **Testing T1 [Minor / RT3]** api-key.test hardcoded the throttle constant. → fixed. Verified the C1 integration race is real (50 iters, both outcomes observed, content guard {v0,firstWriter}/firstWriter!=v0 by blob value, exactly-2-rows, runs in ~1.3s — not vacuous); unit field-level + SQL-text guards genuine; R19 sibling mocks added without weakening; pre-existing 5 integration failures confirmed unrelated (different files, no causal path).

## Round 2 (on fix commit 44eeaf42)

- **Functionality — No findings.** F1 resolved: `if (!updated) return notFound()` fires ONLY on the blob-path delete-race (metadata path always resolves a truthy row or throws P2025, never falsy); team's `TeamPasswordServiceError(NOT_FOUND,404)` maps to 404 at the route catch; the v1 `beforeEach` mockQueryRaw reset is necessary (restores the default cleared by clearAllMocks call-history) and masks nothing.
- **Testing — No findings.** T1 resolved (constant imported, no residual hardcode). F1 tests red-able (removing the guard → all 3 fail with the TypeError, never reaching 404). Full suite green (905 files / 11214 tests). Minor note (not a finding): the v1 beforeEach commit comment slightly misstates why the reset is needed, but the line is correct and necessary.

## Resolution Status

### Round 1 — F1, T1 fixed in `44eeaf42` (no skips)
- F1 [Minor] → 404 not-found guard in all 3 handlers (`if (!cur) return null` + post-check 404 for personal/v1; throw NOT_FOUND/404 for team) + a delete-race unit test per handler (red-verified).
- T1 [Minor] → `import API_KEY_LAST_USED_THROTTLE_MS` in api-key.test.
- Security: No findings (Round 1); Round 2 changes are local correctness/test only, no security boundary touched → no re-review needed.

Code review CLOSED after 2 rounds: Round 1 — 1 Functionality + 1 Testing finding (both Minor); Round 2 — all clean. No deferrals.

## Environment Verification Report
- VE1 (concurrency lock proof, real Postgres): **verified-local** — the lost-update race test ran on the dev Postgres, 50 iterations, both outcomes + content guard held (`npm run test:integration` targeted run, 2/2 pass). Authoritative repeat is the CI integration job on a fresh DB.
- Other acceptance: verified-local (vitest 11214 green, pre-pr 32/32). The 5 unrelated integration failures are pre-existing shared-dev-DB noise (documented in the deviation log; same set as #530, reproduce on origin/main baseline).
