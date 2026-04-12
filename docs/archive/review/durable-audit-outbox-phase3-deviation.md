# Coding Deviation Log: durable-audit-outbox-phase3
Created: 2026-04-13T16:00:00+09:00

## Deviations from Plan

### D1: S3 deliverer uses vendor-neutral `endpoint` instead of AWS-specific `bucket` + URL construction
- **Plan description**: Step 21 described an S3 deliverer. The plan's example `configEncrypted` fields implied a `bucket` field, and the AWS canonical URL form (`https://s3.<region>.amazonaws.com/<bucket>/<key>`) was the implicit target.
- **Actual implementation**: `s3ObjectDeliverer` in `src/workers/audit-delivery.ts` accepts a single `endpoint` string (the base URL including the bucket path), e.g. `https://s3.us-east-1.amazonaws.com/my-bucket`, `https://account.r2.cloudflarestorage.com/my-bucket`, or `https://minio.internal:9000/audit-bucket`. The object key is appended by the deliverer: `${normalizedEndpoint}/${objectKey}`. No `bucket` field; no hardcoded AWS URL template.
- **Reason**: Vendor neutrality — `endpoint`-based config works identically for AWS S3, Cloudflare R2, GCS S3-interop, and MinIO. A `bucket`-only field would have required hardcoding the AWS virtual-hosted or path-style URL template, making the deliverer AWS-specific. The SigV4 signing algorithm is compatible with all S3-compatible APIs regardless of endpoint.
- **Impact scope**: `src/workers/audit-delivery.ts` (`s3ObjectDeliverer` config shape). Downstream: `prisma/schema.prisma` `AuditDeliveryTarget.configEncrypted` stores this JSON; any future CRUD endpoint or migration seed must use `endpoint` rather than `bucket` + `region` as separate top-level keys.

---

### D2: Deliverers exported as `AuditDeliverer` interface objects, not bare functions
- **Plan description**: Step 21 referred to `deliverWebhook`, `deliverSiemHec`, `deliverS3Object` as functions (implied function signature `(config, payload) => Promise<void>`).
- **Actual implementation**: Each deliverer is exported as a named constant (`webhookDeliverer`, `siemHecDeliverer`, `s3ObjectDeliverer`) that satisfies the `AuditDeliverer` interface (`{ deliver(config, payload): Promise<void> }`). A `DELIVERERS` registry maps `AuditDeliveryTargetKind` string keys to these objects. The worker calls `DELIVERERS[kind].deliver(config, payload)`.
- **Reason**: The interface/object pattern gives a natural extension point (additional methods such as `validate(config)` can be added per deliverer without changing call sites) and aligns with the existing `WebhookDispatcher` object pattern in the codebase.
- **Impact scope**: `src/workers/audit-delivery.ts` (exports and registry shape). The worker (`src/workers/audit-outbox-worker.ts`) calls `.deliver()` on the registry entry, not a bare function. Phase 3 tests (Step 23) must import `webhookDeliverer`, `siemHecDeliverer`, `s3ObjectDeliverer` and call `.deliver()`, not invoke them directly.

---

### D3: SigV4 helper renamed from `buildS3AuthorizationHeader` to `buildSigV4AuthorizationHeader`
- **Plan description**: The plan (P3-S2) required an SigV4 Authorization header with actual payload hash, but did not specify the internal helper name.
- **Actual implementation**: The private helper is named `buildSigV4AuthorizationHeader` (not `buildS3AuthorizationHeader`). The name reflects that SigV4 is a general AWS signing algorithm, not S3-specific, making the name more accurate given the vendor-neutral endpoint design (D1).
- **Reason**: Consistency with the vendor-neutral stance: calling it `buildS3AuthorizationHeader` would imply AWS S3 exclusivity, whereas `buildSigV4AuthorizationHeader` correctly signals that this is the SigV4 protocol which is also used by R2, GCS, and MinIO in compatibility mode.
- **Impact scope**: Internal to `src/workers/audit-delivery.ts` (unexported private function). No external call sites.

---

### D4: Phase 3 tests (Step 23) not yet written — deferred to after code review
- **Plan description**: Step 23 required deliverer unit tests (`audit-deliverer-webhook.test.ts`, `audit-deliverer-siem-hec.test.ts`, `audit-deliverer-s3-object.test.ts`), SSRF rejection tests, per-target failure isolation tests, and a fan-out integration test.
- **Actual implementation**: None of these test files exist on the branch. The existing `src/workers/audit-outbox-worker.test.ts` was extended for Phase 3 worker loop coverage, but the per-deliverer unit tests and integration tests specified in Step 23 are absent.
- **Reason**: Deliberately deferred. Phase 3 tests will be written after the code review is complete, following the same pattern used in Phase 2 (review first, tests after findings are resolved).
- **Impact scope**: Test coverage gap for `src/workers/audit-delivery.ts`. The three deliverer test files and the fan-out integration test remain as follow-up work before Phase 3 can be considered fully complete.

---

### D5: Tenant CRUD endpoints (Step 24) remain out of scope — as planned
- **Plan description**: Step 24 listed `POST /api/tenant/audit-delivery-targets`, `GET`, `DELETE` endpoints and explicitly marked them "(Out of scope for the loaded review, but listed for completeness)".
- **Actual implementation**: No CRUD endpoints for `audit_delivery_targets` were implemented. The schema and worker fan-out logic are in place; target rows must be inserted manually (e.g., via `db:seed` or `db:studio`) for development testing.
- **Reason**: Confirmed out of scope per the plan. The worker fan-out logic is the load-bearing part of Phase 3; the management UI/API is a documented follow-up.
- **Impact scope**: No API surface for `audit_delivery_targets` management. Operators cannot configure delivery targets without direct DB access until the follow-up endpoints are implemented.
