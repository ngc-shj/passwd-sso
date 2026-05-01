# Plan Review: audit-anchor-external-commitment

Date: 2026-05-01
Review round: 1

## Changes from Previous Round

Initial review.

## Summary

| Severity | Functionality | Security | Testing | Total |
|---|---|---|---|---|
| Critical | 0 | 0 | 2 | 2 |
| Major | 3 | 3 | 7 | 13 (after dedup: 12; F1≡S1) |
| Minor | 5 | 7 | 5 | 17 |
| Adjacent | 0 | 0 | 1 | 1 (T3-A → F3) |

**Critical (must fix before Round 2)**: T1, T2.
**Cross-expert overlaps**: F1 ≡ S1 (publisher INSERT on audit_logs); F3 ≡ T3-A ≡ T4 (KeyName extension scope).

---

## Functionality Findings

### [F1] [Major]: NFR5 / Step 2 / Step 7 three-way contradiction on publisher INSERT on audit_logs
- File: plan §"Requirements → Non-functional" NFR5; §"Implementation steps" step 2; step 7
- Evidence: NFR5 says "no write access to `audit_logs`"; Step 2 grants `INSERT on audit_logs`; Step 7 mandates emission via `logAuditAsync`/outbox (NOT direct `audit_logs` INSERT).
- Problem: Three statements in the same document mutually inconsistent. Implementation reading Step 2 will grant unnecessary INSERT.
- Impact: Least-privilege violation. Publisher process compromise gains direct INSERT on `audit_logs`, enabling fabricated audit records (bounded by RLS, but expanded blast radius).
- Fix: Remove `INSERT on audit_logs` from Step 2. Publisher only needs `SELECT on audit_chain_anchors`, `SELECT on tenants(id, audit_chain_enabled)`, `INSERT on audit_outbox`. Reconcile NFR5 wording: "Publisher emits its own audit events via `audit_outbox`, so it requires `INSERT on audit_outbox`, not on `audit_logs`."

### [F2] [Major]: RLS bypass GUC mechanism for publisher's cross-tenant SELECT not specified
- File: plan §"Implementation steps" step 2 / step 7
- Evidence: `audit_chain_anchors` migration sets `FORCE ROW LEVEL SECURITY` with policy `bypass_rls=on OR tenant_id=current_setting('app.tenant_id')`. Publisher must read all chain-enabled tenants in one query. As `NOBYPASSRLS`, without setting `app.bypass_rls='on'` cross-tenant SELECT returns zero rows.
- Problem: Publisher's first run silently produces a manifest with `"tenants": []`. No error, no logs.
- Impact: FR2 vacuously satisfied; manifest provides zero security value; bug operationally invisible.
- Fix: Add Step 2a: publisher's DB session must `setBypassRlsGucs` / `withBypassRls` (`BYPASS_PURPOSE.SYSTEM_MAINTENANCE` or new `AUDIT_ANCHOR_PUBLISH`) before querying the anchor table. Cite the dcr-cleanup-worker and audit-chain-verify-route patterns as precedent.

### [F3] [Major]: KeyName closed-union type — KeyProvider extension touch-points underspecified
- File: `src/lib/key-provider/types.ts:8`; plan §"Implementation steps" step 4
- Evidence: `KeyName = "share-master" | "verifier-pepper" | "directory-sync" | "webauthn-prf"` — closed union. Adding new key requires touching: (1) `KeyName` literal, (2) `EnvKeyProvider.getKeySync` switch, (3) `validateKeys` warm-up in EVERY cloud provider (`AwsSmKeyProvider`, `GcpSmKeyProvider`, `AzureKvKeyProvider`), (4) `env-schema.ts` (env var + `pick`).
- Problem: Plan says "extend KeyProvider" without enumerating all 4 provider touch-points. Ed25519 raw seed (32 bytes) has different validation than AES-256 symmetric.
- Impact: One missed cloud provider = silent stale/missing key in that deployment shape (e.g., Azure prod boots without error but with broken key).
- Fix: Add Step 4a: name `audit-anchor-signing`, env var `AUDIT_ANCHOR_SIGNING_KEY` (32-byte hex = 64 char), update all 4 providers' `getKeySync` + `validateKeys`, extend `env-schema.ts` `envObject` and `pick()` list. Specify storage format (raw 32-byte seed, big-endian hex).

### [F4] [Minor]: New AuditAction enum values referenced but not declared
- File: plan User scenarios; `prisma/schema.prisma:802-948` `AuditAction`; `src/lib/constants/audit/audit.ts:17-170` `AUDIT_ACTION`
- Evidence: `AUDIT_ANCHOR_PUBLISHED` and `AUDIT_ANCHOR_PUBLISH_FAILED` referenced in scenarios but absent from any enum/constant. No migration step adds them.
- Impact: Implementation cannot emit; runtime cast error on first publish.
- Fix: Add to Step 1: ALTER TYPE `AuditAction` ADD VALUE for new actions; update `AUDIT_ACTION` constant + `AUDIT_ACTION_VALUES` array; decide `OUTBOX_BYPASS_AUDIT_ACTIONS` membership (publisher emits via outbox → exclude; in-process direct → include).

### [F5] [Minor]: Concurrent publisher locking mechanism unspecified
- File: plan §"Implementation steps" step 3; §Testing chaos
- Evidence: "concurrent publisher invocations (must idempotent on `anchoredAt` rounded to cadence boundary)" — locking mechanism not specified.
- Impact: Rolling deploy / accidental double-start can produce two valid but non-byte-identical manifests for the "same" daily window, breaking `previousManifest.sha256` chain.
- Fix: Specify mechanism: PG advisory lock OR conditional UPDATE on `last_published_at` column before reading anchors. Idempotency requirement must be backed by explicit serialization, not just rounding.

### [F6] [Minor]: deploymentId field undefined
- File: plan Manifest schema (Axis 6); §"Implementation steps" step 8
- Evidence: `"deploymentId": "<UUID — distinguishes self-hosted instances>"` — no derivation rule, no env var, no DB column. No `DEPLOYMENT_ID` in `env-schema.ts`.
- Impact: Implementation must invent. Random-per-restart vs stable-DB-row have different security properties (verifier may flag random as cross-deployment replay).
- Fix: Add `DEPLOYMENT_ID` to Step 8 constants. Stable UUID via env var (operator-set at first deploy, never rotated) or derived from a system tenant row. Stability across publisher restarts mandatory.

### [F7] [Minor]: Axis 1A 10k vs 1B 100k threshold internally inconsistent
- File: plan Axis 1
- Evidence: 1A recommendation cites "<10k tenants per deployment" foreseeable scale; 1B rejection cites "Reconsider if tenant count >100k". 10× gap.
- Impact: Future architect cannot tell at what scale 1A becomes a liability.
- Fix: Align thresholds. Either lift 1A to 100k or lower 1B reconsider to 10k or document the gap (e.g., 10k = scale at which we add monitoring; 100k = scale at which we revisit 1B).

### [F8] [Minor]: epoch reset semantics not in FR8 monotonicity rule
- File: plan FR8; Considerations "Chain reset / epoch increment"
- Evidence: FR8 says "chain_seq advances strictly monotonically across publications" — but a future epoch reset would lower chain_seq across an epoch boundary; verifier flags as tamper.
- Impact: When chain reset ships, false-positive tamper alarm guaranteed.
- Fix: FR8 → "(epoch, chain_seq) tuple non-decreasing — same epoch with lower chain_seq IS a tamper signal; higher epoch with lower chain_seq is NOT (epoch reset)". Document invariant in `docs/security/audit-anchor-verification.md`.

---

## Security Findings

### [S1] [Major]: Publisher INSERT on audit_logs violates NFR5
**Duplicate of F1.** Routed under Functionality. Security agrees the Fix is correct: INSERT on audit_outbox only.

### [S2] [Major]: Column-level REVOKE SELECT (metadata) is a PostgreSQL no-op providing false assurance
- File: plan §"Implementation steps" step 2
- Evidence: `REVOKE SELECT (metadata) ON audit_logs FROM passwd_anchor_publisher` only revokes a previously-granted column-level privilege. Publisher (after F1 fix) has no SELECT on `audit_logs`; the REVOKE silently does nothing.
- Problem: Plan presents as a verification control; in PG semantics it is vacuous.
- Impact: False assurance. Future grant amendment adding SELECT for debugging silently exposes `metadata`, because the REVOKE in the migration does not provide a lasting guard.
- Fix: Replace with accurate description: "no SELECT on `audit_logs` is granted; therefore `metadata` is inaccessible — by omission, not by REVOKE. Column-level REVOKE in PG cannot restrict a table-level SELECT grant. If future debugging requires read access, use a restricted VIEW (`CREATE VIEW anchor_publisher_audit_view AS SELECT id, tenant_id, chain_seq, event_hash, chain_prev_hash FROM audit_logs`) and grant SELECT on the view instead."

### [S3] [Major]: v1 signing key trust zone NOT separated from DB-write threat actor
- File: plan Axis 3B; §Threat
- Evidence: `share-master` KEK is sourced from `SHARE_MASTER_KEY_V1` env var. Operator with `MIGRATION_DATABASE_URL` (DB write) typically also has app server env access. Axis 3B = AES-GCM(SHARE_MASTER_KEY, signing_key). Same operator can decrypt + forge.
- Problem: Plan claims Axis 3B "Captures ~95% of the value" but does not state ZERO protection against insiders holding both DB write AND app env. This is the primary threat actor in the threat model.
- Impact: External commitment provides no forensic protection against operator-level insiders managing the runtime; v1 trust boundary is illusory if env+DB co-located.
- Fix: Add explicit "Trust zone caveat" paragraph to Axis 3B: "If `SHARE_MASTER_KEY` and DB write reside in the same operator trust boundary, Axis 3B does not defeat an insider holding both. The encryption only adds a step. Axis 3C (KMS) is the v2 migration target precisely to establish a hardware trust boundary. Until KMS migration, document in the runbook that `SHARE_MASTER_KEY` rotation and DB access rights should be held by different operator roles where feasible."

### [S4] [Minor]: Key rotation "in parallel" semantics unspecified
- File: plan Scenario 5; FR7
- Evidence: "signs the next manifest with both old and new key in parallel for an overlap period" — three possible mechanics with materially different verifier-compatibility properties.
- Impact: Implementation diverges from CLI verifier and `openssl` recipe; customers see false failures or accept fabricated manifests during overlap.
- Fix: Specify "during the overlap period, each cadence publishes TWO independent JWS files at different paths (e.g., `manifest-<date>.kid-<old>.jws` and `manifest-<date>.kid-<new>.jws`). Both files have identical payload bytes; they differ only in signature and `kid`. Verifier CLI accepts either; openssl recipe selects file by `kid`. The `key-rotation` advisory itself is a JWS at a well-known path with `typ: passwd-sso.audit-anchor.v1`."

### [S5] [Minor]: Old key "retirement" doesn't distinguish private destruction from public archival
- File: plan FR7; Considerations R31
- Evidence: Considerations says "key rotation involves disabling/destroying the old signing key... `vault kv delete` / `aws kms schedule-key-deletion`". No mention of public-key archival.
- Impact: After private destruction, customers cannot verify historical manifests signed under old key. FR7 broken; "without server cooperation" property violated for historical audits.
- Fix: Clarify: "**Private** key is destroyed (R31 cat e). **Public** key is permanently archived at `docs/security/audit-anchor-public-keys/<kid>.pub` (or equivalent public URL). Public-key archive is immutable: once a `kid` is published, its public key entry is never deleted." Update Considerations: `block-secret-key-destruction.sh` hook gates only PRIVATE key destruction; public archival confirmed before hook allows destruction to proceed.

### [S6] [Minor]: Cross-tenant tenant-ID enumeration via public manifest not assessed
- File: plan NFR4; Axis 1A
- Evidence: Manifest is publicly downloadable; lists every chain-enabled tenant's UUID + cumulative chain_seq + first-appearance date.
- Impact: Information disclosure if tenant existence is confidential (B2B SaaS with NDA-covered customer lists). Activity volume disclosed across tenants.
- Fix: Add "Tenant enumeration acceptance" to Considerations. Maintainer fills bracketed statement: `[tenant UUIDs are not confidential / OR access to the manifest is restricted to authenticated customers via signed S3 presigned URL per customer]`.

### [S7] [Minor]: JWS verifier alg:none rejection / typ enforcement insufficiently precise
- File: plan Axis 6; Step 6
- Evidence: "pin alg:EdDSA and reject mismatch in verifier" — generic JOSE library may use a config-driven `algorithms` list; misconfiguration could allow `alg:none` or ECDSA substitution.
- Impact: Misconfigured library bypasses signature verification (a known JOSE ecosystem vulnerability pattern).
- Fix: Verifier MUST hardcode `header.alg === 'EdDSA'` string equality BEFORE calling `crypto.verify`. The `algorithms` parameter MUST NOT be configurable — it is a constant `['EdDSA']`. Verifier MUST also assert `header.typ === 'passwd-sso.audit-anchor.v1'`. `alg:none` and any non-EdDSA value MUST be explicitly rejected with a typed error (`InvalidAlgorithmError`).

### [S8] [Minor]: jcsCanonical sort uses UTF-16 code unit order; RFC 8785 mandates Unicode code point order
- File: `src/lib/audit/audit-chain.ts:21`
- Evidence: `Object.keys(...).sort()` without comparator sorts by UTF-16 code unit. RFC 8785 §3.2.3 mandates Unicode scalar value order. BMP equivalent; supplementary plane (U+10000+) diverges.
- Impact: No current practical impact (all manifest keys ASCII). Risk materializes if non-BMP keys are introduced. Spec claim "RFC 8785 (JCS)" is overstated for non-BMP keys; using internal canonicalizer for an externally-verifiable signed artifact creates spec stability risk.
- Fix: Either (a) add comment to `jcsCanonical`: "Sort is correct for BMP-only keys (U+0000–U+FFFF). For supplementary-plane keys, a Unicode code-point comparator is required per RFC 8785 §3.2.3." AND add explicit prohibition in manifest library spec: "Manifest field names MUST be ASCII"; or (b) use an RFC-8785-compliant library (e.g., `canonicalize` npm package) for manifest signing only, keeping `jcsCanonical` for internal chain hashing.

### [S9] [Minor]: PENDING outbox rows during chain-pause window not protected; sliding window unbounded
- File: plan Axis 8; Step 3
- Evidence: PENDING `audit_outbox` rows accumulate during pause; insider with DB write can `UPDATE` them. Sliding `publish_paused_until` extends pause indefinitely under sustained signing-key failure.
- Impact: Limited (requires both DoS-the-signer AND DB write), but unprotected window can be extended arbitrarily; plan does not document this as accepted risk.
- Fix: Cap sliding window: `publish_paused_until = MIN(..., now() + 3 × cadence)`. Document explicit boundary in Axis 8: "all events committed to `audit_logs` with `chain_seq ≤ last_manifest_chain_seq` are protected by the published manifest. Events with `chain_seq > last_manifest_chain_seq` (including PENDING outbox rows) are not yet protected." Sustained failure beyond 3 cadences pages on-call as incident.

### [S10] [Minor]: writeDirectAuditLog produces unchained rows for chain-enabled tenants
- File: `src/workers/audit-outbox-worker.ts:357-393` (dead-letter, reaper, retention-purge writers; called at L447, L650, L768, L775, L857)
- Evidence: Direct INSERTs into `audit_logs` without `chain_seq`/`event_hash`/`chain_prev_hash`. Verify endpoint walks rows `WHERE chain_seq IS NOT NULL`. Manifest covers only chained rows.
- Impact: Limited. Attacker who deliberately dead-letters a specific event and then modifies it in `audit_logs` is invisible to chain verification AND manifest. Dead-letter event itself is in `audit_logs` (just unchained), so an auditor reviewing raw rows sees it.
- Fix: Document in Considerations: "SYSTEM-actor unchained events written by `writeDirectAuditLog` (dead-letter, reaper, retention-purge) are excluded from the manifest and chain verification by design (avoiding chain-write recursion). `docs/security/audit-anchor-verification.md` MUST state the chain covers USER-actor events; SYSTEM internal events appear as unchained rows and are audited separately."

### Threat-model coverage assessment
- Insider DB write only → **Defeated** by Axis 3B + multi-destination immutability.
- Insider DB write + signing-key access (same trust zone) → **Not defeated** by Axis 3B (S3); KMS v2 required.
- Insider DB write + publisher process compromise → **Not defeated** for future manifests; prior manifests protected by destination immutability.
- Insider suppress publication + rewrite within window → **Bounded** to cadence × N (S9 caps N at 3).

---

## Testing Findings

### [T1] [Critical]: FR→Test mapping entirely absent
- File: plan §Testing strategy
- Evidence: Lists test types (unit, integration, adversarial, failure-injection, chaos, R32) but no FR-by-FR mapping. FR2/FR4/FR5/FR7/FR8 have no described test case.
- Impact: Coverage gaps invisible until real tamper. Implementation PR may ship with FR1/FR3/FR6 covered while FR2/FR4/FR5/FR7/FR8 silently uncovered.
- Fix: Add FR→Test mapping table. Columns: `FR ID | Test type | Proposed file | Assertion summary`. Each FR must have ≥1 entry. Doc-only FR5 maps to a CI doc-existence check (`scripts/checks/check-security-doc-exists.sh`) rather than a unit test.

### [T2] [Critical]: Tamper-detection test is closed-loop — independent verifier path missing
- File: plan §Testing adversarial
- Evidence: Both publisher and verifier reuse `src/lib/audit/audit-chain.ts`. Same `buildChainInput`/`computeEventHash` builds rows AND verifies. Existing `audit-chain-verify-endpoint.integration.test.ts` reimplements `walkChain` using imported helpers — same vacuous-pass shape.
- Impact: A systematically wrong canonicalization (e.g., RFC 8785 §3.2.2.3 number bug, UTF-16 vs codepoint sort per S8) produces a manifest that passes ALL internal tests but external RFC 8785 lib disagrees. The entire external-commitment value proposition is unvalidatable by tests.
- Fix: At least one "golden-value" path: known DB rows → expected `prevHash` hardcoded from independent computation (offline `node:crypto` direct, `openssl` recipe, or reference RFC 8785 lib). Test asserts manifest's `prevHash` for the tenant equals the hardcoded value, not just internal-verifier agreement.

### [T3] [Major]: jcsCanonical custom impl not cross-referenced against RFC 8785 edge cases
- File: `src/lib/audit/audit-chain.ts:9-30`; `src/__tests__/audit-chain.unit.test.ts`
- Evidence: Existing tests cover alphabetical key sort, insertion order independence, basic types. Do NOT cover (a) IEEE 754 edges per RFC 8785 §3.2.2.3 (`1e308`, `-0`, non-finite throw, `1.5` vs `1.50`), (b) non-ASCII key UTF-16 sort per §3.1, (c) nested empty objects/arrays, (d) numeric round-trip precision (e.g., `Number.MAX_SAFE_INTEGER + 1`).
- Impact: Manifests pass internally; external RFC 8785 lib produces different bytes → false tamper for any customer using a conformant verifier.
- Fix: Add unit tests in `audit-chain.unit.test.ts` for §3.2.2.3 numbers + §3.1 Unicode key ordering. Optionally add `canonicalize` npm devDependency and assert byte-identical for all test vectors.

### [T4] [Major]: KeyProvider extension integration test not specified
- File: `src/lib/key-provider/types.ts:8`; plan Step 4
- Evidence: Pattern from `src/__tests__/db-integration/pepper-dual-version.integration.test.ts` shows `_resetKeyProvider()` + real env stubs + `getKeyProvider()`. Plan's "round-trip unit test" with a fake KeyProvider doesn't exercise that path.
- Impact: Production deployment silently falls back to broken key load (wrong buffer interpretation, missing validation). Publisher starts, logs warning, produces incorrectly-signed manifest. Fail-closed violated.
- Fix: Plan must specify integration test (e.g., `src/__tests__/db-integration/anchor-publisher-key-load.integration.test.ts`) following pepper-dual-version pattern: set `process.env.AUDIT_ANCHOR_SIGNING_KEY` to a generated Ed25519 private key → call `getKeyProvider()` with `_resetKeyProvider()` guard → call `provider.getKey("audit-anchor-signing")` → use returned key for sign/verify.

### [T5] [Major]: chain_seq regression test scenario underspecified
- File: plan §Testing adversarial
- Evidence: "rewrite multiple anchors → verifier flags chain_seq regression" — verifier needs prior manifest; mechanism for verifier retention is not described.
- Impact: FR8 only protects within a single publisher run; the actual threat (customer holding prior manifest detects server-side rewrite) requires cross-invocation regression detection.
- Fix: Define concrete 3-manifest scenario: A (seq=10), B (seq=12, `previousManifest.sha256 = sha256(A)`), C (seq=8, `previousManifest.sha256 = sha256(B)`). Test: `audit-verify --manifest C --prior-manifest A` rejects with `CHAIN_SEQ_REGRESSION`.

### [T6] [Major]: Sustained-outage no-deadlock — assertion not testable in Vitest
- File: plan §Testing sustained-outage
- Evidence: "CPU / DB QPS stays at the configured poll cadence, not faster" — not measurable in Vitest. No CPU/QPS instrumentation in existing test infra.
- Impact: Test is skipped, or implemented as flaky time-based `sleep` test.
- Fix: Replace with code-level invariant: instrument worker with optional `queryCounter` callback (constructor injection or module hook). Assert `queryCounter.chainEnableQueries === 0` after N=3 poll cycles when all chain-enabled tenants have `publish_paused_until > now()`. Pattern: existing `audit-outbox-worker.test.ts` `vi.hoisted` `$transaction`/`$queryRawUnsafe` mocks.

### [T7] [Major]: S3 destination has no real stub — no MinIO or nock in project
- File: `package.json` (no MinIO/nock); `src/workers/audit-delivery.test.ts:14-18`
- Evidence: Existing pattern mocks `@/lib/http/external-http`; no real HTTP stub. `audit-delivery.ts:8,95,233` mentions MinIO in comments, but no service in `docker-compose.override.yml` or `ci-integration.yml`.
- Impact: Object Lock headers (`x-amz-object-lock-mode: COMPLIANCE`) never exercised; wrong header silently bypasses Object Lock — the entire premise of destination 5A.
- Fix: Plan must specify (a) add MinIO service to `docker-compose.override.yml` + `ci-integration.yml` service containers; (b) integration test calling publisher S3 helper against real MinIO; (c) Object Lock header assertion. Until MinIO available: contract test asserting exact HTTP request shape (method, headers, body) using fetch interceptor.

### [T8] [Major]: GitHub Release destination has no fake endpoint specified
- File: plan §Testing integration
- Evidence: No `msw`/`nock` library; authenticated GitHub API impossible on fork CI; no fake stub strategy.
- Impact: GitHub Release destination either untested (silent failure mode where publishes appear to succeed but don't) or relies on CI secret (leak risk, unavailable on forks).
- Fix: Plan must specify lightweight Node `http.createServer` fake. Test asserts: (a) correct `POST /repos/{owner}/{repo}/releases` JSON body, (b) asset upload URL constructed correctly, (c) artifact bytes byte-identical between S3 stub write and GitHub Release upload (FR4 multi-destination integrity).

### [T9] [Minor]: Byte-identity across destinations — failure-direction test missing
- File: plan §Testing adversarial
- Evidence: Happy-path covered. Failure direction (one destination has older manifest) has no scenario.
- Impact: Implementation may produce vague error instead of expected `DESTINATION_DIVERGENCE` tamper signal.
- Fix: Add scenario: write manifest A to S3 stub, manifest B (different) to GitHub stub, call verifier multi-destination check, assert `DESTINATION_DIVERGENCE` reported with both hashes.

### [T10] [Major]: passwd_anchor_publisher role not bootstrapped in CI
- File: `scripts/pre-pr.sh:72-85`; `ci-integration.yml:11-18`, L105-109
- Evidence: `pre-pr.sh` and `ci-integration.yml` already trigger on `src/workers/**`. But `ci-integration.yml` "Bootstrap application DB roles" step creates `passwd_app`, `passwd_outbox_worker`, `passwd_dcr_cleanup_worker` only — `passwd_anchor_publisher` not added.
- Impact: Integration tests exercising the publisher's role will fail in CI with "role does not exist" but pass locally.
- Fix: Plan obligations: (a) add role creation to `ci-integration.yml` bootstrap step (mirror passwd_outbox_worker pattern at L105-106); (b) add to `infra/postgres/initdb/02-create-app-role.sql`.

### [T11] [Minor]: R32 boot log grep — environment-dependent placeholders
- File: plan §Testing R32
- Evidence: `next_publish=<ISO>` hardcoded → fails any other day; `key=<kid>` similar.
- Impact: Either fragile (breaks spuriously) or grep loose enough to not validate key load.
- Fix: Specify regex: `grep -E 'audit-anchor-publisher: cadence=24h, next_publish=[0-9T:.Z]+, key=[a-zA-Z0-9_-]+'`. Catches empty-kid fallback; clock-independent.

### [T12] [Minor]: NFR1/NFR2/NFR3/NFR5 have no specified tests
- File: plan §NFRs
- Evidence: NFR2 (manifest ≤ 2MB at 10k tenants) trivially testable; NFR3 (1 sign/cycle) trivially testable via spy; NFR5 (DB role privileges) integration-testable; NFR1 design-validated.
- Impact: NFR2 regression (e.g., adding tenant names to manifest) not caught.
- Fix: Add to Testing strategy. NFR2 → unit test `JSON.stringify(manifest).length < 2_000_000` for N=10000. NFR3 → unit test sign-spy called exactly once per publish. NFR5 → integration test asserting role has no SELECT on `audit_logs.metadata` (or SELECT entirely). NFR1 → mark "design-validated, no test required".

### [T13] [Minor]: R24 intermediate-state test for epoch column not specified
- File: plan §Step 1; "Anti-Deferral on `epoch` column"
- Evidence: Two-migration split correct, but intermediate-state test (after migration 1, concurrent NULL writer, backfill, NOT NULL flip) not enumerated.
- Impact: Incomplete backfill = migration 2 fails in production, requiring manual recovery.
- Fix: Add integration test: run migration 1 → insert with default + insert with explicit NULL → run backfill → assert no NULLs → run migration 2 succeeds.

### [T14] [Minor]: CLI subcommand test inclusion not mentioned
- File: plan §Step 10; `cli/src/__tests__/`
- Evidence: CLI test infra exists (vitest config + unit/integration directories). Plan's `passwd-sso audit-verify` is the primary customer tool; no test entry.
- Impact: Verifier regression undetected at CLI surface.
- Fix: Add `cli/src/__tests__/unit/audit-verify.test.ts` (option parsing + output format) + `integration/audit-verify.test.ts` (E2E sign-verify roundtrip with subprocess spawn). Pattern: `agent-decrypt-ipc.test.ts`.

---

## Adjacent Findings

### [T3-A → F3] KeyName closed-union type extension
Routed under F3 (Functionality scope). Testing surfaces it as: "until `KeyName` is extended, no test can call `provider.getKey('audit-anchor-signing')` without a TypeScript error." F3's Fix subsumes this.

---

## Quality Warnings

None. All findings include Evidence and concrete Fix.

---

## Recurring Issue Check

### Functionality expert
- R1: Checked — Step 4 + 6 anti-reimplementation intent stated.
- R2: Checked — Step 8 enumerates constants module.
- R3: Checked — only writer is audit-outbox-worker.
- R4: Subsumed by F4.
- R5: N/A — read-only snapshot.
- R6: N/A.
- R7: N/A — no UI.
- R8: N/A.
- R9: Checked — separate process.
- R10: Checked at ADR stage.
- R11: N/A.
- R12: Subsumed by F4.
- R13: Checked — no re-entrancy.
- R14: Subsumed by F1.
- R15: Checked — env-agnostic role creation.
- R16: Checked — flagged for Testing.
- R17: Subsumed by F3.
- R18: N/A.
- R19: N/A.
- R20: Checked — R24 split.
- R21: N/A.
- R22: Captured in F1.
- R23: N/A.
- R24: Checked.
- R25: Checked — chainSeq.toString consistent.
- R26: N/A.
- R27: N/A.
- R28: N/A.
- R29: Checked — citation flags honest.
- R30: Checked.
- R31: Checked — addressed in Considerations.
- R32: Checked — ready signal specified.
- R33: Out of scope for Functionality.
- R34: Checked — verify endpoint epoch-blind by design.
- R35: Checked — deferred to impl PR.

### Security expert
- R1: Checked — Step 4 mandates audit.
- R2: Checked — no secrets logged.
- R3: N/A.
- R4: N/A.
- R5: N/A.
- R6: N/A.
- R7: N/A.
- R8: N/A.
- R9: N/A.
- R10: Conditional — outbound HTTP from constants only.
- R11: N/A.
- R12: Checked — Ed25519 verify is C-layer constant time.
- R13: Checked.
- R14: Findings S1 (=F1), S2.
- R15: Checked — RLS confirmed; publisher NOBYPASSRLS.
- R16: Checked — no setBypassRls available.
- R17: Finding S6.
- R18: Checked — Ed25519 correct.
- R19: Finding S3.
- R20: Checked — Ed25519 deterministic; AES-GCM uses randomBytes(12).
- R21: Checked — JWS typ + kid + deploymentId domain separation.
- R22: N/A.
- R23: N/A.
- R24: Checked.
- R25: Checked.
- R26: Checked.
- R27: Checked.
- R28: Checked.
- R29: Checked.
- R30: N/A.
- R31: Checked — refined by S5.
- R32: Checked.
- R33: N/A.
- R34: N/A.
- R35: Checked.
- RS1: Checked — crypto.verify constant-time.
- RS2: N/A — publisher cron, no HTTP route.
- RS3: Conditional — CLI verifier input validation flagged for impl PR.

### Testing expert
- R1: Checked — no reimplementation.
- R2-R11: N/A docs-only.
- R12: Finding T10.
- R13: N/A.
- R14: Finding T10.
- R15-R23: N/A.
- R24: Finding T13.
- R25-R31: N/A.
- R32: Finding T11.
- R33-R34: N/A.
- R35: Checked — deferred.
- RT1: Findings T2, T3, T4, T7.
- RT2: Publisher testable via existing patterns. S3 needs MinIO. GitHub Release needs http.createServer fake. CLI testable. All achievable.
- RT3: No current finding (code doesn't exist).

---

# Rounds 2–6 Progressive Summary

Each round below is the incremental review of the changes since the previous round. Findings detected in each round were applied to the plan before the next round started; resolution is tracked inline in the plan via `closes <ID>` markers next to the modified passages.

## Round 2

Date: 2026-05-01
Changes from Previous Round: applied all Round 1 findings (Critical 2 + Major 12 + Minor 17). Plan grew from 307 → 421 lines.

| Severity | Functionality | Security | Testing | Total (after dedup) |
|---|---|---|---|---|
| Critical | 0 | 0 | 0 | 0 |
| Major | 3 (F1≡S1 dedup) | 3 | 7 | 12 |
| Minor | 5 | 7 | 5 | 17 |

**New findings**: F9 (env-var name mismatch `DEPLOYMENT_HMAC_SECRET` ↔ `AUDIT_ANCHOR_TAG_SECRET`); F10 (≡T17, `WEBHOOK_DISPATCH_SUPPRESS` membership unspecified); F11 (`last_anchor_updated_at` ↔ actual column `updated_at`); F12 (dead enum value risk for `_KEY_ROTATED` / `_PUBLISH_PAUSED`); N1 (table-level vs column-level SELECT on `tenants`); N2 (KMS migration milestone unstated); N3 (`tenantTag` HMAC encoding unspecified); N4 (dashboard session hijack threat-model boundary missing); N5 (Mechanism B partial-cover race — Mechanism A固定推奨); N6 (pause formula idle-tenant pathological case); N7 (CLI `kid` validation absent); N8 (`DEPLOYMENT_ID` rotation enforcement absent); N9 (CLI `--tag-secret` shell-history leak); T11 (R32 regex missing hyphen); T15 (`check-bypass-rls.mjs` ALLOWED_USAGE update absent); T16 (i18n / `AUDIT_ACTION_GROUP_MAINTENANCE` membership unstated); T18 (`computeTenantTag` golden-value test absent); T14 (subprocess test pattern citation error).

**User decisions during Round 2**: S6 → option (c) HMAC `tenantTag`; F7 → option (c) tiered scale gate (10k / 100k); F12 → option (a) emit-path assignment; N5 → option (a) Mechanism A固定.

## Round 3

Date: 2026-05-01
Changes from Previous Round: applied all Round 2 findings. Plan grew from 421 → 482 lines (`tenantTag` HMAC adopted + 30-day overlap rotation + Mechanism A fixed + KMS milestone documented).

| Severity | Functionality | Security | Testing | Total |
|---|---|---|---|---|
| Critical | 0 | 0 | 0 | 0 |
| Major | 1 (F14 ≡ R3-N8) | 1 (R3-N8 dup) | 2 | 3 (after dedup) |
| Minor | 2 | 4 | 5 | 11 |

**New findings**: F13 (`auditOutbox` in `ALLOWED_USAGE` is vacuous because `logAuditAsync` opens its own tx); **F14 ≡ R3-N8** (`system_settings` table CREATE migration absent — would crash implementation); F15 (`tenants` "organization name / billing fields" wording does not match actual schema columns); R3-N1 (table-level SELECT blast radius — recommend Prisma `select` mitigation); R3-N5 (advisory-lock silent exit unobservable); R3-N2 (KMS milestone tracking absent from Action items); R3-F12 (`AUDIT_ANCHOR_PUBLISH_PAUSED` rate-limit mechanism unspecified); R3-N7 (archive-URL source ambiguous); RT1 (concurrent-publisher test stale wording — references rejected Mechanism B); RT2 (golden-value `openssl` command has wrong escape — `\\x00` vs `\x00`); RT3 (T12 missing `tenants` SELECT success assertion); RT4 (`audit-bypass-coverage.test.ts` sweep extension obligation absent); RT5 (N7/N8/N9 lack test specifications); RT6 (`_PAUSED` / `_KEY_ROTATED` emit tests absent); RT7 (CLI `--my-tenant-id` UPPERCASE rejection test absent).

**User decisions during Round 3**: F14 → option (a) generic key-value `system_settings` table; R3-N7 → option (a) env var; R3-F12 → option (a) cron-style trigger (implicit 1 emit/cadence).

## Round 4

Date: 2026-05-01
Changes from Previous Round: applied all Round 3 findings. Plan grew from 482 → 483 lines (mostly inline expansion of existing sections; new `system_settings` migration added; Testing strategy expanded with N7/N8/N9 specs + WEBHOOK sweep).

| Severity | Functionality | Security | Testing | Total |
|---|---|---|---|---|
| Critical | 1 (R4-F1 ≡ R4-B1) | 1 (R4-B1 dup) | 0 | 1 (after dedup) |
| Major | 0 | 1 (R4-B2 — RLS bypass) | 1 (TF2 — enum misuse blocker) | 2 |
| Minor / Informational | 0 | 2 (R4-N3, R4-N4) | 3 (TF1, TF3, TF4) | 5 |

**New findings**: **R4-F1 ≡ R4-B1** (cadence-end post-check uses `SELECT FROM audit_logs` but publisher has no SELECT on `audit_logs` per NFR5 — implementation crashes); R4-B2 (`system_settings` access requires `withBypassRls`, not stated in Step 8 enforcement; `systemSettings` missing from ALLOWED_USAGE); R4-N3 (archive URL conflated read/write); R4-N4 (advisory-lock-hung scenario explanation thin); TF1 (Testing strategy line 339 missing the `printf` clarification — implementation produces silent wrong golden value); **TF2** (`AUDIT_ANCHOR_KEY_ROTATED` overloaded for `DEPLOYMENT_ID` change — semantically incorrect, enum-value addition is irreversible); TF3 (RT6 PUBLISH_PAUSED test requires real-time advance — needs clock injection); TF4 (file-mode test portability).

**User decisions during Round 4**: R4-F1/B1 → option (C) reuse `audit_chain_anchors.last_published_at` (existing grant); TF2 → option (B) remove the `_KEY_ROTATED` assertion (operator manual DB UPDATE is captured by DB-level audit, not application emit). Reminder from user: project is pre-1.0 development phase — migration irreversibility is not a hard constraint.

## Round 5

Date: 2026-05-01
Changes from Previous Round: applied all Round 4 findings. Plan size effectively unchanged.

| Severity | Functionality | Security | Testing | Total |
|---|---|---|---|---|
| Critical | 0 | 0 | 0 | 0 |
| Major | 0 | 1 | 0 | 1 |
| Minor | 0 | 1 | 0 | 1 |

**New findings**: **Round 5 Major** (atomicity wording: "destination upload + UPDATE in single transaction with destination-IO error rollback" is architecturally impossible because HTTP I/O cannot participate in a PostgreSQL transaction — wording rewritten to specify "uploads first → confirm success → DB UPDATE as final write"); **Round 5 Minor** (Prisma model naming: `systemSettings` plural would not match the project's PascalCase-singular convention — model is `SystemSetting`, accessor `prisma.systemSetting`, and `ALLOWED_USAGE` entry must be `"systemSetting"`).

## Round 6

Date: 2026-05-01
Changes from Previous Round: applied both Round 5 findings.

**Result**: **No findings — plan ready for commit.**

---

# Closure Statement

Phase 1 closed after 6 review rounds. The plan transitioned from initial 307-line draft to 485-line ratification-ready ADR. Approximately 71 distinct findings were detected and resolved across the rounds. Resolutions are tracked inline in the plan via `closes <ID>` markers (44+ such markers at closure). The plan is recommended for ratification by the maintainer; subsequent implementation will follow in a dedicated implementation-plan PR.
