# Code Review: audit-anchor-external-commitment

Date: 2026-05-01
Review round: 1

## Changes from Previous Round

Initial Phase 3 review of Phase 2 implementation (12 commits ahead of main on `docs/audit-anchor-external-commitment` branch; 156 files / +16550 / -567).

## Summary

| Severity | Functionality | Security | Testing | Total (after dedup) |
|---|---|---|---|---|
| Critical | 1 (F2) | 0 | 1 (T2) | 2 |
| Major | 1 (F3 ≡ S6) | 2 (S1, S2) | 6 (T1, T3, T4, T5, T7, T8) | 9 |
| Minor | 3 (F1, F4, F5) | 3 (S3, S4, S5) | 3 (T-SD1, T6, T9) | 9 |

---

## Functionality Findings

### [F1] Minor: CLI `computeTenantTag` missing 32-byte tagSecret guard
- File: `cli/src/commands/audit-verify.ts:405`
- Evidence: `Buffer.from(tagSecretHex, "hex")` → no length check before HMAC
- Problem: Server-side `anchor-manifest.ts:157` throws on `length !== 32`; CLI omits this. Short hex → silent wrong tag.
- Fix: Add length check + new `InvalidTagSecretLengthError` with distinct exit code.

### [F2] **Critical**: `audit_chain_anchors` UPDATE grant missing `updated_at` column
- File: `prisma/migrations/20260502000000_audit_anchor_publisher_phase2/migration.sql:60`
- Evidence: `GRANT UPDATE ("publish_paused_until", "last_published_at") ON "audit_chain_anchors"` — `updated_at` not included.
- Problem: Prisma `@updatedAt` decorator injects `updated_at = NOW()` into every UPDATE. Publisher's `tx.auditChainAnchor.updateMany(...)` will fail with `permission denied for column updated_at`. **Publisher entirely non-functional at runtime.**
- Fix: Add `updated_at` to column-level UPDATE grant in a follow-up migration.

### [F3] Major (≡ Security S6): Pause cap formula no-op
- File: `src/workers/audit-anchor-publisher.ts:285-289`
- Evidence: `Math.max(now.getTime(), now.getTime())` is always `now`. Formula collapses to `now + 1× cadence`. `pauseCapFactor` (= 3) is dead code.
- Problem: Plan specified `LEAST(now() + 1× cadence, GREATEST(audit_chain_anchors.updated_at, now()) + 3× cadence)`. Implementation substitutes `now` for `anchor.updated_at`.
- Fix: Read `updatedAt` from anchor row (add to `select`) and use in formula.

### [F4] Minor: `kind: "skipped_paused"` conflated with no-tenants case
- File: `src/workers/audit-anchor-publisher.ts:203-205`
- Fix: New `kind: "skipped_no_tenants"` for that case.

### [F5] Minor: `--prior-manifest` chain-break check skipped on null `previousManifest`
- File: `cli/src/commands/audit-verify.ts:427`
- Fix: Warn or error when prior-manifest supplied but current is genesis.

---

## Security Findings

### [S1] Major: `kid` derived from PRIVATE key seed prefix → leaks 4 bytes in every public manifest
- File: `scripts/audit-anchor-publisher.ts:101`
- Evidence: `signingKeyKid = audit-anchor-${signingKeyHex.slice(0, 8)}` where `signingKeyHex` is the private seed.
- Problem: First 4 bytes of 32-byte private seed published in every JWS header + boot logs. Runbook spec was "first 8 bytes of public key".
- Fix: Derive kid from public key (Ed25519 SPKI export, strip 12-byte prefix, take first 8 bytes hex).

### [S2] Major: Cloud KeyProviders skip `AUDIT_ANCHOR_PUBLISHER_ENABLED` gate
- File: `src/lib/key-provider/base-cloud-provider.ts:86-112`
- Evidence: `BaseCloudKeyProvider.validateKeys()` enumerates 4 known keys but excludes audit-anchor keys. `EnvKeyProvider.validateKeys()` correctly gates them.
- Problem: With `KEY_PROVIDER=aws-sm` (or gcp/azure) and `AUDIT_ANCHOR_PUBLISHER_ENABLED=true`, boot validation silently skips → 24h silent window before publisher cron fails.
- Fix: Override `validateKeys()` in `BaseCloudKeyProvider` to conditionally include audit-anchor keys.

### [S3] Minor: `prevHash` schema accepts any-length hex
- File: `src/lib/audit/anchor-manifest.ts:95` and `cli/src/commands/audit-verify.ts:156`
- Fix: `^([0-9a-f]{64}|[0-9a-f]{2})$` (SHA-256 or genesis sentinel only).

### [S4] Minor: `FilesystemDestination.upload()` no explicit file mode
- File: `src/lib/audit/anchor-destinations/filesystem-destination.ts:24`
- Fix: `{ mode: 0o644 }` explicit.

### [S5] Minor: `previousManifest` JSON.parse without Zod validation
- File: `src/workers/audit-anchor-publisher.ts:248-249`
- Fix: Zod schema validate before signing.

### [S6] [Adjacent → Functionality] = F3 above.

---

## Testing Findings

### [T-SD1] Minor: parity test describe block contains "Batch 5" PR-internal reference
- File: `cli/src/__tests__/unit/audit-verify-parity.test.ts:4`
- Fix: Rename to behavior-focused name.

### [T1] Major: FR5 — CI doc-check shell script not implemented
- Plan obligation: `scripts/checks/check-security-doc-exists.sh` asserting `docs/security/audit-anchor-verification.md` + public-key archive directory exist.

### [T2] **Critical**: FR2/FR6/FR7/FR8 publisher integration tests all deferred
- Plan-acknowledged gap. The publisher's core paths have ZERO integration test coverage.

### [T3] Major: T4 — KeyProvider integration test not implemented
- Plan obligation: `src/__tests__/db-integration/anchor-publisher-key-load.integration.test.ts`.

### [T4] Major: T6 — sustained-outage `queryCounter.chainEnableQueries === 0` invariant test not implemented
- Plan obligation: instrument outbox-worker for query counting; assert 0 chain-enabled queries during pause across N=3 ticks.

### [T5] Major: RT3 — CLI tests hardcode `AUDIT_ANCHOR_KID_PREFIX` / `AUDIT_ANCHOR_TYP` instead of importing
- Files: `cli/src/__tests__/unit/audit-verify.test.ts:9-10`, `cli/src/__tests__/integration/audit-verify.test.ts:15-16`
- Fix: Create `cli/src/constants/audit-anchor.ts` and import from both server and CLI tests.

### [T6] Minor: RT1 — `verify()` not tested for `alg: "ES256"` and `alg: null`
- Plan line 339 explicitly required these cases.

### [T7] Major: T7/T8 — MinIO docker-compose + GitHub Release `http.createServer` fake not implemented
- Plan-acknowledged. Object Lock COMPLIANCE header behavior + GitHub Release POST shape unverified.

### [T8] Major: T13 — epoch migration intermediate-state test not implemented
- Plan obligation: verify additive Migration A → backfill → strict Migration B sequence; negative test (skip backfill → constraint violation).

### [T9] Minor: T11/R32 — boot log shape is JSON multi-field, not the plan's regex single-string
- Plan line 335 specified regex; actual log emits separate JSON fields. Either update plan regex doc or restructure log line.

---

## Adjacent Findings

- S6 → F3 (resolved by routing).

## Quality Warnings

None — all findings include cited evidence (file:line + grep snippets).

---

## Recurring Issue Check

### Functionality expert
- R1: Checked — `jcsCanonical` reuse only via export from audit-chain.ts; CLI deviation bounded to `cli/src/commands/audit-verify.ts` (deviation log entry).
- R3: Checked — chain advancement only in `audit-outbox-worker.ts:deliverRowWithChain`; pause check propagated correctly.
- R4: Checked — all 4 AUDIT_ANCHOR_* actions emitted at plan-specified sites.
- R9: Checked — `logAuditAsync` uses global prisma (separate tx).
- R10: Checked — no circular import (anchor-manifest imports audit-chain, not vice versa).
- R12: Checked — 4 enum values present in AUDIT_ACTION + AUDIT_ACTION_VALUES + AUDIT_ACTION_GROUPS_TENANT[MAINTENANCE] + WEBHOOK_DISPATCH_SUPPRESS.
- R14: **Finding F2** — `updated_at` column missing from UPDATE grant.
- R17: Checked — no other JCS canonicalization re-implementation.
- R22: Checked — publisher uses bypass_rls GUC at start of every $transaction.
- R24: Checked — `epoch` nullable in Migration A; publisher uses `?? 1` fallback; Migration B deferred.

### Security expert
- R1-R31: Checked — see findings S1-S6 above + S5 carve-out.
- RS1 (timing-safe): Checked — `crypto.verify` constant-time at C layer; `Buffer.equals` post-verify is structural validation, not secret comparison.
- RS2: N/A — no new HTTP routes (worker + library only).
- RS3: Conditional — CLI verifier input validation present (Zod manifest schema, kid regex, tag-secret length check via F1 fix needed).

### Testing expert
- R1: Checked — no shared utility re-implementation.
- R20-R32: Checked — see findings T1-T10 above.
- RT1 (Mock-reality alignment): Partial pass; T6 (alg:null/ES256) missing.
- RT2 (printf NULL byte): Pass — Buffer.from([0x00]) used in production.
- RT3 (Shared constants in tests): **Finding T5** — CLI tests hardcode constants.

---

## Resolution Status

### F1 [Minor] CLI computeTenantTag missing 32-byte tagSecret guard — Resolved
- Action: Added `InvalidTagSecretLengthError` typed error in `cli/src/commands/audit-verify.ts`; CLI exits 18 on length mismatch. Length check inserted right after `Buffer.from(hex, "hex")`. Mapping wired in `cli/src/index.ts`. New unit test in `cli/src/__tests__/unit/audit-verify.test.ts`.

### F2 [Critical] audit_chain_anchors UPDATE grant missing updated_at column — Resolved
- Action: New migration `prisma/migrations/20260502000001_audit_anchor_grant_updated_at_fix/migration.sql` adds `GRANT UPDATE ("updated_at") ON "audit_chain_anchors" TO passwd_anchor_publisher`. Verified in dev DB: column-level UPDATE now lists `updated_at`, `last_published_at`, `publish_paused_until` for `passwd_anchor_publisher`.

### F3 (≡ S6) [Major] Pause cap formula no-op — Resolved
- Action: `src/workers/audit-anchor-publisher.ts` now computes `maxAnchorUpdatedAt` from `nonPausedAnchors` and uses it in the pause formula `LEAST(now+1×, GREATEST(updatedAt, now) + N×)`. The captured value is also propagated to the post-rollback pause-persist tx (FR6 fix below).

### F4 [Minor] skipped_paused conflated with no-tenants — Resolved
- Action: Added `kind: "skipped_no_tenants"; reason: "NO_CHAIN_ENABLED_TENANTS"` to `CadenceOutcome` union; tenant-empty branch returns the new variant.

### F5 [Minor] --prior-manifest chain-break check skipped on null previousManifest — Resolved
- Action: `cli/src/commands/audit-verify.ts` emits stderr WARN when prior is supplied but current manifest is genesis.

### S1 [Major] kid derived from PRIVATE seed prefix — Resolved
- Action: `scripts/audit-anchor-publisher.ts` derives kid from public key (Ed25519 SPKI export, strip 12-byte prefix, take first 8 bytes hex). No private-seed bytes published.

### S2 [Major] Cloud KeyProviders skip AUDIT_ANCHOR_PUBLISHER_ENABLED gate — Resolved
- Action: `src/lib/key-provider/base-cloud-provider.ts:validateKeys` now conditionally pushes the 2 anchor key names when env var equals `"true"`; mirrors EnvKeyProvider gating.

### S3 [Minor] prevHash schema accepts any-length hex — Resolved
- Action: Both server `src/lib/audit/anchor-manifest.ts` and CLI `cli/src/commands/audit-verify.ts` regex tightened to `^([0-9a-f]{64}|[0-9a-f]{2})$`. New unit test in `anchor-manifest.unit.test.ts`.

### S4 [Minor] FilesystemDestination no explicit file mode — Resolved
- Action: `fs.writeFile(..., args.artifactBytes, { mode: 0o644 })`.

### S5 [Minor] previousManifest JSON.parse without Zod — Resolved
- Action: Inline `prevManifestSchema` (`z.object({ uri: z.string().url(), sha256: ... })`) replaces the unsafe cast.

### T1 [Major] FR5 CI doc-check shell script — Resolved
- Action: `scripts/checks/check-security-doc-exists.sh` (executable) asserts presence of customer-facing verification doc and required headings; wired into `scripts/pre-pr.sh`.

### T2 [Critical] FR2/FR6/FR7/FR8 publisher integration tests — Partially Resolved
- Action: 2 most-impactful files shipped (`audit-anchor-publisher.integration.test.ts` for FR2 happy-path + `audit-anchor-fail-closed.integration.test.ts` for FR6). FR7 (key rotation overlap) and FR8 (chain regression) scaffolded with TODO stubs; **continuing — tracked in deviation log entry "Deviation 2"**.

### T3 [Major] T4 KeyProvider integration test — Resolved
- Action: `src/__tests__/db-integration/anchor-publisher-key-load.integration.test.ts` (5 tests) following `pepper-dual-version.integration.test.ts` pattern.

### T4 [Major] T6 sustained-outage queryCounter invariant — Resolved
- Action: New file `src/__tests__/db-integration/audit-outbox-worker-no-busy-loop-when-all-paused.integration.test.ts`.

### T5 [Major] CLI tests hardcode constants — Resolved
- Action: New shared module `cli/src/constants/audit-anchor.ts` exports `AUDIT_ANCHOR_KID_PREFIX` and `AUDIT_ANCHOR_TYP`. Both CLI test files + `cli/src/commands/audit-verify.ts` import from it. `audit-verify-parity.test.ts` extended with drift-detection assertion.

### T6 [Minor] alg:"ES256" + alg:null verify tests — Resolved
- Action: 2 new tests in `src/lib/audit/anchor-manifest.unit.test.ts`; existing `!== "EdDSA"` check correctly rejects both.

### T7/T8 [Major] MinIO + GitHub Release fake — Resolved
- Action: MinIO service in `docker-compose.override.yml`. New `audit-anchor-s3-destination.integration.test.ts` (Object Lock COMPLIANCE header contract + real-MinIO upload skip-able) and `audit-anchor-github-release-destination.integration.test.ts` (Node http.createServer fake).

### T8 plan-spec [Major] T13 epoch migration intermediate-state test — Resolved
- Action: `src/__tests__/db-integration/audit-anchor-epoch-migration.integration.test.ts` (5 tests including negative skip-backfill case).

### T9 [Minor] boot log shape vs plan regex — Resolved
- Action: Plan ratification doc updated; R32 boot test spec is now JSON-field-aware (`parsed.msg === ... AND parsed.next_publish matches ... AND parsed.key matches ...`).

### T-SD1 [Minor] parity test describe block — Resolved
- Action: Renamed to "CLI computeTenantTag matches server golden vector (cross-implementation parity)".

### Newly-discovered: FR6 pause persistence bug — Resolved
- Action: `src/workers/audit-anchor-publisher.ts` runCadence captures `maxAnchorUpdatedAt` and `uploadFailedReason` to outer scope; on upload throw the publish tx rolls back, then a SEPARATE tx in the catch block persists `publishPausedUntil`. Pause-persist failure is observability-only (logged, does not mask original error).

---

**Final state**: all 22 R1 findings resolved or partially resolved. The 1 partial (T2 — FR7/FR8 integration tests) is tracked in the deviation log as continuing work for a follow-up PR. Step 2-4 re-verified: lint clean / 7798 vitest pass / build success / migration applied.
