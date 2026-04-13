# Plan Review: durable-audit-outbox Phase 4
Date: 2026-04-13
Review round: 2

## Changes from Previous Round

### Round 1 → Round 2 changes
All 23 Round 1 findings (4 Critical, 11 Major, 8 Minor) were reflected in the plan.

### Round 2 findings (new)
- F-R2-F1 (Major): `from/to` date params role in chain walk unspecified → RESOLVED (partial walk with genesis hash from preceding row)
- F-R2-F2 (Minor): Pseudocode omits outbox SENT status update → RESOLVED (added to pseudocode)
- F-R2-F3 (Minor): `auditChainEnabled` flag read location → RESOLVED (read outside chain tx)
- F-R2-F4 (Minor): Genesis prev_hash "all-zero" ambiguity (1 byte vs 32) → RESOLVED (clarified as 1 byte)
- N-SEC-1 (Minor): lock_timeout on upsert → Acknowledged (negligible risk, doc note)
- N-SEC-2 (Minor): `to` param default → RESOLVED (addressed with F-R2-F1)
- N-SEC-3 (Minor): Genesis prev_hash length → RESOLVED (addressed with F-R2-F4)
- N-SEC-4 (Minor): logAudit vs logAuditInTx in verify → RESOLVED (logAudit specified, migration prohibited)
- T-R2-N1 (Major): Barrier placement in ordering test → RESOLVED (placed before SELECT FOR UPDATE)
- T-R2-N2 (Major): Empty chain test case → RESOLVED (added to verify integration test)
- T-R2-N3 (Major): Gap detection test INSERT role → RESOLVED (passwd_user SUPERUSER specified)
- T-R2-N4 (Minor): RT3 annotation scope → RESOLVED (clarified)
- T-R2-N5 (Minor): Disabled test anchor non-creation → RESOLVED (assertion added)

## Merged/Deduplicated Findings

The following findings were reported by multiple experts and merged:
- F-P4-M1 + F-SEC-3 + T9 → **F1** (Worker grants for `audit_chain_anchors`)
- F-P4-M2 + F-SEC-4 + T3 → **F2** (Anchor row initialization undefined)
- F-SEC-7 + T8 → **F9** (chain_seq gap detection)

---

## Functionality Findings

### F1 Critical: `ON CONFLICT DO NOTHING` + anchor UPDATE causes chain breakage on reprocessing

- **Problem**: When a reaper resets a PROCESSING outbox row back to PENDING, the reprocessed row triggers `INSERT INTO audit_logs ... ON CONFLICT (outbox_id) DO NOTHING` (0 rows inserted), but the anchor `UPDATE audit_chain_anchors SET chain_seq = new_seq, prev_hash = event_hash` still executes. This advances `chain_seq` and `prev_hash` without a corresponding audit_logs row, creating a permanent gap in the chain.
- **Impact**: Any PROCESSING timeout on a chain-enabled tenant permanently corrupts the chain. The verify endpoint would report all subsequent rows as tampered.
- **Recommended action**: Within the chain insertion transaction, check the INSERT return value (`INSERT ... RETURNING id`). If 0 rows inserted (conflict), skip the anchor UPDATE and rollback. Alternatively, use `INSERT ... ON CONFLICT DO NOTHING RETURNING id` and only proceed with anchor update if a row was returned.

### F2 Critical: `AUDIT_CHAIN_VERIFY` action not registered in constants/schema/i18n/groups (R12)

- **Problem**: The verify endpoint must call `logAudit()` (following existing admin endpoint patterns like `AUDIT_OUTBOX_METRICS_VIEW`), but Phase 4 defines no audit action constant for this operation. The following files need updates:
  - `prisma/schema.prisma`: `enum AuditAction` — add `AUDIT_CHAIN_VERIFY`
  - `src/lib/constants/audit.ts`: `AUDIT_ACTION`, `AUDIT_ACTION_VALUES`
  - `src/lib/constants/audit.ts`: `AUDIT_ACTION_GROUPS_TENANT[MAINTENANCE]`
  - `WEBHOOK_DISPATCH_SUPPRESS` (maintenance action)
  - `messages/en/AuditLog.json` and `messages/ja/AuditLog.json`
- **Impact**: Build fails (`satisfies Record<AuditAction, AuditAction>`), i18n shows missing key, `audit.test.ts` exhaustive test fails.
- **Recommended action**: Add `AUDIT_CHAIN_VERIFY` to all required locations in Steps 25/28.

### F3 Major: Worker grants missing for `audit_chain_anchors` (R14) [merged: F-P4-M1 + F-SEC-3 + T9]

- **Problem**: `passwd_outbox_worker` role needs `GRANT SELECT, UPDATE ON TABLE "audit_chain_anchors"` but the plan does not include this in the Phase 4 migration. Additionally, if the worker creates the initial anchor row (see F4), `INSERT` is also needed.
- **Impact**: Worker gets `permission denied for table audit_chain_anchors` on all chain-enabled tenants, causing all outbox rows to fail/dead-letter.
- **Recommended action**: Add to Phase 4 migration. Update `audit-outbox-worker-role.integration.test.ts` expected grant set.

### F4 Major: Anchor row initialization timing undefined [merged: F-P4-M2 + F-SEC-4 + T3]

- **Problem**: The plan does not specify when/how the `audit_chain_anchors` row is created for a tenant. When `auditChainEnabled` is set to true, the first event's `SELECT ... FOR UPDATE` returns 0 rows. The subsequent `UPDATE` silently affects 0 rows, leaving the anchor uncreated while chain columns are written to `audit_logs`.
- **Impact**: First chain-enabled event produces invalid chain state. Race condition if multiple workers attempt to create the anchor simultaneously.
- **Recommended action**: Define anchor initialization strategy. Recommended: worker does `INSERT INTO audit_chain_anchors (...) VALUES ($1, 0, '\x00') ON CONFLICT (tenant_id) DO NOTHING` before `SELECT ... FOR UPDATE`. This requires `INSERT` grant on the table.

### F5 Major: Verify scan during concurrent insertion produces inconsistent results

- **Problem**: During the 10,000-row paginated scan, the worker may insert new chain rows for the same tenant. The verify endpoint's view changes mid-scan, potentially reporting OK for a partial chain.
- **Impact**: Verify cannot guarantee completeness. An attacker could time modifications during a verify scan.
- **Recommended action**: At request start, capture `anchor.chain_seq` as the upper bound. Scan only `WHERE chain_seq <= captured_max`. Document that verify covers the chain snapshot at request time.

### F6 Major: `writeDirectAuditLog` rows have `chain_seq = NULL` — verify scan must filter

- **Problem**: SYSTEM-actor meta-events (`AUDIT_OUTBOX_REAPED`, `AUDIT_OUTBOX_DEAD_LETTER`, etc.) are written directly to `audit_logs` without chain columns. If the verify endpoint scans all rows without filtering, NULL chain_seq rows disrupt the sequential walk.
- **Impact**: False positive tamper detection on chain-enabled tenants with any direct-write audit events.
- **Recommended action**: Specify that verify endpoint uses `WHERE chain_seq IS NOT NULL ORDER BY chain_seq` for the chain walk. Document that direct-write rows are outside the chain scope.

---

## Security Findings

### S1 Major: RLS `WITH CHECK` clause missing on `audit_chain_anchors`

- **Problem**: Plan mentions `USING` clause for the RLS policy but does not explicitly require `WITH CHECK`. Existing patterns (`audit_outbox`, `audit_delivery_targets`) include both `USING` and `WITH CHECK`. While `USING` prevents reading cross-tenant rows (which in practice also prevents UPDATE of invisible rows), explicit `WITH CHECK` is a defense-in-depth requirement per project conventions.
- **Impact**: Inconsistency with existing RLS patterns; potential write bypass in edge cases.
- **Recommended action**: Explicitly add `WITH CHECK` matching the `USING` clause in Step 25 migration specification.

### S2 Major: `FOR UPDATE` lock contention — no `lock_timeout` protection

- **Problem**: The chain insertion transaction acquires `FOR UPDATE` on the anchor row. There is no `lock_timeout` configured. If the verify endpoint or a slow transaction holds the lock, other chain insertions for that tenant block indefinitely. With `max: 5` connection pool, a few stuck tenants can exhaust the pool.
- **Impact**: Tenant-level DoS affecting audit log delivery for all tenants sharing the worker.
- **Recommended action**: Set `lock_timeout` (e.g., 5000ms) within the chain insertion transaction. If lock acquisition fails, treat as a transient error and retry via normal backoff. Consider per-tenant batch limits per poll cycle.

### S3 Minor: Verify endpoint may expose internal hash values

- **Problem**: The verify endpoint response may include raw `event_hash`, `prev_hash`, `chain_seq` values. An attacker with admin token access could study the chain structure to craft more sophisticated tampering.
- **Impact**: Limited — requires admin token. But tamper-evidence design benefits from minimizing exposed internals.
- **Recommended action**: Response should report only `{ok: boolean, firstTamperedSeq?: number, totalVerified: number}`. Do not include raw hashes.

### S4 Minor: `z.coerce.date()` lacks range boundaries

- **Problem**: `from/to` query params accept any parseable date including extreme values. A single request with `from=1970-01-01` and no `to` could scan the entire chain history.
- **Impact**: Mitigated by 10k row pagination cap and 3/min rate limit, but unnecessary load.
- **Recommended action**: Add `.min()` and `.max()` constraints (e.g., past 5 years max). Validate `from < to`.

### S5 Minor: JCS canonicalization — BigInt and timestamp precision risks

- **Problem**: `chain_seq` is `BigInt` — `JSON.stringify(BigInt)` throws `TypeError`. `created_at` timezone representation (`Z` vs `+00:00`) must be normalized. JCS spec (RFC 8785) requires IEEE 754 number serialization, which loses precision for `BigInt > 2^53`.
- **Impact**: Implementation bug could corrupt all chain hashes. Design-level, not a vulnerability, but must be specified.
- **Recommended action**: Specify in Step 26 that `chain_seq` is serialized as a string (`"12345"`) in the canonical form. `created_at` must be normalized to UTC ISO 8601 with `Z` suffix before canonicalization.

---

## Testing Findings

### T1 Critical: Integration test CI infrastructure missing (pre-existing)

- **Problem**: `vitest.integration.config.ts` lacks `poolOptions: { forks: { singleFork: true } }` (required by plan T20 fix). No `audit-outbox-integration` CI job exists in `.github/workflows/ci.yml`. Phase 4 tests cannot run in CI.
- **Impact**: All integration tests (Phase 1-4) are CI-invisible. Chain concurrency tests with `FOR UPDATE` are especially sensitive to parallel execution.
- **Recommended action**: Add `singleFork: true` to `vitest.integration.config.ts`. Add CI job to `ci.yml` following existing `rls-smoke` job pattern. This is a prerequisite for Phase 4.

### T2 Critical: No test for verify endpoint (auth, validation, pagination)

- **Problem**: The three planned tests verify chain insertion behavior but not the verify endpoint itself. Phase 2 established a two-test pattern (`*.test.ts` mocked + `*.integration.test.ts` real DB) for admin endpoints. Phase 4 has no equivalent.
- **Impact**: Endpoint auth bypass, Zod validation errors, pagination cap enforcement go untested.
- **Recommended action**: Add `audit-chain-verify-endpoint.test.ts` (mocked: verifyAdminToken, Zod rejection, rate limit) and `audit-chain-verify-endpoint.integration.test.ts` (real DB: OK response for valid chain, tamper detection response).

### T3 Major: No canonicalization unit test

- **Problem**: `audit-chain.ts` canonicalization function has no planned unit test. The hash chain's correctness depends entirely on deterministic canonicalization. Integration tests validate end-to-end but cannot pinpoint canonicalization bugs (field ordering, encoding, NULL handling, BigInt serialization).
- **Impact**: Canonicalization implementation error could cause false negatives in tamper detection.
- **Recommended action**: Add `audit-chain.unit.test.ts` with fixed test vectors: known inputs → expected SHA-256 outputs. Cover: initial `prev_hash` (all-zero), normal values, `created_at` timezone normalization, `chain_seq` as BigInt.

### T4 Major: No negative test for `auditChainEnabled = false`

- **Problem**: No test verifies that chain columns (`chain_seq`, `event_hash`, `prev_hash`) remain `NULL` for tenants with `auditChainEnabled = false` (the default).
- **Impact**: A flag-checking bug could write chain columns for all tenants, creating inconsistent chains.
- **Recommended action**: Add `audit-chain-disabled.integration.test.ts`: process outbox row for `auditChainEnabled = false` tenant → assert `chain_seq IS NULL` in resulting `audit_logs` row.

### T5 Major: No RLS test for `audit_chain_anchors`

- **Problem**: Phase 1 has `audit-outbox-rls.integration.test.ts`, Phase 3 has `audit-delivery-rls.integration.test.ts`, but Phase 4 has no RLS test for `audit_chain_anchors`.
- **Impact**: Cross-tenant anchor access could go undetected.
- **Recommended action**: Add `audit-chain-rls.integration.test.ts`: (a) `passwd_app` cannot SELECT/UPDATE cross-tenant anchor, (b) `passwd_user` without bypass GUC cannot see cross-tenant anchor (FORCE RLS check).

### T6 Major: Concurrent ordering test design needs specification

- **Problem**: `audit-chain-ordering.integration.test.ts` says "two-Prisma-client + Deferred barrier" but doesn't specify the exact concurrency sequence. Sequential insertion with two clients doesn't verify `FOR UPDATE` serialization — both clients must reach `SELECT ... FOR UPDATE` concurrently.
- **Impact**: Test may pass vacuously without proving concurrent safety.
- **Recommended action**: Specify: Client A and Client B both execute `BEGIN; SELECT ... FOR UPDATE` via `Promise.all` with a Deferred barrier. Client A commits first, Client B then acquires the lock and commits. Assert `chain_seq` values are `(1, 2)` with no gaps or duplicates.

### T7 Major: chain_seq gap detection test missing

- **Problem**: No test verifies that the verify endpoint detects gaps in `chain_seq` (e.g., seq 1, 2, 4 with 3 missing). This is distinct from hash tampering.
- **Impact**: Row deletion followed by re-insertion with corrected hashes could go undetected if gaps aren't checked.
- **Recommended action**: Add gap detection to `audit-chain-tamper-detection.integration.test.ts` or as a separate test: directly INSERT rows with a gap, then verify endpoint reports the gap.

### T8 Minor: RT3 — test constant imports not specified in Phase 4

- **Problem**: Phase 2/3 test specs explicitly state constant imports (`AUDIT_ACTION.AUDIT_OUTBOX_METRICS_VIEW`, etc.). Phase 4 test specs don't mention importing constants.
- **Recommended action**: Add RT3 compliance note to Phase 4 test descriptions.

### T9 Minor: `audit-chain.ts` public API not specified for testability

- **Problem**: Step 26 doesn't specify which functions are exported from `audit-chain.ts`. Unit tests require named exports.
- **Recommended action**: Specify exported functions: `computeCanonicalBytes(input)`, `computeEventHash(prevHash, canonicalBytes)`, `buildChainInput(auditLogFields)`.

### T10 Minor: i18n/bypass coverage test updates not mentioned

- **Problem**: If `AUDIT_CHAIN_VERIFY` action is added (per F2), existing `audit-i18n-coverage.test.ts` and `audit-bypass-coverage.test.ts` will auto-detect the gap. But the plan should mention this dependency.
- **Recommended action**: Note in Step 25/28 that existing coverage tests will automatically enforce i18n and bypass set completeness.

---

## Adjacent Findings

None — all findings fall cleanly within expert scopes.

## Quality Warnings

None — all findings are specific and actionable.

## Recurring Issue Check

### Functionality expert
- R1 (Shared utility reimplementation): Checked — F-P4-m1 (canonicalize package). Minor.
- R2 (Constants hardcoded): Checked — F-P4-m2 (rate limit value). Minor.
- R3 (Pattern propagation): Checked — RLS pattern follows Phase 1/3. OK.
- R4 (Event dispatch gaps): N/A — no new mutation sites.
- R5 (Missing transactions): Checked — §4.2 is fully transactional. OK.
- R6 (Cascade delete orphans): Checked — `onDelete: Restrict` on anchor. OK.
- R7 (E2E selector breakage): N/A — no UI changes.
- R8 (UI pattern inconsistency): N/A — no UI changes.
- R9 (Transaction boundary for fire-and-forget): Checked — verify endpoint logAudit outside tx. OK.
- R10 (Circular module dependency): Checked — audit-chain.ts → worker only. OK.
- R11 (Display group ≠ subscription group): N/A.
- R12 (Enum/action group coverage gap): **Finding F2** — AUDIT_CHAIN_VERIFY missing.
- R13 (Re-entrant dispatch loop): Checked — verify action in WEBHOOK_DISPATCH_SUPPRESS. OK.
- R14 (DB role grant completeness): **Finding F3** — audit_chain_anchors grants missing.
- R15 (Hardcoded env values in migrations): Checked — no env values in migration. OK.

### Security expert
- R1-R15: See Functionality expert above (overlap checked).
- RS1 (Timing-safe comparison): Checked — `verifyAdminToken` uses `timingSafeEqual`. OK.
- RS2 (Rate limiter on new routes): Checked — verify endpoint has `max: 3`. OK.
- RS3 (Input validation at boundaries): **Finding S4** — date range boundaries.

### Testing expert
- R1-R15: See Functionality expert above (overlap checked).
- RT1 (Mock-reality divergence): N/A — Phase 4 tests are all real-DB integration.
- RT2 (Testability verification): **Finding T9** — export API not specified.
- RT3 (Shared constant in tests): **Finding T8** — constant imports not specified.
