# Plan Review: durable-audit-outbox-phase3
Date: 2026-04-13T14:00:00+09:00
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 Critical: `AuditDeliveryStatus` missing `PROCESSING` state — stuck delivery rows unrecoverable

- Problem: `AuditDeliveryStatus` enum has only `PENDING / SENT / FAILED`. Unlike `AuditOutboxStatus` which has `PROCESSING` + reaper, delivery rows have no stuck-detection mechanism. If the worker crashes after claiming a delivery row via `FOR UPDATE SKIP LOCKED`, the row remains locked until the DB connection is severed, then reverts to `PENDING` — but without `processingStartedAt` tracking, the reaper cannot differentiate legitimately-pending from abandoned rows.
- Impact: Crash during delivery processing causes either double-delivery (row re-fetched immediately after lock release) or indefinite stall. The `audit_outbox` reaper pattern (`PROCESSING_TIMEOUT_MS = 300s`) is not replicated for deliveries.
- Recommended action: Add `PROCESSING` to `AuditDeliveryStatus`, add `processingStartedAt DateTime?` to `AuditDelivery`, extend the reaper to reset stuck delivery rows. Alternatively, design the delivery loop to claim+execute+update in a single short transaction (document trade-offs).

### F2 Critical: `onDelete: Cascade` on `AuditDelivery.outboxId` FK — retention purge destroys incomplete deliveries

- Problem: `AuditDelivery.outbox` FK uses `onDelete: Cascade`. The Phase 2 reaper's `purgeRetention()` deletes `SENT` outbox rows after 24 hours. If a SIEM or S3 delivery is still `PENDING` or `FAILED` when its parent outbox row is purged, the cascade deletes the delivery row too.
- Impact: Fan-out delivery state is silently destroyed. Per-target failure isolation (F7 requirement) is violated — failed deliveries become unretriable and unauditable after 24h.
- Recommended action: Either (A) change the FK to `onDelete: Restrict` and extend `purgeRetention()` to only delete outbox rows whose deliveries are all terminal (`SENT` or `FAILED` past retention), or (B) decouple delivery row lifecycle from outbox row lifecycle with `onDelete: SetNull`.

### F3 Major: `EXTERNAL_DELIVERY_METADATA_BLOCKLIST` definition location contradicts across plan sections

- Problem: N5 says `sanitizeForExternalDelivery` goes to `src/lib/audit-logger.ts`. Step 21 says deliverers call `validateExternalUrl()` from `external-http.ts`. The relationship between `WEBHOOK_METADATA_BLOCKLIST` (existing, 22 keys in `webhook-dispatcher.ts`) and the renamed `EXTERNAL_DELIVERY_METADATA_BLOCKLIST` is unclear. Step 19 does not mention extracting the sanitizer.
- Impact: Implementation ambiguity — developers may create duplicate blocklists or place them in conflicting modules.
- Recommended action: Clarify in the plan: (1) canonical location for `EXTERNAL_DELIVERY_METADATA_BLOCKLIST` and `sanitizeForExternalDelivery`, (2) relationship to existing `WEBHOOK_METADATA_BLOCKLIST`, (3) add sanitizer extraction to step 19 or step 21 explicitly.

### F4 Major: `AuditDelivery` missing `maxAttempts` — no dead-letter policy for fan-out deliveries

- Problem: `AuditDelivery` has `attemptCount` but no `maxAttempts`. The plan does not specify when a delivery transitions to `FAILED` permanently. `AuditDeliveryTarget.failCount` exists but its relationship to per-delivery dead-lettering is undefined.
- Impact: A permanently-down SIEM target causes infinite retries. No dead-letter boundary exists for individual delivery rows.
- Recommended action: Add `maxAttempts Int @default(8)` to `AuditDelivery` (matching outbox pattern), or document that `AuditDeliveryTarget.failCount` triggers target deactivation (`isActive = false`) after a threshold.

### F5 Major: `onDelete: Cascade` on `AuditDelivery.targetId` FK — target deletion destroys delivery audit trail

- Problem: If a tenant admin deletes a delivery target (Phase 3.5 CRUD), all `AuditDelivery` rows for that target are cascade-deleted, destroying the failure/success audit trail.
- Impact: Compliance investigation cannot determine delivery history for deleted targets. In a compromise scenario, an attacker can hide delivery failure evidence by deleting the target.
- Recommended action: Change to `onDelete: Restrict` (block target deletion while deliveries exist) or `onDelete: SetNull`. Alternatively, only allow soft-delete (`isActive = false`) for targets.

### F6 Major: Missing Prisma back-relations on `AuditOutbox` and `Tenant` models

- Problem: `AuditDelivery` references `AuditOutbox` and `AuditDeliveryTarget` references `Tenant`, but the plan does not mention adding back-relation fields (`deliveries AuditDelivery[]` on `AuditOutbox`, `auditDeliveryTargets AuditDeliveryTarget[]` on `Tenant`). Prisma 7 requires bidirectional relation definitions.
- Impact: `prisma generate` will fail or produce incomplete types, blocking worker fan-out queries.
- Recommended action: Add to step 20: "Add `deliveries AuditDelivery[]` to `AuditOutbox` model and `auditDeliveryTargets AuditDeliveryTarget[]` to `Tenant` model."

### F7 Major: `configEncrypted` uses `Bytes` type but existing webhook encryption uses `String` — API mismatch

- Problem: `TeamWebhook` / `TenantWebhook` use `String` for `secretEncrypted/secretIv/secretAuthTag`. The plan uses `Bytes` for `AuditDeliveryTarget.configEncrypted/configIv/configAuthTag`. The existing `encryptServerData()` / `decryptServerData()` in `crypto-server.ts` return/accept string types.
- Impact: Type mismatch at implementation time — `Buffer` vs `string` conversion needed, or crypto API changes required.
- Recommended action: Either use `String` for consistency with existing pattern, or if `Bytes` is preferred, document the conversion layer explicitly and confirm `decryptServerData` accepts `Buffer`.

### F8 Minor: `audit_deliveries` index missing `tenantId` for tenant-scoped queries

- Problem: `@@index([status, nextRetryAt])` is the only index. Worker fan-out queries by `tenantId` + `status` will full-scan.
- Impact: Inefficient delivery processing in multi-tenant environments.
- Recommended action: Add `@@index([tenantId, status, nextRetryAt])` (low cost since `tenantId` is already denormalized).

## Security Findings

### S1 Major: Missing AAD on `configEncrypted` AES-256-GCM — cross-tenant config transplant attack

- Problem: The plan uses AES-256-GCM encryption for target config but does not specify AAD (Additional Authenticated Data). Existing `encryptServerData()` accepts AAD as optional. Without AAD binding `targetId` + `tenantId` to the ciphertext, an attacker with DB write access can copy one tenant's encrypted config to another tenant's record — decryption succeeds because GCM auth tag doesn't verify context.
- Impact: Cross-tenant credential theft — Tenant A's SIEM HEC token or S3 credentials used by Tenant B's worker.
- Recommended action: Mandate AAD = `Buffer.concat([Buffer.from(targetId), Buffer.from(tenantId)])` for all encrypt/decrypt calls. Add to plan as a security requirement for step 21.

### S2 Major: S3 SigV4 manual implementation risks — payload hash and credential leakage

- Problem: Plan requires manual SigV4 signing (no vendor SDK for SSRF reasons). Specific risks: (1) `UNSIGNED-PAYLOAD` usage allows MITM payload tampering, (2) presigned URLs may leak credentials via `lastError` column, (3) no AWS test vectors specified for validation.
- Impact: Audit log content integrity compromised if unsigned payload used. AWS credentials potentially visible in `lastError`.
- Recommended action: (1) Mandate `x-amz-content-sha256` with actual payload hash (prohibit `UNSIGNED-PAYLOAD`), (2) use `Authorization` header (not presigned URL), (3) sanitize URLs in `lastError`, (4) validate with AWS official SigV4 test vectors.

### S3 Major: `tenantId` denormalization missing from `AuditDelivery` Prisma schema definition

- Problem: Plan text says "audit_deliveries needs a denormalized tenantId column" (S4 fix) but the Prisma model definition does not include it. RLS policy requires `tenant_id` column to exist.
- Impact: RLS policy creation fails at migration time, or RLS is silently skipped — cross-tenant delivery access becomes possible.
- Recommended action: Add `tenantId String @map("tenant_id") @db.Uuid` to `AuditDelivery` model in the plan's schema definition. Add corresponding Tenant relation or document it as a raw column.

### S4 Major: Worker RLS bypass (`setBypassRlsGucs`) scope for Phase 3 tables unspecified

- Problem: Phase 2 worker uses `setBypassRlsGucs()` for `audit_outbox` and `audit_logs` operations. Phase 3 adds `audit_delivery_targets` (SELECT) and `audit_deliveries` (CRUD) — both with FORCE RLS. The plan does not specify whether the existing `setBypassRlsGucs()` call scope covers these new table operations.
- Impact: Worker fails to read active delivery targets (RLS filters all rows) or create delivery rows, causing silent fan-out failure.
- Recommended action: Document in step 22 that the delivery fan-out and second loop must run within `setBypassRlsGucs()` scope, same as the existing outbox processing path.

### S5 Major: `lastError` columns may contain credentials from error messages

- Problem: `AuditDeliveryTarget.lastError` and `AuditDelivery.lastError` store HTTP error messages. SIEM HEC tokens may appear in URLs (`?token=abc123`), and network error messages may include full URLs.
- Impact: Credentials visible to anyone with DB read access to these tables (tenant admins via future CRUD, DB administrators).
- Recommended action: Implement `sanitizeErrorForStorage(error)` that strips URL query parameters and known credential patterns (`token=`, `key=`, `Bearer `) before writing to `lastError`.

### S6 Minor: `redirect: "error"` not mandated for Phase 3 deliverers

- Problem: Existing `webhook-dispatcher.ts` uses `redirect: "error"` to prevent SSRF via 302 redirects. Phase 3 deliverers must also enforce this, but the plan doesn't specify it.
- Impact: A target URL responding with 302 → `http://169.254.169.254/` bypasses SSRF pinning.
- Recommended action: Add `redirect: "error"` to the `external-http.ts` fetch wrapper so all deliverers inherit it.

### S7 Minor: AWS credential format and rotation mechanism unspecified

- Problem: The encrypted config schema (AWS Access Key ID + Secret Access Key format, rotation lifecycle) is not defined. No rotation API exists until Phase 3.5 CRUD (out of scope).
- Impact: Compromised AWS credentials cannot be replaced. No mechanism to enforce least-privilege IAM policies.
- Recommended action: (1) Define config JSON schema in the plan, (2) recommend AWS STS AssumeRole + ephemeral tokens, (3) note that Phase 3.5 CRUD is prerequisite for credential rotation.

## Testing Findings

### T1 Critical: `describe.each` false-positive risk if `BLOCKED_CIDRS` not yet exported

- Problem: `external-http-ssrf.test.ts` uses `describe.each` over `BLOCKED_CIDRS` imported from `external-http.ts`. If the test is written before step 19 completes (or if the import fails silently), `describe.each([])` iterates zero times — the test passes vacuously.
- Impact: SSRF test suite shows 100% pass with zero actual assertions.
- Recommended action: Add guard assertion `expect(BLOCKED_CIDRS.length).toBeGreaterThan(0)` at test file top. Add to step 19 done-criteria: "`BLOCKED_CIDRS` is exported from `external-http.ts`."

### T2 Major: SSRF test CIDR representative IP selection undefined — 13/22 CIDRs uncovered

- Problem: Plan says "both IPv4 and IPv6 representatives rejected" but doesn't define which IP to use per CIDR. Existing `webhook-dispatcher.test.ts` only covers 7 of 22 CIDRs with hardcoded IPs.
- Impact: Over half of the blocked CIDR ranges are untested. Future additions/removals go undetected.
- Recommended action: Define `BLOCKED_CIDR_REPRESENTATIVES` in `external-http.ts` alongside `BLOCKED_CIDRS`, mapping each CIDR to test representative IPs. Tests iterate this array.

### T3 Major: "22 blocklisted keys" count in plan is incorrect — actual count differs

- Problem: Plan references "22 blocklisted keys" for `EXTERNAL_DELIVERY_METADATA_BLOCKLIST`, but current `WEBHOOK_METADATA_BLOCKLIST` already has 22 keys. After adding PII keys (email, targetUserEmail, reason, incidentRef, displayName, justification, requestedScope = 7 more), the total would be 29, not 22. The plan's arithmetic is inconsistent.
- Impact: Tests asserting `toHaveLength(22)` will fail or mask actual constant changes (RT3 violation).
- Recommended action: Fix the plan to reference the constant's `.size` rather than a hardcoded number. Tests must import the constant and assert against it.

### T4 Major: Rate-limit test undefined — no rate limiter specification in plan

- Problem: `audit-delivery-rate-limit.test.ts` tests re-queue behavior, but Phase 3 plan steps 21-22 do not define the rate limiter implementation (which rate limiter, window, max values, re-queue mechanism).
- Impact: Test cannot be written without implementation spec. "Re-queued not dropped" requires DB state verification, contradicting the "Mocked" classification.
- Recommended action: Define rate limiter API/config in step 21. Change test classification to integration or redesign as mocked unit test that verifies delivery rows remain `PENDING` with future `nextRetryAt`.

### T5 Major: `audit-outbox-worker-role.integration.test.ts` does not exist — plan says "update"

- Problem: Plan says "update" this test for Phase 3 grants, but the test file does not exist in the codebase (verified via search). It needs to be created, not updated.
- Impact: Phase 3 grant assertions have no test home. The "update" wording causes implementation confusion.
- Recommended action: Change plan wording to "create" and list all expected grants (Phase 1+2+3) in the done-criteria for step 20.

### T6 Minor: Individual deliverer unit test specs missing from test table

- Problem: Step 23 mentions "deliverer unit tests" but the test table has no entry for individual deliverer function tests (HTTP header format, Content-Type, Authorization header for SIEM HEC, SigV4 signature presence for S3).
- Impact: Deliverer internals tested only at integration level — HTTP format correctness not verified.
- Recommended action: Add per-deliverer unit tests to the plan table: `audit-deliverer-webhook.test.ts`, `audit-deliverer-siem-hec.test.ts`, `audit-deliverer-s3-object.test.ts`.

## Adjacent Findings

### F9-A [Adjacent] Major: Delivery failure meta-events not addressed in `OUTBOX_BYPASS_AUDIT_ACTIONS` / `WEBHOOK_DISPATCH_SUPPRESS` — may overlap with Security expert's R13 scope

- Source: Functionality expert (R9, R13 checks)
- Problem: When a Phase 3 delivery (SIEM/S3/webhook) fails, does the worker emit a new audit event (e.g., `AUDIT_DELIVERY_FAILED`)? If so, that action must be added to `OUTBOX_BYPASS_AUDIT_ACTIONS` and `WEBHOOK_DISPATCH_SUPPRESS` to prevent R13 re-entrant loops. The plan does not define any new audit actions for Phase 3 delivery events.
- Impact: Delivery failure → audit event → outbox enqueue → fan-out → delivery failure → infinite loop.
- Recommended action: Define whether Phase 3 emits delivery failure audit events. If yes, add them to both bypass sets and document the suppression in the plan.

## Quality Warnings

None — all findings are specific and evidence-based.

## Recurring Issue Check

### Functionality expert
- R1 (Shared utility reimplementation): Checked — OK, step 19 extracts SSRF helpers
- R2 (Constants hardcoded): Checked — OK, constants defined in `src/lib/constants/audit.ts`
- R3 (Incomplete pattern propagation): Checked — Finding F3 (blocklist location inconsistency)
- R4 (Event dispatch gaps): N/A — no new mutation endpoints in Phase 3
- R5 (Missing transaction wrapping): Checked — OK, `FOR UPDATE SKIP LOCKED` pattern inherited
- R6 (Cascade delete orphans): Checked — Findings F2, F5 (cascade deletes destroy delivery state)
- R7 (E2E selector breakage): N/A — no UI changes
- R8 (UI pattern inconsistency): N/A — no UI changes
- R9 (Transaction boundary for fire-and-forget): Checked — Finding F9-A (delivery failure meta-events)
- R10 (Circular module dependency): Checked — OK, unidirectional dependency maintained
- R11 (Display group ≠ subscription group): N/A — no event grouping changes
- R12 (Enum/action group coverage gap): N/A — no new AuditAction values in Phase 3
- R13 (Re-entrant dispatch loop): Checked — Finding F9-A (delivery failure event suppression unspecified)
- R14 (DB role grant completeness): Checked — OK, grants documented (S4 fix in plan)
- R15 (Hardcoded env values in migrations): Checked — OK, follows Phase 1/2 pattern

### Security expert
- R1: Checked — OK (SSRF helper extraction)
- R2: Checked — OK (SigV4 constants need attention at implementation)
- R3: Checked — Finding S3 (tenantId denormalization missing from schema)
- R4: N/A
- R5: Checked — OK
- R6: N/A
- R7: N/A
- R8: N/A
- R9: Checked — OK (void async dispatch outside tx)
- R10: Checked — OK
- R11: Checked — OK
- R12: N/A (no new audit actions — but see F9-A adjacent finding)
- R13: Checked — OK (delivery failure suppression needs clarification)
- R14: Checked — Finding S4 (RLS bypass scope for new tables)
- R15: Checked — OK
- RS1 (Timing-safe comparison): OK — no credential comparison in Phase 3
- RS2 (Rate limiter on new routes): N/A — no new API endpoints (§3.5 OOS)
- RS3 (Input validation): Noted — config Zod schema undefined (deferred to implementation)

### Testing expert
- R1: Checked — OK (test plan uses imported constants from `external-http.ts`)
- R2: Checked — OK
- R3: Checked — Findings T2, T3 (incomplete CIDR coverage, wrong key count)
- R4: N/A
- R5: Checked — OK
- R6: N/A
- R7: N/A
- R8: N/A
- R9: N/A
- R10: Checked — OK
- R11: N/A
- R12: Checked — Finding T3 (blocklist key count mismatch)
- R13: Checked — minor gap (delivery failure event suppression test absent)
- R14: Checked — Finding T5 (grant test file doesn't exist)
- R15: Checked — OK
- RT1 (Mock-reality divergence): Noted — deliverer HTTP response shapes need verification (T6)
- RT2 (Testability verification): Finding T4 (rate-limit re-queue untestable with mock)
- RT3 (Shared constant in tests): Findings T2, T3 (hardcoded CIDR IPs, hardcoded key count)
