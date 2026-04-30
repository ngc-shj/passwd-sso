# ADR / Plan: Audit Anchor External Commitment

**Status**: Proposed (Decision: **TBD** — recommended option per axis is marked `Recommended:`)
**Date**: 2026-05-01
**Trigger**: External security review item `#3` deferred from PR #413 with the note "operational decision (signing key location, frequency, store) needed first." This document gathers the decision axes, presents the option space, and recommends a default for each axis so the maintainer can ratify or amend in one pass.

> **Reading guide**: this is BOTH a triangulate plan (sections per the skill template) AND the draft ADR. After ratification, sections 1-3 (Project context, Objective, Requirements) collapse into ADR Context; "Recommended" markers become the Decision. The file may be renamed to `audit-anchor-external-commitment-design.md` on PR merge to match the existing ADR convention (`email-uniqueness-design.md`).

---

## Project context

- **Type**: web app + service (Next.js 16 app + outbox worker process + soon a publisher worker)
- **Test infrastructure**: unit + integration (real-DB) + E2E (Playwright) + CI/CD (GitHub Actions, `scripts/pre-pr.sh`)
- This document is `docs`-scope; the implementation that follows it will introduce a new long-running runtime artifact (publisher worker), which is in scope for R32 / R35 verification but only when implementation lands — not in this ADR PR.

## Objective

Decide the operational shape of the audit hash chain's **external commitment**: who signs the per-tenant anchor, how often, and where the signed artifact is published, so a customer (or auditor) holding only the public key + the publicly-published artifact can detect a server-side rewrite of historical `audit_logs` rows that the internal chain alone cannot reveal.

> **Threat resolved by external commitment**: an attacker with database write access (or a malicious operator) can rewrite past `audit_logs` rows AND recompute the entire `event_hash` / `chain_prev_hash` / `audit_chain_anchors` set so the internal `/api/maintenance/audit-chain-verify` endpoint reports OK. External commitment defeats this by anchoring the chain state to an artifact the attacker cannot retroactively alter (because copies exist outside the attacker's control).

## Current state (factual baseline)

Verified against the codebase on 2026-05-01:

| Item | Value | Source |
|---|---|---|
| Chain hash function | `SHA-256(prevHash ‖ JCS-canonical(payload))` per RFC 8785 | [src/lib/audit/audit-chain.ts:83-91](../../../src/lib/audit/audit-chain.ts#L83-L91) |
| Chain payload | `{ id, createdAt, chainSeq, prevHash, payload }`; `payload` is the sanitized audit metadata | [src/lib/audit/audit-chain.ts:35-67](../../../src/lib/audit/audit-chain.ts#L35-L67) |
| Anchor table | `audit_chain_anchors(tenant_id PK, chain_seq BIGINT, prev_hash BYTEA, updated_at TIMESTAMPTZ)` — one row per tenant | `prisma/migrations/20260413110000_add_audit_chain/migration.sql:15-21` |
| Anchor writer | `audit-outbox-worker` only (`UPDATE` per drained row, batch ≤500, poll 1000ms default) | [src/workers/audit-outbox-worker.ts:204-308](../../../src/workers/audit-outbox-worker.ts#L204-L308) |
| Anchor reader (verify) | Reads `chain_seq` only; `prev_hash` unused on the verify path | [src/app/api/maintenance/audit-chain-verify/route.ts:122-137](../../../src/app/api/maintenance/audit-chain-verify/route.ts#L122-L137) |
| External-facing publication | **None today** | grep returned no S3 / webhook / manifest emitter |
| Chain enable flag | `tenants.audit_chain_enabled BOOLEAN NOT NULL DEFAULT false` (per-tenant, opt-in) | `prisma/migrations/20260413110000_add_audit_chain/migration.sql:12` |
| Genesis prev_hash | 1 byte `\x00` (resolved during Phase 4 review) | `docs/archive/review/durable-audit-outbox-phase4-review.md` |

**Implications for this ADR**

1. The signable unit per tenant is unambiguously `(tenant_id, chain_seq, prev_hash)` — three small fields. We do not need to redesign the chain to add commitment.
2. The publisher does NOT need to inspect `audit_logs` payload — only the anchor row. This keeps PII out of the publisher's surface entirely.
3. Tenants with chain disabled have no anchor; they are excluded from publication by construction.
4. The chain has a per-tenant epoch implicit in `prev_hash`. If we ever reset/rotate a tenant's chain (e.g., tombstone old chain, start a new epoch) we MUST encode the epoch number in the published manifest — the anchor table today has no epoch column. **Out of scope for this ADR; flagged in Action items.**

## Requirements

### Functional

| ID | Requirement |
|---|---|
| FR1 | Publish a signed artifact ("commitment manifest") that allows any holder of the public key to verify the integrity of any tenant's audit chain at the publication snapshot, without server cooperation. |
| FR2 | Manifest covers ALL tenants with `audit_chain_enabled = true` at snapshot time. Tenants disabled at snapshot time are explicitly omitted (not silently absent). |
| FR3 | Each per-tenant entry binds `(tenantId, chainSeq, prevHash, anchoredAt)`. `anchoredAt` is the snapshot time, not `audit_chain_anchors.updated_at`. |
| FR4 | The artifact is detached-signature (signature separable from payload) so the canonical payload can be diffed across publications without re-signing for diff display. |
| FR5 | Verification procedure is documented in a public-facing `docs/security/` page that customers and auditors can follow with off-the-shelf tools (Node `crypto`, `openssl`, `age`, etc.). |
| FR6 | Publication failure (signing key unavailable, store unavailable) emits an audit event AND blocks chain advancement past the latest anchored seq for the affected tenants until resolved (fail-closed) — see "Failure modes" below for the chosen direction. |
| FR7 | Key rotation procedure is defined: generate new key, publish overlap manifest under both keys, retire old key. Rotation does NOT invalidate historical artifacts signed under the old key. |
| FR8 | The `(epoch, chain_seq)` tuple advances non-decreasingly across publications per tenant. Within the same epoch, lower `chain_seq` than a previously-published value IS a tamper signal. Higher `epoch` with lower `chain_seq` is NOT a tamper signal (legitimate epoch reset). The verifier MUST implement the tuple comparison; documenting it in `docs/security/audit-anchor-verification.md` is mandatory. |

### Non-functional

| ID | Requirement |
|---|---|
| NFR1 | Latency from event ingestion to first commitment ≤ chosen publication cadence + 1× cadence jitter (see "Frequency" axis). |
| NFR2 | Manifest size grows O(N tenants), not O(events). For 10k tenants, manifest is ≤ ~2MB raw, ≤ ~600KB gzipped. |
| NFR3 | Publication cost is bounded: ≤ 1 signing operation per cadence, ≤ 1 store-write per cadence per destination. Backfill on resume must not stampede. |
| NFR4 | The manifest contains NO PII. Tenant identity is published as `tenantTag` (HMAC-derived; see Axis 6 / Implementation step 5), NOT as raw `tenantId`. `prevHash` is a hash; `chainSeq` is a counter; timestamps are publication-time only. Tenant *names*, user identifiers, and audit metadata MUST NEVER be added under any future change without revisiting this ADR. |
| NFR5 | The publisher process is operationally separable from the outbox worker (different DB role `passwd_anchor_publisher`). Required grants: `SELECT` on `audit_chain_anchors`, `UPDATE` on `audit_chain_anchors(publish_paused_until, last_published_at)` only, `SELECT` on `tenants(id, audit_chain_enabled)`, `INSERT` on `audit_outbox`. **No `SELECT` on `audit_logs` is granted** — `metadata` is therefore inaccessible by omission, not by column-level REVOKE (column-level REVOKE in PG cannot restrict a table-level grant; see Implementation step 2). The publisher emits its own audit events via `logAuditAsync` → `audit_outbox`, drained by `passwd_outbox_worker`; the publisher never INSERTs into `audit_logs` directly. |

## Decision axes

Each axis below presents 2-4 options with a recommended default. The recommendation is non-binding until ratified.

### Axis 1: Signing scope (per-tenant anchor vs. cross-tenant Merkle root)

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **1A. Per-tenant anchor entries inside one signed manifest** | Verifier only needs the manifest + public key; no Merkle proof construction. Manifest size O(tenants) — acceptable for our customer scale. Matches existing `audit_chain_anchors` table 1:1. | Manifest grows linearly; 100k+ tenants would require sharding. | ✅ **Recommended**. **Tiered scale gate (F7)**: **<10k tenants** = no concern (recommended baseline). **10k-100k** = add publication-size monitoring (manifest byte-size alerting in operator dashboard, switch to gzip-only payload). **>100k** = revisit Option 1B (Merkle root + per-tenant proof endpoint). |
| 1B. Merkle root over tenants, publish only root + per-tenant inclusion proof on request | Constant-size manifest. | Verifier needs a proof retrieval endpoint, which itself needs DoS protection. Adds an extra trust surface (proof endpoint). Premature optimization at our scale. | Rejected at current scale. Reconsider when 1A's tiered gate hits the >100k threshold (see 1A). |
| 1C. Per-tenant *separate* signed artifacts (one S3 object per tenant per cadence) | Tenants only fetch their own artifact. | O(tenants) S3 PUTs per cadence — at 10k tenants × daily that is 3.6M PUTs/year per destination, real cost. Operational complexity. | Rejected. |

### Axis 2: Signature algorithm

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **2A. Ed25519** (RFC 8032) | 64-byte signatures, fast, simple, broadly supported (`node:crypto`, OpenSSL ≥1.1.1, all major languages). No padding ambiguity. | None at our scale. | ✅ **Recommended.** |
| 2B. ECDSA P-256 | FIPS 140-3 friendly. | Signature non-determinism + need for RNG correctness. Larger ASN.1 envelope. | Rejected unless a customer requires FIPS. (None has asked.) |
| 2C. RSA-PSS-2048 | Widely understood. | 256-byte signatures, slower, no operational benefit. | Rejected. |

### Axis 3: Signing key custody

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| 3A. Plaintext key in env var | Simple. | Key in process memory + env dump risk. Plain env var is the lowest bar. | Rejected. |
| **3B. Key wrapped by `share-master` envelope KEK (existing `KeyProvider`), stored encrypted in DB or filesystem** | Reuses already-versioned KEK that PR #413 / `accounts.refresh_token` encryption already adopted. Operationally familiar. Rotation hooks already exist. | Still software custody (no HSM separation). **Trust zone caveat (S3)**: the encrypted private key lives in the SAME trust boundary as the threat actor (DB write + app server env hold both `SHARE_MASTER_KEY` and the wrapped key). An operator with both can decrypt and forge — encryption only adds a step, not a boundary. See "Trust zone analysis" in Considerations. | ✅ **Recommended for v1**, with full acknowledgement that v1 only defeats insiders WITHOUT app-server env access. KMS migration (3C) is the v2 trust-boundary target. |
| 3C. Cloud KMS-managed signing (AWS KMS / GCP KMS) | Hardware boundary, audit log on every signature, key non-exportable. | New cloud dependency, latency on every sign, cost per signature. Self-hosted deployments lose this option. | Recommended as **v2 migration target** once we are on KMS for other materials. |
| 3D. Hardware HSM (YubiHSM / CloudHSM) | Strongest custody. | Not justified at current threat model. | Rejected at v1. |

### Axis 4: Publication cadence

The cadence choice is a trade-off between freshness (smaller "rewrite window" between commitments) and operational cost.

| Option | Rewrite window | Cost / year | Verdict |
|---|---|---|---|
| 4A. Real-time (every event) | Near-zero | Prohibitive (every audit event triggers a sign + publish). Defeats batching. | Rejected. |
| 4B. Hourly | ≤ 1h | 8,760 manifests / store / year. Manageable but high. | Reconsider for high-assurance customers as opt-in. |
| **4C. Daily (24h, fixed UTC offset, e.g. 00:05 UTC)** | ≤ 24h | 365 manifests / store / year. Easy to reason about. Aligns with most compliance frameworks (SOC 2, ISO 27001 commit-evidence cadence). | ✅ **Recommended** for v1. |
| 4D. Weekly | ≤ 7d | 52 manifests / year. Cheap. | Too coarse — 7-day rewrite window is incompatible with most regulated-customer expectations. |

### Axis 5: Publication destination

The destination decision is independent of axis 1-4 and is the highest-leverage axis: a strong signature on an artifact only the attacker can serve provides no security.

| Option | Tamper-resistance | Cost | Customer-verifiability | Verdict |
|---|---|---|---|---|
| 5A. Self-hosted S3 Object Lock (compliance mode) | High — Object Lock prevents deletion/overwrite even by the account root for the retention period | Low | Customer downloads the object; trust depends on AWS account integrity | Component of recommendation. |
| 5B. GitHub Release asset | Medium — public, third-party hosted, but a malicious maintainer can delete/edit a release | Free | Excellent (curl-able URL); GitHub keeps an immutable audit log of release changes | Component of recommendation. |
| 5C. Customer-emailed signed artifact | Medium — copies exist in customer mailboxes outside our control | Low | Each customer holds independent copies | Component of recommendation. |
| 5D. Public blockchain commit (Bitcoin OP_RETURN, Ethereum log) | Very high tamper-resistance (proof-of-work / proof-of-stake economic security) | Variable, non-trivial, requires wallet operations | Excellent | Too operationally heavy for v1; reconsider if customer demand emerges. |
| 5E. Certificate Transparency-style log (RFC 6962) | High; needs operating a CT-like log + monitors | High operational cost | Excellent in theory | Out of scope; revisit only at scale. |

**Recommended (multi-destination, defense-in-depth)**:
- **Primary**: S3 Object Lock with 7-year retention in compliance mode (5A).
- **Secondary mirror**: GitHub Release in a public `audit-anchors` repository (5B). Same artifact bytes, cross-checked.
- **Tertiary (per-tenant opt-in)**: Email a signed digest of the customer's own tenant entry to a customer-designated audit-archive email address (5C). Provides customer-side custody without our involvement.

The verifier checks the artifact's bytes are byte-identical across primary and secondary. A discrepancy is itself a tamper signal.

### Axis 6: Artifact format

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **6A. Detached JWS (RFC 7515) over JCS-canonical (RFC 8785) JSON** | Industry-standard, library support, separable signature + payload, matches the chain's existing canonicalization choice. Compact. | JOSE has historical foot-guns (`alg: none`); we pin `alg: EdDSA` and reject mismatch in verifier. | ✅ **Recommended.** |
| 6B. COSE (RFC 9052) over CBOR | Compact, IoT-aligned. | CBOR tooling is less ubiquitous in customer environments than JSON. | Rejected. |
| 6C. PGP signed JSON | Familiar to operations. | PGP is widely deprecated for new designs (key-management complexity, mixed-tooling). | Rejected. |

**Manifest schema (JSON, before JCS canonicalization)**:

```json
{
  "$schema": "https://passwd-sso.example/schemas/audit-anchor-manifest-v1.json",
  "version": 1,
  "issuer": "passwd-sso",
  "deploymentId": "<UUID — operator-set DEPLOYMENT_ID env var, stable across restarts>",
  "anchoredAt": "2026-05-02T00:05:00.000Z",
  "previousManifest": {
    "uri": "s3://.../2026-05-01.jws",
    "sha256": "<hex>"
  },
  "tenants": [
    {
      "tenantTag": "<hex of HMAC-SHA256(AUDIT_ANCHOR_TAG_SECRET, 'audit-anchor-tag-v1' || 0x00 || tenantId)>",
      "chainSeq": "12345",
      "prevHash": "<hex of last event_hash>",
      "epoch": 1
    }
  ]
}
```

JWS protected header pins `alg: EdDSA`, `kid: <key-id>`, `typ: passwd-sso.audit-anchor.v1`. The signing input is JCS-canonical(manifest); the JWS payload field carries the raw JSON bytes (so verifier can re-canonicalize and compare).

**`tenantTag` derivation (S6 — tenant UUID confidentiality)**: the manifest publishes `tenantTag` instead of raw `tenantId` so third-party observers cannot enumerate tenant existence or activity volume from the public artifact. A customer holding their own `tenantId` and the deployment's `AUDIT_ANCHOR_TAG_SECRET` (distributed via the existing customer admin channel — dashboard kit + MFA challenge) can compute their own `tenantTag` and locate their entry. The HMAC key is sourced from `KeyProvider` (key name `"audit-anchor-tag-secret"`, see Implementation step 4), used directly as the HMAC-SHA256 key. The 0x00-byte separator + domain label `"audit-anchor-tag-v1"` provide cross-protocol confusion resistance. **Threat-model coverage**: the HMAC defeats anonymous third-party enumeration; collusion among customers can only ever expose the tags of tenants those customers themselves hold the IDs for; brute-forcing requires the secret. **Limitation**: any party who legitimately holds the secret AND any tenant's UUID can recover that tenant's tag — distribution is therefore restricted to authenticated tenant administrators of the same deployment.

**Verifier `alg`/`typ` enforcement (S7)**: implementations of the verifier MUST hardcode `header.alg === 'EdDSA'` as a string-equality guard BEFORE invoking `crypto.verify`, and reject any other value (including `none`, `HS256`, `RS256`, `ES256`, `null`, `undefined`) with a typed error `InvalidAlgorithmError`. The `algorithms` parameter passed to any underlying JOSE library (if used) MUST NOT be configurable — it is a constant `['EdDSA']`. The verifier MUST also hardcode `header.typ === 'passwd-sso.audit-anchor.v1'` to prevent cross-format confusion (e.g., a chain payload accidentally accepted as a manifest, or vice versa). These are the verifier library's responsibility (Implementation step 6); the CLI surface (Implementation step 10) wraps but does not weaken them.

**JCS canonicalization scope note (S8)**: the existing `jcsCanonical` helper in [src/lib/audit/audit-chain.ts:9-30](../../../src/lib/audit/audit-chain.ts#L9-L30) sorts object keys with JavaScript `Array.prototype.sort()` (UTF-16 code unit order). For BMP-only ASCII keys this is identical to RFC 8785 §3.2.3 (Unicode code-point order); all manifest field names are ASCII by mandate. Manifest field names (current and any future addition) MUST be ASCII; this is enforced by the `Manifest` Zod schema in the manifest library. If a future requirement demands non-BMP keys, switch to an RFC-8785-compliant comparator (or import the `canonicalize` npm package) at that time — the constraint is documented inline at the canonicalizer's call site.

### Axis 7: Verification surface

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| 7A. Customer runs a CLI we ship | Full programmatic verification including chain replay against their own DB export. | Requires CLI installation. | Component of recommendation (ship as `passwd-sso audit-verify`). |
| 7B. Customer follows a pure-shell `openssl` recipe in `docs/security/audit-anchor-verification.md` | Zero dependency beyond `openssl` + `jq`. | Cannot replay chain; only verifies signature + manifest format. | Component of recommendation as the "lightweight quick-check". |
| **Recommended: 7A + 7B together** | CLI for full verification, shell recipe for quick spot checks. | Slight maintenance overhead (two paths). | ✅ |

### Axis 8: Failure-mode policy (fail-open vs fail-closed)

| Failure | Fail-open behavior | Fail-closed behavior | Recommended |
|---|---|---|---|
| Signing key unavailable | Skip publication, continue chain | Block chain advancement past last-anchored seq | **Fail-closed**. On each consecutive failure, the publisher writes `publish_paused_until = LEAST(now() + 1× cadence, GREATEST(audit_chain_anchors.updated_at, now()) + 3× cadence)` — sliding window with **hard upper bound at 3× cadence (S9)**. Audit-emit on every skip. After 3× cadence with no recovery, on-call paging escalates to incident severity. The cap exists because PENDING `audit_outbox` rows accumulated during the pause are NOT protected by any prior manifest; an unbounded pause widens the rewrite-vulnerable window indefinitely. |
| Primary destination unavailable | Continue with secondary | Block until both destinations succeed | **Continue with secondary** + audit; require both within 1× cadence. |
| Manifest schema validation fails post-sign | Publish anyway | Block | Block. Schema mismatch is a programming error, not a transient fault. |
| Anchor regression detected (chain_seq decreased) | Publish | Block, page on-call | Block. Regression is either a bug or active tampering. |

> **Why fail-closed for the signing key**: an attacker who can suppress signing (e.g., DoS the publisher) and then rewrite history before the next publication would otherwise have a free rewrite window. Fail-closed bounds the worst-case window to one cadence.

> **Caveat — "block chain advancement"**: today the audit chain is mandatory for write paths only when `audit_chain_enabled = true`; blocking advancement means audit_outbox rows for chain-enabled tenants stop draining, which in turn means audit *emission* visible to the user does not stop, but visibility of *chained* events lags. We MUST verify this does not produce a runtime stall under sustained outage. See "Considerations & constraints" below.

> **Protection-boundary clarification (S9)**: events committed to `audit_logs` with `chain_seq ≤ last_published_chain_seq` are protected by the published manifest. Events with `chain_seq > last_published_chain_seq` (including PENDING `audit_outbox` rows during a pause) are NOT yet protected — an insider with DB write can modify them. The 3× cadence cap bounds the exposure of PENDING rows. `docs/security/audit-anchor-verification.md` MUST state customer-facing wording: "your downloaded manifest authoritatively covers events up through `chain_seq = N`. Events after `N` are pending and not yet committed."

## Recommended overall configuration ("Option X")

| Axis | Recommendation |
|---|---|
| 1 Signing scope | Per-tenant entries (HMAC `tenantTag`, NOT raw `tenantId`) inside one signed manifest |
| 2 Algorithm | Ed25519 |
| 3 Key custody | `KeyProvider` envelope-encrypted (v1); KMS migration v2 |
| 4 Cadence | Daily (24h, 00:05 UTC) |
| 5 Destination | S3 Object Lock (primary) + GitHub Release mirror (secondary) + opt-in customer email (tertiary) |
| 6 Format | Detached JWS over JCS-canonical JSON, `alg: EdDSA`, `typ: passwd-sso.audit-anchor.v1` |
| 7 Verification | Ship `passwd-sso audit-verify` CLI + `openssl` shell recipe in `docs/security/audit-anchor-verification.md` |
| 8 Failure mode | Fail-closed on signing key; secondary-tolerant on destinations; block on regression |

Estimated implementation cost (informational, not part of this ADR's decision):
- New publisher worker (`src/workers/audit-anchor-publisher.ts`) + Docker service: ~1 week
- KeyProvider integration + key generation script: ~2 days
- Manifest schema + signer/verifier libraries: ~3 days
- CLI subcommand + shell recipe + customer docs: ~3 days
- Tests (unit + integration with real S3 mock + CI scheduled E2E): ~1 week

## Implementation steps (consequence of ratification — NOT part of this ADR)

These are deferred to a separate plan PR after this ADR is ratified. Listed here so reviewers can sanity-check feasibility but should NOT be reviewed as if they are this PR's deliverable.

1. **Schema and audit-action enum**:
   - **Migration A (additive)**:
     - Add `audit_chain_anchors.epoch INTEGER DEFAULT 1` (nullable initially), `audit_chain_anchors.publish_paused_until TIMESTAMPTZ NULL`, and `audit_chain_anchors.last_published_at TIMESTAMPTZ NULL` (the last column was retained from Round 2 design but is no longer needed for serialization after Mechanism A fixation in Step 3 — kept for future observability / dashboard purposes; nullable, no consumer in v1).
     - **Add `system_settings` table (closes R3-N8 / F14)** — generic single-row-per-key key-value store for deployment-wide settings:
       ```sql
       CREATE TABLE IF NOT EXISTS system_settings (
         key        TEXT PRIMARY KEY,
         value      TEXT NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
       );
       ```
       Generic shape (`key`/`value`) chosen over a single-purpose `audit_anchor_deployment_id UUID UNIQUE` column so future deployment-wide settings can reuse the same table without further migrations. RLS: `ENABLE ROW LEVEL SECURITY` + a policy permitting access only when `app.bypass_rls = 'on'` (the publisher's read uses `withBypassRls`). Grants: `SELECT, INSERT, UPDATE` on `system_settings` to `passwd_anchor_publisher` (covered by Step 2 grant list). **Prisma model naming**: the `prisma/schema.prisma` `model` block MUST be `SystemSetting` (PascalCase singular, consistent with project convention — see `AuditLog`, `AuditChainAnchor`, `AuditOutbox`, `Tenant`, `Session`, etc.). The Prisma client accessor is therefore `prisma.systemSetting` (camelCase singular). The `check-bypass-rls.mjs` ALLOWED_USAGE entry (Step 14) MUST use `"systemSetting"` (singular) to match this accessor.
   - **Migration A backfill**: `UPDATE audit_chain_anchors SET epoch = 1 WHERE epoch IS NULL`.
   - **Migration B (strict)**: `ALTER TABLE audit_chain_anchors ALTER COLUMN epoch SET NOT NULL`. Run only AFTER Migration A + the outbox-worker patch (Step 3) have shipped to all environments. `publish_paused_until` and `last_published_at` stay nullable permanently.
   - **AuditAction enum values (F4 + F12 emit-path assignment)**: add 4 values via `ALTER TYPE "AuditAction" ADD VALUE` (idempotent PG pattern). **Each value MUST have a defined emit site (closes F12 — prevents dead enum values, since `ALTER TYPE ADD VALUE` is irreversible in PG)**:
     - `AUDIT_ANCHOR_PUBLISHED` — emitted by the publisher on each successful manifest publication; metadata includes `manifestSha256`, `destinations[]`, `tenantsCount`.
     - `AUDIT_ANCHOR_PUBLISH_FAILED` — emitted by the publisher on each failure that triggers `publish_paused_until` set (signing key unavailable, both destinations down, schema-validation failure); metadata includes `failureReason`, `pausedUntil`, `consecutiveFailureCount`.
     - `AUDIT_ANCHOR_PUBLISH_PAUSED` — emitted by the publisher when it skips a cadence because `publish_paused_until > now()` is still active (distinct from `_FAILED`: this fires when the publisher wakes during a pause, so on-call dashboards can quantify pause duration). **Rate-limit semantics (closes R3-F12)**: the publisher uses a cron-style daily trigger (Step 7), so it wakes exactly once per cadence — the rate-limit is therefore implicit (1 emit per cadence) and requires no in-memory counter or DB column. If a future deployment changes the trigger to continuous polling, an explicit rate-limit (e.g., `system_settings` row tracking last paused emit) MUST be added at that time and the change re-reviewed.
     - `AUDIT_ANCHOR_KEY_ROTATED` — emitted by `scripts/rotate-audit-anchor-key.sh` at the start of the overlap window AND at the end (private-key destruction); metadata includes `oldKid`, `newKid`, `phase: "overlap-start" | "overlap-end"`.
   - **Constants module updates** (`src/lib/constants/audit/audit.ts`):
     - extend `AUDIT_ACTION` constant + `AUDIT_ACTION_VALUES` array.
     - **Group membership**: all 4 values join `AUDIT_ACTION_GROUP_MAINTENANCE` (mirrors existing `AUDIT_CHAIN_VERIFY` placement). Do NOT add to `AUDIT_ACTION_GROUPS_PERSONAL` or `AUDIT_ACTION_GROUPS_TEAM` — these are operator-domain events. The existing `audit-bypass-coverage.test.ts` enforces this exclusion.
     - **`OUTBOX_BYPASS_AUDIT_ACTIONS`**: EXCLUDE — publisher emits via `logAuditAsync` → `audit_outbox`, drained by `passwd_outbox_worker` (separate process, no recursion risk).
     - **`WEBHOOK_DISPATCH_SUPPRESS` (closes F10/T17)**: ADD all 4 values. These are operator-internal events with no customer-actionable payload (analogous to existing `AUDIT_CHAIN_VERIFY`, which is already in this set). A customer webhook subscription to `AUDIT_ANCHOR_PUBLISHED` would be unexpected and noisy. The implementation PR's webhook test must assert all 4 are in `WEBHOOK_DISPATCH_SUPPRESS`.
   - **i18n coverage (closes T16)**: add an entry for each new action to `messages/en/AuditLog.json` AND `messages/ja/AuditLog.json` (Japanese translation: 監査アンカー公開済み / 公開失敗 / 一時停止中 / 鍵ローテーション完了 — final wording per ja convention). The existing `src/__tests__/audit-i18n-coverage.test.ts` enforces both files have entries for every `AUDIT_ACTION_VALUES` member; missing entries fail the test.
2. **DB role (closes F1, S1, S2)**: create new least-privilege role `passwd_anchor_publisher` (NOSUPERUSER, NOBYPASSRLS) with grants:
   - `SELECT` on `audit_chain_anchors` (full row — needs `epoch`, `prev_hash`, `chain_seq`, `publish_paused_until`, `last_published_at`).
   - `UPDATE` on `audit_chain_anchors(publish_paused_until, last_published_at)` — column-level grant: `GRANT UPDATE (publish_paused_until, last_published_at) ON audit_chain_anchors TO passwd_anchor_publisher`. Publisher MUST NOT modify `chain_seq` or `prev_hash` — `passwd_outbox_worker` is the sole writer of those.
   - `SELECT` on `tenants` — **table-level** grant (closes N1). Mirror the existing `dcr-cleanup-worker` migration: `GRANT SELECT ON TABLE tenants TO passwd_anchor_publisher`. Required for two implicit reads: (a) `enqueueAuditInTx` runs `SELECT EXISTS (SELECT 1 FROM tenants WHERE id = $1)` before each `audit_outbox` INSERT; (b) the `tenants.audit_chain_enabled` filter to enumerate chain-enabled tenants. **Trade-off (closes F15)**: table-level SELECT also exposes the publisher to the OTHER `tenants` columns — concretely (per current `prisma/schema.prisma` `Tenant` model): `name`, `slug`, `description` (tenant identifiers); `tailscale_tailnet`, `allowed_cidrs` (network topology); `external_id` (IdP linkage); plus security-policy columns (`session_idle_timeout_minutes`, password-policy / lockout fields). **Code-level mitigation (closes R3-N1)**: the publisher's Prisma queries against `tenants` MUST use explicit `select: { id: true, audit_chain_enabled: true }` so the type system forbids retrieving other columns; this reduces the blast radius of an ORM-misuse to nil at compile time, and table-level grant covers the runtime FK / EXISTS reads that ORM `select` cannot scope. **Code-review obligation**: every publisher SELECT against `tenants` MUST be reviewed for `select` scope; any addition that drops the explicit `select` is a finding. The brittle alternative — column-level `SELECT (id, audit_chain_enabled)` — relies on PG's "column-level suffices for `SELECT 1 FROM table`" semantic, which is fragile and inconsistent with the established `dcr-cleanup-worker` precedent.
   - `INSERT` on `audit_outbox`. Publisher emits its own audit events via `logAuditAsync` → `audit_outbox`; `passwd_outbox_worker` (separate role) drains them into `audit_logs`.
   - `SELECT, INSERT, UPDATE` on `system_settings` (closes R3-N8). Required for `DEPLOYMENT_ID` enforcement (Step 8): first-boot `INSERT ON CONFLICT DO NOTHING` and subsequent-boot `SELECT` of the `audit_anchor_deployment_id` row. UPDATE is required for the operator-driven legitimate rotation path (runbook).
   - **NO `SELECT` on `audit_logs` is granted.** `metadata` is therefore inaccessible BY OMISSION, not by column-level REVOKE. **DO NOT** add `REVOKE SELECT (metadata) ON audit_logs FROM passwd_anchor_publisher` — in PG, `REVOKE column FROM role` only retracts a previously-granted column-level privilege; it does NOT carve an exception out of a future table-level grant. If a debugging-time SELECT on audit_logs is ever needed, the correct pattern is `CREATE VIEW anchor_publisher_audit_view AS SELECT id, tenant_id, chain_seq, event_hash, chain_prev_hash FROM audit_logs` and grant SELECT on the view, never on the table.
   - **R14 grant completeness check**: enumerate every implicit read the publisher's code path triggers (FK validation, conflict resolution, RLS policy comparison reads). The list above accounts for: `audit_chain_anchors` UPDATE (FK `tenant_id → tenants.id` covered by `tenants(id)` SELECT); `audit_outbox` INSERT (uses `enqueueAuditInTx` pattern from `dcr-cleanup-worker`).
2a. **RLS bypass for cross-tenant anchor read (closes F2)**: `audit_chain_anchors` has `FORCE ROW LEVEL SECURITY` (migration `20260413110000_add_audit_chain/migration.sql:28-38`). The publisher must read all chain-enabled tenants in a single query, so it MUST set `app.bypass_rls='on'` on its DB session before anchor-read queries. Use the existing helper `withBypassRls(prisma, fn, BYPASS_PURPOSE.AUDIT_ANCHOR_PUBLISH)` — and add `AUDIT_ANCHOR_PUBLISH` to the `BYPASS_PURPOSE` enum in `src/lib/tenant-rls.ts` as a NEW dedicated purpose, distinct from `SYSTEM_MAINTENANCE` so audit forensics can distinguish anchor-publish reads from other maintenance reads. Pattern reference: `src/workers/dcr-cleanup-worker.ts` (existing `withBypassRls` consumer); `src/app/api/maintenance/audit-chain-verify/route.ts:122-131` (verify-endpoint usage).
3. **Outbox-worker coordination + concurrent-publisher serialization**:
   - **Outbox-worker patch (closes the fail-closed gap)**: extend `src/workers/audit-outbox-worker.ts:204-308` to honor `audit_chain_anchors.publish_paused_until`. When `publish_paused_until > now()` for a tenant, the worker stops advancing that tenant's `chain_seq` (rows remain in `audit_outbox` with `status=PENDING`). The publisher writes `publish_paused_until = LEAST(now() + 1× cadence, GREATEST(audit_chain_anchors.updated_at, now()) + 3× cadence)` on each consecutive failure (sliding window with 3× cap, S9). On publish success, the publisher clears `publish_paused_until = NULL`. The worker's batch loop tolerates per-tenant skipping by `WHERE` filter; if ALL chain-enabled tenants are paused, the worker idles at the configured poll cadence (no busy-loop). Test invariant: `queryCounter.chainEnableQueries === 0` per poll cycle when 100% of chain-enabled tenants are paused (Testing strategy T6).
   - **Concurrent-publisher serialization (closes F5; N5 — Mechanism A fixed)**: two publisher instances racing (rolling deploy / accidental double-start) would produce dual non-byte-identical manifests for the "same" daily window, breaking `previousManifest.sha256`. **Recommended: Mechanism A — PG advisory lock**. Wrap the entire publish cycle in `pg_try_advisory_xact_lock(hashtext('audit-anchor-publish'))`; if the lock is unavailable, exit cleanly (the other instance is publishing) AND log a structured event with reason `LOCK_HELD_BY_OTHER_INSTANCE` to stdout (not an audit row — this is the normal "lost the race" outcome, not a publication failure). The lock auto-releases at transaction end, so a crashed publisher does not block the next cadence. **Cadence-end safety net (closes R3-N5 + R4-F1/B1)**: at end of cycle, the WINNER updates `audit_chain_anchors.last_published_at = now()` (publisher already has column-level UPDATE on this column per Step 2) atomically with successful manifest publication. If a publisher crashes after S3/GitHub upload but before this UPDATE, the post-check at next cadence detects the gap. The next-cadence publisher runs a one-time post-check before claiming the advisory lock — using **only data the publisher's existing grants cover** (NO `SELECT` on `audit_logs`, NO new view, NO new column): `SELECT MAX(last_published_at) AS last_pub FROM audit_chain_anchors WHERE audit_chain_enabled_tenants_scope`. If `last_pub < <prev cadence boundary>`, the previous cadence was not successfully completed → emit `AUDIT_ANCHOR_PUBLISH_FAILED` with reason `MISSING_PRIOR_CADENCE_PUBLICATION` so on-call sees the silent-skip pattern; the publisher then proceeds with its own cadence as normal. **Why this design**: it relies entirely on `audit_chain_anchors` (publisher has SELECT) — querying `audit_logs` would require `SELECT` privilege the publisher must NOT hold (NFR5). Note the pre-condition: `last_published_at` must be UPDATEd atomically with successful publication. Concrete pattern (closes Round 5 atomicity wording defect): perform ALL destination uploads first (S3 + GitHub Release sequentially or in parallel) → only after every upload confirms success, run the DB `UPDATE audit_chain_anchors SET last_published_at = now() WHERE ...` as the FINAL DB write within the advisory-lock scope. **There is NO mechanism to roll back a completed S3 PUT or GitHub POST from within a PostgreSQL transaction** — HTTP I/O cannot participate in a DB tx. The design tolerates the rare destination-success/DB-UPDATE-failure window via the next-cadence post-check (which fires `MISSING_PRIOR_CADENCE_PUBLICATION`); on-call resolves manually. If ANY destination upload fails, do NOT run the UPDATE — the publisher exits with the existing `AUDIT_ANCHOR_PUBLISH_FAILED` path and `publish_paused_until` is set, leaving `last_published_at` at its previous value so the next cadence's post-check correctly detects the failed cadence. **Mechanism B (conditional UPDATE on `last_published_at`) REJECTED for v1**: the naive form `UPDATE audit_chain_anchors SET last_published_at = now() WHERE tenant_id = ANY($1) AND (last_published_at IS NULL OR last_published_at < now() - cadence/2) RETURNING tenant_id` has a **partial-cover race** — two simultaneous publishers can each commit UPDATEs on DISJOINT subsets of the same tenant array, producing two manifests for the same cadence boundary that each cover a partial tenant set, breaking the `previousManifest.sha256` chain. Fixing this requires a global serialization barrier (single-row marker table + `SELECT FOR UPDATE`) — at which point Mechanism A is simpler. If a future deployment requires cross-replica advisory locks (e.g., PG read replicas with no shared advisory-lock space), revisit B with the full barrier design and re-review.
4. **KeyProvider extension — closed-union touch-points (closes F3)**: the existing `KeyName` discriminated union in `src/lib/key-provider/types.ts:8` is a closed type. Adding the audit-anchor keys requires touching ALL of the following — missing any one results in the new key silently unavailable in that deployment shape:
   - `src/lib/key-provider/types.ts`: extend `KeyName` with TWO new literals: `"audit-anchor-signing"` (Ed25519 32-byte seed) and `"audit-anchor-tag-secret"` (32-byte raw HMAC-SHA256 key, S6).
   - `src/lib/key-provider/env-provider.ts`: extend `getKeySync` `switch` with cases for both new names. Validate `AUDIT_ANCHOR_SIGNING_KEY` and `AUDIT_ANCHOR_TAG_SECRET` (each 64-char hex = 32 bytes). Reuse the existing `HEX64_RE` validation regex.
   - **All cloud-provider implementations** (`AwsSmKeyProvider`, `GcpSmKeyProvider`, `AzureKvKeyProvider`, plus `EnvKeyProvider`): update `validateKeys` so the publisher boots iff both keys are warmable. Boot failure on absent key = correct fail-closed behavior; do NOT add any default-empty fallback.
   - `src/lib/env-schema.ts`: add `AUDIT_ANCHOR_SIGNING_KEY` and `AUDIT_ANCHOR_TAG_SECRET` to the env Zod object. Add both to the `pick`-list used by the publisher worker entrypoint script (`scripts/audit-anchor-publisher.ts`). Pattern: existing `pick` lists for `audit-outbox-worker` and `dcr-cleanup-worker`.
   - **Reuse over reimplementation (R1, R17)**: before writing any new signing or HMAC code in the manifest library (Step 6), audit `src/lib/crypto/`, `src/lib/auth/`, `src/lib/keys/` for existing helpers. The JCS canonicalizer in [src/lib/audit/audit-chain.ts:9-30](../../../src/lib/audit/audit-chain.ts#L9-L30) is mandatory reuse (do not duplicate); a separate Ed25519 sign helper may not exist yet — Step 6 adds one and ensures a single home.
5. **Generate v1 keys + tag secret derivation**:
   - **Ed25519 signing key**: one-shot script `scripts/generate-audit-anchor-signing-key.sh` produces a 32-byte random seed (via `node:crypto.randomBytes(32)`), wraps with the KeyProvider's existing envelope flow (matching `accounts.refresh_token` shape from PR #413), stores in the DB key-material table. Document operator workflow in the rotation runbook.
   - **Tag secret (S6 — `tenantTag` HMAC key)**: separate one-shot script `scripts/generate-audit-anchor-tag-secret.sh` produces a 32-byte random secret. **Distribution**: the tag secret is NOT public — it is shared with tenant administrators via the same secure channel as their existing admin credentials (e.g., a dashboard "Download my deployment's audit-anchor verification kit" button requiring fresh login + MFA challenge). The kit contains the public signing-key URL, the tag secret, and a CLI snippet showing how to compute the tenant's own tag.
   - **Rotation overlap**: rotating the tag secret is a customer-facing event (existing kits become stale). Plan a 30-day overlap during which manifests publish BOTH old-tag and new-tag entries; document in the rotation runbook in lockstep with signing-key rotation.
   - **No HKDF chain in v1**: the tag secret is the HMAC-SHA256 key directly; the signing key is the Ed25519 seed directly. Both materials are wrapped at rest by the existing `KeyProvider` envelope (Axis 3B). v2 (KMS migration) replaces the wrap layer for both.
6. **Manifest library (`src/lib/audit/anchor-manifest.ts`)** — exports:
   - `buildManifest({ tenants, deploymentId, anchoredAt, previousManifest, tagSecret }) => Manifest`. Per-row `tenantTag = createHmac('sha256', tagSecret).update(Buffer.concat([Buffer.from('audit-anchor-tag-v1', 'utf-8'), Buffer.from([0x00]), Buffer.from(tenantId, 'utf-8')])).digest('hex')`. **Encoding spec (closes N3 — these MUST be enforced in code, not implicit):**
     - `tenantId`: canonical lower-case UUID string per RFC 4122 §3 (36 chars, format `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`), UTF-8 encoded as `Buffer`. Reject any non-canonical input (uppercase letters, missing/extra hyphens, not-36-chars) with a typed error.
     - `tagSecret`: `Buffer` of exactly 32 bytes (NOT a hex string). The KeyProvider returns `Buffer` from `getKeySync('audit-anchor-tag-secret')`; do not re-encode.
     - `domain`: literal ASCII string `'audit-anchor-tag-v1'` (19 bytes), UTF-8 encoded.
     - `separator`: single byte `0x00`.
     - `tagSecret` length, `domain` length, and the `0x00` separator together prevent ambiguity / collision across tenant IDs of different lengths (UUID is fixed-length 36 chars, but the separator is a defense-in-depth invariant).
   - `canonicalize(manifest) => Buffer` — wraps the existing `jcsCanonical` from [src/lib/audit/audit-chain.ts:9-30](../../../src/lib/audit/audit-chain.ts#L9-L30). MUST NOT reimplement. A `Manifest` Zod schema MUST enforce all field names are ASCII (S8 mitigation: avoids the canonicalizer's UTF-16-vs-codepoint divergence for non-BMP keys).
   - `sign(canonicalBytes, signingKey) => string (compact JWS)` — produces detached JWS (RFC 7515) with header pinned to `{alg:"EdDSA", kid:<kid>, typ:"passwd-sso.audit-anchor.v1"}`. Use `node:crypto.sign('ed25519', input, key)` directly; do NOT depend on a generic JOSE library for the signing path.
   - `verify(jws, publicKey) => Manifest | InvalidAlgorithmError | InvalidTypError | InvalidSignatureError`. **Verifier hardening (S7 — mandatory)**: (1) decode protected header BEFORE any signature primitive; (2) hardcoded `if (header.alg !== 'EdDSA') throw new InvalidAlgorithmError(header.alg)` — the literal string `'EdDSA'` MUST be a constant; no config-driven allowlist; (3) hardcoded `if (header.typ !== 'passwd-sso.audit-anchor.v1') throw new InvalidTypError(header.typ)`; (4) reject `header.alg` of `'none'` / `null` / `undefined` / any non-EdDSA value with `InvalidAlgorithmError` (tested explicitly per RT1); (5) only after both assertions pass, call `node:crypto.verify('ed25519', input, publicKey, signature)`; (6) re-canonicalize the body's JSON and compare with the JWS body bytes (catches a payload modified after signing if the signer skipped canonicalization).
   - `computeTenantTag(tenantId, tagSecret) => string` — exposed for the CLI's `audit-verify --my-tenant-id <UUID>` flow. The CLI MUST normalize `--my-tenant-id` input to canonical lower-case UUID (`uuid.toLowerCase()` after format validation) before calling `computeTenantTag`. An uppercase or otherwise-non-canonical UUID input MUST cause a typed error (`InvalidTenantIdFormatError`) rather than silently producing a different tag.
   - **Independent-verifier golden-value test obligation (T2)**: the unit test for `verify` MUST include at least one test vector where the expected signature, manifest body, and `prevHash` are computed offline (using `openssl` CLI or a reference RFC 8785 library) and hardcoded into the test. The test asserts the library's output matches the hardcoded value byte-for-byte. This catches a systematically wrong canonicalization that would otherwise be invisible because both sign and verify use the same internal helper.
   - **`computeTenantTag` golden-value test obligation (closes T18)**: a separate unit test in the manifest library asserts `computeTenantTag(<knownTenantId>, <knownTagSecret>) === <hardcoded hex>` for at least one fixture. The hardcoded hex is computed offline via `openssl dgst -sha256 -mac HMAC -macopt hexkey:<secretHex> <(printf 'audit-anchor-tag-v1\x00<tenantId>')` — note the SINGLE backslash before `x00` so `printf` emits a literal NULL byte (not a 4-char `\x00` string; closes RT2). This catches encoding bugs (wrong domain label, missing 0x00 separator, swapped argument order, hex-vs-Buffer mismatch on the secret) that the cross-deployment isolation test (which only checks two-secret divergence) cannot detect.
7. **Publisher worker**: implement `src/workers/audit-anchor-publisher.ts` long-running daemon with cron-style daily trigger. Audit emission via the existing `logAuditAsync` / outbox path (NOT direct `audit_logs` INSERT) — keeps the publisher's own emissions chained alongside other audit events. **Cron driver injection (closes TF3)**: the cron trigger is a single `runCadence(now: Date): Promise<CadenceOutcome>` function injected at construction time. In production, a thin wrapper (e.g., `node-cron` or systemd timer) invokes `runCadence(new Date())` once per day. In tests, `runCadence` is called directly with synthetic `Date` values to simulate N consecutive cadences without wall-clock waits. This pattern mirrors the existing `audit-outbox-worker` testability with `vi.hoisted` injection.
8. **Constants module + env vars (closes F6)**:
   - **Constants** (extend `src/lib/constants/audit/audit.ts`):
     - `AUDIT_ANCHOR_CADENCE_MS = 24 * 60 * 60 * 1000` (24h)
     - `AUDIT_ANCHOR_PUBLISH_OFFSET_MS = 5 * 60 * 1000` (publish at 00:05 UTC, not 00:00 — cron contention buffer)
     - `AUDIT_ANCHOR_RETENTION_YEARS = 7`
     - `AUDIT_ANCHOR_MANIFEST_VERSION = 1`
     - `AUDIT_ANCHOR_TYP = 'passwd-sso.audit-anchor.v1'`
     - `AUDIT_ANCHOR_PAUSE_CAP_FACTOR = 3` (S9 — sliding pause window cap = `cadence × factor`)
     - `AUDIT_ANCHOR_TAG_DOMAIN = 'audit-anchor-tag-v1'` (S6 HMAC domain separation label)
     - `AUDIT_ANCHOR_KID_PREFIX = 'audit-anchor-'`
   - **Env vars** (extend `src/lib/env-schema.ts`):
     - `DEPLOYMENT_ID` (UUID, operator-set at first deploy, **never rotated** — STABILITY MANDATE: changing this invalidates all existing manifests' `deploymentId` claim and causes verifiers to flag as cross-deployment replay). **Enforcement (closes N8 + R3-N8/F14 + R4-B2)**: stored as a row in the generic `system_settings` table (added in Migration A — see Step 1) at `key = 'audit_anchor_deployment_id'`, `value = <UUID>`. **All publisher access to `system_settings` MUST be wrapped in `withBypassRls(prisma, fn, BYPASS_PURPOSE.AUDIT_ANCHOR_PUBLISH)`** — the table has `FORCE ROW LEVEL SECURITY` with a `bypass_rls=on` policy (Step 1 RLS clause), and `passwd_anchor_publisher` is `NOBYPASSRLS`. First publisher boot performs `INSERT INTO system_settings (key, value) VALUES ('audit_anchor_deployment_id', $env_deployment_id) ON CONFLICT (key) DO NOTHING` (within `withBypassRls`) — race-safe across concurrent first-boot instances (UNIQUE on `key`). On every subsequent boot, the publisher SELECTs that row (within `withBypassRls`) and asserts string-equality with the env var; mismatch → fail-closed boot, audit-emit `AUDIT_ANCHOR_PUBLISH_FAILED` with reason `DEPLOYMENT_ID_MISMATCH`. The DB-stored value is the source of truth; the env var serves as the operator's intent declaration. Operator-driven recovery from a legitimate change requires an explicit `UPDATE system_settings` by a DBA following the runbook procedure. This is captured by DB-level audit (`pgaudit`, connection `application_name` logs), NOT by an application-layer audit emission — the publisher does NOT emit `AUDIT_ANCHOR_KEY_ROTATED` for DEPLOYMENT_ID changes (closes TF2: that action is reserved for signing-key rotation with unrelated metadata shape).
     - `AUDIT_ANCHOR_PUBLIC_KEY_ARCHIVE_URL` (closes R3-N7) — **CLI read URL** prefix used to fetch the public key by `kid` (e.g., `https://audit-anchors.example.com/public-keys`). **Source: env var, not hardcoded code constant** — self-hosted deployments need to point at their own archive (S3 bucket public mirror / CDN / repo URL). The CLI uses `<archive-base-url> + '/' + kid + '.pub'` for URL construction; `kid` is constrained by regex (Step 10 N7), so even an attacker-controlled JWS cannot inject path traversal. The archive base URL itself is operator-trusted (env var, not user input).
     - **Publisher write path is separate (closes R4-N3)**: the `scripts/rotate-audit-anchor-key.sh` rotation script uploads new public keys to the destination configured by `AUDIT_ANCHOR_DESTINATION_S3_BUCKET` + a fixed prefix `<bucket>/audit-anchors/public-keys/`. The CLI's `AUDIT_ANCHOR_PUBLIC_KEY_ARCHIVE_URL` (read URL, often a CDN / public mirror) and the rotation script's write target (write URL, the S3 bucket) are intentionally separate env vars because read and write traffic typically traverse different network paths. Operator runbook MUST document that the read URL must serve byte-identical content to what the write target stores (i.e., CDN cache invalidation after rotation).
     - `AUDIT_ANCHOR_SIGNING_KEY` (32-byte hex Ed25519 seed; required when `AUDIT_ANCHOR_PUBLISHER_ENABLED=true`).
     - `AUDIT_ANCHOR_TAG_SECRET` (32-byte hex HMAC-SHA256 key; required when publisher enabled).
     - `AUDIT_ANCHOR_PUBLISHER_ENABLED` (boolean, default `false`).
     - `AUDIT_ANCHOR_DESTINATION_S3_BUCKET`, `AUDIT_ANCHOR_DESTINATION_S3_PREFIX`, `AUDIT_ANCHOR_DESTINATION_GH_REPO`, `AUDIT_ANCHOR_DESTINATION_FS_PATH` (per-destination URL/path config; missing = destination disabled).
   - All consumed via the `pick`-list pattern at the publisher entrypoint script. **NO hardcoded constants inside the worker module**.
9. **Destination layer**: add S3 Object Lock bucket (Terraform / cloud-config) + GitHub Release publication helper. Both wrapped behind a `Destination` interface so the filesystem fallback (for self-hosted operators) is the same code path.
10. **CLI**: ship `passwd-sso audit-verify` CLI subcommand under `cli/`. Reuse the manifest verifier library from step 6. Additional obligations:
    - **`kid` format validation (closes N7 + R3-N7)**: before fetching a public key from the archive, validate `kid` matches the constant regex `^audit-anchor-[a-zA-Z0-9_-]{8,32}$`. Reject any other value with `InvalidKidError`. Construct the public-key archive URL as `<archive-base-url> + '/' + kid + '.pub'` where `<archive-base-url>` is sourced from `AUDIT_ANCHOR_PUBLIC_KEY_ARCHIVE_URL` env var (operator-trusted; see Step 8). The CLI MUST refuse to run if this env var is unset (no fallback to ad-hoc URL guessing). The kid regex excludes `.` and `/`, so even an attacker-crafted JWS cannot inject path traversal — any path manipulation requires altering the env var, which is operator-controlled.
    - **Tag-secret input safety (closes N9)**: the CLI MUST accept the tag secret via three input modes, in this preference order:
      1. `--tag-secret-file <path>` — read from a file with mode 0600 (the CLI verifies file mode and refuses world/group-readable files).
      2. stdin pipe — when stdin is not a TTY, read up to 64 hex chars (= 32-byte secret) from stdin.
      3. `--tag-secret <hex>` — present but emits a `WARN` to stderr noting that the secret is now in shell history; intended only for interactive scratch sessions.
      The dashboard kit (Step 5) ships the secret as a 0600-mode file so customers default to the safe path.
11. **Customer-facing docs**: `docs/security/audit-anchor-verification.md` (verification procedure, public key URL, CLI usage, openssl recipe).
12. **Operator runbook**: `docs/operations/audit-anchor-rotation-runbook.md` (key rotation overlap procedure, destination failure response, regression response, on-call paging contract).
13. **Manual test plan** (R35 Tier-2: cryptographic-material-handling addition) under `docs/archive/review/audit-anchor-publisher-impl-manual-test.md`.
14. **CI bootstrap update (closes T10) + bypass-RLS allowlist (closes T15)**:
    - `passwd_anchor_publisher` role must be created in:
      - `infra/postgres/initdb/02-create-app-role.sql` (local Docker init).
      - `.github/workflows/ci-integration.yml` "Bootstrap application DB roles" step (mirror the `passwd_outbox_worker` block at L105-106).
      - `scripts/pre-pr.sh` already triggers integration tests on `src/workers/**`; verify the new role is created BEFORE integration tests run.
    - **`scripts/checks/check-bypass-rls.mjs` ALLOWED_USAGE update (closes T15 + F13 + R4-B2)**: the publisher worker uses `withBypassRls(...BYPASS_PURPOSE.AUDIT_ANCHOR_PUBLISH)` (Step 2a + Step 8). The CI scanner blocks any `withBypassRls` call from a file not in `ALLOWED_USAGE`. Add: `["src/workers/audit-anchor-publisher.ts", ["auditChainAnchor", "tenant", "systemSetting"]]` — covering the three models the publisher accesses within its own `withBypassRls` scope (`audit_chain_anchors` for anchor reads, `tenants` for the `audit_chain_enabled` filter, `system_settings` for DEPLOYMENT_ID enforcement per Step 8). **Note: `"systemSetting"` is SINGULAR** — matches the Prisma client accessor `prisma.systemSetting` derived from `model SystemSetting` (project convention is PascalCase singular; see Step 1). Using the plural `"systemSettings"` would not match the actual accessor and the scanner would block the implementation PR. **Do NOT add `auditOutbox`**: the publisher emits its audit events via `logAuditAsync` → `enqueueAudit`, which opens its own `prisma.$transaction` and configures `set_config('app.bypass_rls', 'on')` independently (per `src/lib/audit/audit-outbox.ts:53-58`). The audit_outbox INSERT therefore never appears within the publisher's `withBypassRls` callback scope and the scanner's 10-line lookahead never sees it — including `auditOutbox` in the publisher's allowlist would be vacuous and misleading. Without this entry, CI fails on the implementation PR.

## Testing strategy

For this ADR PR:
- ADR is documentation-only; no automated tests apply directly.
- The plan MUST be reviewed by 3 experts (Functionality / Security / Testing) per the triangulate workflow.

For the future implementation PR (sketched here for completeness; the implementation PR's own test plan will detail line-level assertions):

### FR → Test mapping (closes T1)

| FR | Test type | Proposed file | Assertion summary |
|---|---|---|---|
| FR1 | E2E | `cli/src/__tests__/integration/audit-verify.test.ts` | Customer with public key + manifest only verifies a known-good signature; PASS without server cooperation. |
| FR2 | Integration (real DB) | `src/__tests__/db-integration/audit-anchor-publisher.integration.test.ts` | Manifest covers EVERY tenant with `audit_chain_enabled=true` at snapshot time; tenants with `=false` are absent (not silently). |
| FR3 | Unit | `src/lib/audit/anchor-manifest.unit.test.ts` | `buildManifest` output's `tenants[].chainSeq`/`prevHash` matches `audit_chain_anchors` row; `anchoredAt` is the call-time, NOT `updated_at`. |
| FR4 | Unit | `src/lib/audit/anchor-manifest.unit.test.ts` | JWS signature is detached (canonical bytes diffable across publications without re-signing). |
| FR5 | CI doc-check | `scripts/checks/check-security-doc-exists.sh` | `docs/security/audit-anchor-verification.md` and the public-key archive directory both exist; required sections present. |
| FR6 | Failure-injection | `src/__tests__/db-integration/audit-anchor-fail-closed.integration.test.ts` | Signing key absent → `AUDIT_ANCHOR_PUBLISH_FAILED` audit row + `publish_paused_until` set + outbox-worker stops chain advance for paused tenant. |
| FR7 | Integration | `src/__tests__/db-integration/audit-anchor-key-rotation.integration.test.ts` | Two manifests in overlap window (signed by `kid-old` and `kid-new`) BOTH verify; old public key remains accessible after private destruction; rotation advisory itself verifies. |
| FR8 | Adversarial / Integration | `src/__tests__/db-integration/audit-anchor-regression-detection.integration.test.ts` | 3-manifest scenario (T5): `(epoch=1, seq=10) → (1,12) → (1,8)` rejected `CHAIN_SEQ_REGRESSION`; `(1,10) → (2,5)` accepted as legitimate epoch reset (FR8 tuple comparison). |

### Unit
- Signer/verifier round-trip; canonicalization stability across object-key permutations; manifest size projection (NFR2 — assert `JSON.stringify(buildManifest({ tenants: <10000 fixture>, ... })).length < 2_000_000`); epoch handling.
- **JCS edge cases (T3)**: `audit-chain.unit.test.ts` extended with: RFC 8785 §3.2.2.3 IEEE 754 numbers (`1e308`, `-0`, `Infinity` throws, `1.5` vs `1.50` serialization, `Number.MAX_SAFE_INTEGER + 1` round-trip); §3.1 Unicode key sort with non-ASCII keys (proves the BMP-only constraint we mandate). Optional: add `canonicalize` npm devDependency, assert byte-identical for all test vectors.
- **Verifier `alg`/`typ` rejection (S7 tests)**: explicit cases for `header.alg = 'none' | 'HS256' | 'RS256' | 'ES256' | undefined | null` — each MUST throw `InvalidAlgorithmError`. Same for `header.typ` mismatches → `InvalidTypError`. These are mock-reality alignment tests (RT1) — the test must NOT use a generic JOSE library that might silently allow some values.
- **`computeTenantTag` golden-value (closes T18)**: hardcoded test vector asserting `computeTenantTag(<known UUID lowercase>, <known 32-byte secret as Buffer>) === <hardcoded hex>` where the expected hex is derived offline via `openssl dgst -sha256 -mac HMAC -macopt hexkey:<secretHex>` of the literal byte string `audit-anchor-tag-v1\x00<tenantId>` (closes TF1 — produce this byte string with `printf 'audit-anchor-tag-v1\x00<tenantId>'` so the SINGLE backslash is interpreted as a literal NULL byte by `printf`, NOT as the 4-char string `\x00`; verify with `printf 'a\x00b' | xxd` → `61 00 62`). Negative test: same call with the UUID in UPPERCASE throws `InvalidTenantIdFormatError` (the function MUST NOT silently lowercase).
- **`tenantId` format validation**: explicit unit tests for `computeTenantTag` rejecting (a) UPPERCASE UUID, (b) UUID without hyphens, (c) shorter/longer string, (d) non-UUID input — each must throw `InvalidTenantIdFormatError`.
- **NFR3 sign-call spy**: `vi.spyOn(crypto, 'sign')`; run one publish cycle; assert `sign.mock.calls.length === 1`.

### Integration (real DB)
- Publisher worker reads `audit_chain_anchors`, builds manifest matching DB state, publishes to local destinations.
- **S3 destination (T7)**: add MinIO service to `docker-compose.override.yml` and `.github/workflows/ci-integration.yml` services. Test asserts Object Lock headers (`x-amz-object-lock-mode: COMPLIANCE`, `x-amz-object-lock-retain-until-date`) are sent and accepted. Until MinIO is wired into CI: contract test asserting EXACT HTTP request shape (method=`PUT`, path, content-type, all `x-amz-*` headers, body bytes) using a fetch-interceptor at `@/lib/http/external-http`.
- **GitHub Release destination (T8)**: lightweight Node `http.createServer` fake at test-time. Test asserts: (a) correct `POST /repos/{owner}/{repo}/releases` JSON body (tag = `audit-anchor-<date>`, `draft=false`, `prerelease=false`); (b) asset upload URL constructed correctly; (c) artifact bytes byte-identical between S3 stub write and GitHub Release upload (FR4 multi-destination integrity).
- **DB role grant integrity (NFR5 / T12 + RT3)**: integration test running as `passwd_anchor_publisher` asserts:
  - `SELECT * FROM audit_logs` raises `permission denied`; `SELECT (id, tenant_id, chain_seq, event_hash, chain_prev_hash) FROM audit_logs` ALSO raises `permission denied` (no SELECT on table).
  - `SELECT * FROM audit_chain_anchors` succeeds.
  - `UPDATE audit_chain_anchors SET chain_seq = ...` raises `permission denied` (column-level UPDATE only on `publish_paused_until` / `last_published_at`).
  - `INSERT INTO audit_outbox ...` succeeds.
  - **`SELECT id, audit_chain_enabled FROM tenants WHERE ...` succeeds (closes RT3)** — verifies the table-level grant from N1.
  - **`SELECT, INSERT, UPDATE` on `system_settings` (R3-N8 grant verification)** — round-trip: INSERT with ON CONFLICT DO NOTHING for `audit_anchor_deployment_id`, then SELECT and assert returned value.
- **KeyProvider integration (T4)**: file `src/__tests__/db-integration/anchor-publisher-key-load.integration.test.ts`, pattern: existing `pepper-dual-version.integration.test.ts`. Steps: `process.env.AUDIT_ANCHOR_SIGNING_KEY = <fresh ed25519 hex>` → `_resetKeyProvider()` → `getKeyProvider()` → `provider.getKey('audit-anchor-signing')` → use returned key for sign/verify roundtrip. Assertion: real env path is exercised (NOT a fake KeyProvider). Negative test: missing env var → `validateKeys` throws at boot.
- **`tenantTag` cross-deployment isolation (S6)**: generate `tagSecretA = randomBytes(32)`; `tagSecretB = randomBytes(32)`. Compute `tag = HMAC(tagSecretA, tenantId)` and try to verify against `tagSecretB` — assert mismatch (no false-positive cross-deployment hit).

### Adversarial
- **Tamper detection with golden-value path (T2)**: hardcoded test vector — known DB rows with known fields produce a known `prevHash` computed offline (via `openssl` CLI or a reference RFC 8785 library). Test asserts the manifest's `prevHash` for the test tenant equals the hardcoded value byte-for-byte. **This catches a systematically wrong canonicalization** that internal-only verifiers (closed loop) would miss.
- **`chain_seq` regression with prior manifest (T5)**: 3-manifest scenario in `audit-anchor-regression-detection.integration.test.ts`. Setup: publish A `(epoch=1, seq=10)` to a fixture S3 path; publish B `(epoch=1, seq=12, previousManifest.sha256=sha256(A))`; produce C `(epoch=1, seq=8, previousManifest.sha256=sha256(B))` (simulates server-side rewrite). Run `audit-verify --manifest C --prior-manifest A`. Assert exit `CHAIN_SEQ_REGRESSION`. Counter-test: D `(epoch=2, seq=5)` accepted as legitimate epoch reset (FR8 tuple comparison).
- **Replay an old manifest as current**: verifier with `previousManifest.sha256` linked-list correctly detects `previousManifest.uri` mismatch.
- **`DESTINATION_DIVERGENCE` (T9 — failure direction of byte-identity check)**: write manifest A to S3 stub; write manifest B (different bytes, same date) to GitHub stub; call multi-destination verifier; assert `DESTINATION_DIVERGENCE` reported with both SHA-256 hashes in the error.

### Failure-injection
- Signing key absent → `AUDIT_ANCHOR_PUBLISH_FAILED` audit row + no manifest + `publish_paused_until` set; primary destination 503 → secondary still publishes, audit notes degraded mode; both destinations down → `publish_paused_until` set, fail-closed; signing key present but `header.alg !== 'EdDSA'` (defensive — tests verifier hardening): `InvalidAlgorithmError` from verify path.

### Sustained-outage / no-deadlock (closes T6 — testable invariant replaces CPU/QPS)
With signing key unavailable for ≥3× cadence, the outbox-worker MUST continue draining non-chain-enabled tenants. For chain-enabled tenants, `audit_outbox` accumulates with `status=PENDING`. **Testable invariant**: instrument the outbox-worker with an optional `queryCounter` callback (constructor injection or module-level hook). Test asserts: when 100% of chain-enabled tenants have `publish_paused_until > now()`, `queryCounter.chainEnableQueries === 0` for N=3 consecutive poll ticks (no busy-loop). On signing-key recovery, the publisher's first successful publish clears `publish_paused_until` and the worker resumes draining; assert post-recovery `audit_logs.chain_seq` continues from `last_published_chain_seq + 1` with NO gap. Pattern: existing `audit-outbox-worker.test.ts` `vi.hoisted` mocks for `$transaction` / `$queryRawUnsafe`.

### Concurrent-publisher idempotency (closes F5 test)
Spawn two publisher instances simultaneously (subprocess test or in-process with `Promise.all`). **Mechanism A (PG advisory lock) is fixed** (per Step 3 / N5). Test asserts: (a) the LOSING instance returned because `pg_try_advisory_xact_lock` returned `false` (instrument the publisher to log this distinct exit reason — `LOCK_HELD_BY_OTHER_INSTANCE` — so the test can verify the actual lock path was taken); (b) exactly ONE manifest is produced for the cadence boundary; (c) only one `AUDIT_ANCHOR_PUBLISHED` audit row per cadence boundary; (d) only one S3 PUT; (e) only one GitHub Release. A test that only checks "one manifest produced" without asserting the lock-failure exit code could pass with Mechanism B semantics and not actually exercise Mechanism A — closes RT1.

### Schema migration intermediate state (R24 — closes T13)
File: `src/__tests__/db-integration/audit-anchor-epoch-migration.integration.test.ts`. Steps: (a) run Migration A → assert `epoch` column exists, default 1, nullable; (b) `INSERT INTO audit_chain_anchors (..., epoch)` with explicit NULL — succeeds (intermediate state); (c) run backfill `UPDATE ... SET epoch = 1 WHERE epoch IS NULL`; (d) assert no NULLs; (e) run Migration B (NOT NULL flip) → succeeds. Negative test: skip backfill, run Migration B → fails with constraint violation (proves the test exercises the constraint, not vacuous).

### CLI tests (closes T14 + RT5/RT7 N7/N8/N9 specs)
- `cli/src/__tests__/unit/audit-verify.test.ts`: option parsing (`--manifest`, `--public-key`, `--my-tenant-id`, `--tag-secret`, `--prior-manifest`); output format (PASS / `CHAIN_SEQ_REGRESSION` / `INVALID_SIGNATURE` / `DESTINATION_DIVERGENCE` / `InvalidKidError` / `InvalidTenantIdFormatError` / ...); secret-redaction (asserts the secret never appears in stdout/stderr or any log line).
- **`--my-tenant-id` UPPERCASE rejection (closes RT7)**: unit test passes `550E8400-E29B-41D4-A716-446655440000` (uppercase) → CLI exits non-zero with `InvalidTenantIdFormatError` printed to stderr (NOT silently lowercased).
- **`kid` validation (closes RT5 / N7)**: unit test crafts a JWS with `kid` containing path-traversal chars (`../../etc/passwd`, `audit-anchor-..%2f..`) → CLI rejects with `InvalidKidError` BEFORE any URL fetch. Assert the test does NOT make a network request (intercept `fetch` and fail if called).
- **Tag-secret input modes (closes RT5 / N9)**:
  - `--tag-secret-file` happy path (mode 0600 file) → success; world-readable file (mode 0644) → CLI refuses with `InsecureTagSecretFileError`. Test setup MUST call `fs.chmodSync(path, 0o644)` explicitly before invoking the CLI, NOT rely on default umask (closes TF4 — runner umask varies by environment).
  - stdin pipe (when stdin is not a TTY) → success; assert the secret is never read from CLI args.
  - `--tag-secret <hex>` → success but `WARN: --tag-secret on the command line is recorded in shell history; prefer --tag-secret-file or stdin` printed to stderr; assert exit code is 0 (warning is non-fatal).
- `cli/src/__tests__/integration/audit-verify.test.ts`: subprocess spawn pattern from `cli/src/__tests__/integration/version.test.ts` (uses `execFileSync` with `node <distEntry> <args>`). Generate a test manifest with a test signing key + tag secret, run `passwd-sso audit-verify` end-to-end, assert exit code 0 and PASS output.

### N8 DEPLOYMENT_ID enforcement (closes RT5)
File: `src/__tests__/db-integration/audit-anchor-deployment-id-enforcement.integration.test.ts`. Steps: (a) start publisher with `DEPLOYMENT_ID=<uuid-A>` against a fresh DB → asserts `system_settings` row inserted with `key='audit_anchor_deployment_id'`, `value=<uuid-A>`; (b) restart publisher with same `DEPLOYMENT_ID=<uuid-A>` → asserts boot succeeds, no audit row emitted (already-set is the happy path); (c) restart with mismatched `DEPLOYMENT_ID=<uuid-B>` → asserts publisher exits non-zero, `AUDIT_ANCHOR_PUBLISH_FAILED` audit row with `metadata.failureReason = 'DEPLOYMENT_ID_MISMATCH'`; (d) operator-driven recovery: `UPDATE system_settings SET value = <uuid-B> WHERE key = 'audit_anchor_deployment_id'` (executed by a DBA / operator runbook procedure, NOT by the publisher) then restart with `DEPLOYMENT_ID=<uuid-B>` → asserts boot succeeds, no application-layer audit row emitted (closes TF2). The operator's manual `UPDATE` is captured by DB-level audit (e.g., `pgaudit` or the connection's `application_name` log) — the publisher does not emit `AUDIT_ANCHOR_KEY_ROTATED` for this case, since that action is reserved for signing-key rotation by `scripts/rotate-audit-anchor-key.sh` and has unrelated metadata shape (`oldKid`/`newKid`).

### AUDIT_ANCHOR_PUBLISH_PAUSED + AUDIT_ANCHOR_KEY_ROTATED emit (closes RT6)
- File: `src/__tests__/db-integration/audit-anchor-publish-paused-emit.integration.test.ts`. Setup: tenant with `audit_chain_enabled=true`, signing key forced unavailable. Drive the publisher's `runCadence(date)` function directly 3 times with `Date` advanced by 24h each call (no wall-clock wait — closes TF3). Assert: 1 `AUDIT_ANCHOR_PUBLISH_FAILED` (first cycle, sets pause), then 2 `AUDIT_ANCHOR_PUBLISH_PAUSED` (cycles 2 + 3, while pause is still active) — exactly one per cycle, NOT one per poll within a cycle (the daily cron trigger guarantees this). Recover signing key, drive a 4th `runCadence(date+72h)` → assert one `AUDIT_ANCHOR_PUBLISHED` and `publish_paused_until` cleared.
- File: `src/__tests__/db-integration/audit-anchor-key-rotation-emit.integration.test.ts`. Run `scripts/rotate-audit-anchor-key.sh` against a fixture deployment. Assert: 2 `AUDIT_ANCHOR_KEY_ROTATED` rows — `metadata.phase='overlap-start'` (after new key generated, before overlap window opens) and `metadata.phase='overlap-end'` (after overlap window closes, just before private-key destruction). Both rows have matching `oldKid` and `newKid` metadata.

### WEBHOOK_DISPATCH_SUPPRESS sweep extension (closes RT4)
The existing `src/__tests__/audit-bypass-coverage.test.ts` enforces `AUDIT_OUTBOX_*` prefix membership in `WEBHOOK_DISPATCH_SUPPRESS`. The implementation PR MUST extend the sweep to also enforce that every `AUDIT_ANCHOR_*` prefix value in `AUDIT_ACTION_VALUES` is present in `WEBHOOK_DISPATCH_SUPPRESS` (mirroring the existing OUTBOX sweep). This adds a CI-time guard so future ANCHOR actions cannot be added without WEBHOOK_DISPATCH_SUPPRESS membership. The plan's prose note in Step 1 (line 229) by itself is insufficient — the test extension is the structural guard.

### NFR-specific tests (closes T12)
- NFR1 (latency): design-validated, no test required (cadence is a constant; latency floor is the cadence value itself).
- NFR2 (manifest ≤ 2MB): unit test `JSON.stringify(buildManifest({ tenants: <10000 fixture entries>, ... })).length < 2_000_000`.
- NFR3 (≤ 1 sign per cadence): see "Unit" — `vi.spyOn(crypto, 'sign')`.
- NFR5 (DB role isolation): see "DB role grant integrity" under Integration above.

### Chaos
- Clock skew across publisher invocations (1×, 2×, 5× cadence offset); concurrent publisher invocations (covered by F5 test).

### R32 boot test (closes T11 — clock-independent regex)
On fresh `docker compose up` of the publisher service, the declared ready-signal pattern: regex `audit-anchor-publisher: cadence=24h, next_publish=[0-9T:.Z\-]+, key=[a-zA-Z0-9_-]+`. Assert: log line matches the regex within 30s of container start; the `key=` value is non-empty (catches the empty-fallback case where the env var was missing but a default-empty was used). For multi-stage Dockerfiles, repeat for both the `target: deps` (dev) and `target: runtime` (prod) image targets.

## Considerations & constraints

- **PII boundary**: confirmed manifest contains no PII. Tenant identity is published as `tenantTag` (HMAC-derived, NOT raw UUID); `prevHash` is a hash; `chainSeq` is a counter. Customer-tenant *names*, user identifiers, audit metadata MUST NOT be added under any future change without revisiting this ADR.
- **Tenant tag distribution policy (S6)**: the `AUDIT_ANCHOR_TAG_SECRET` is shared with tenant administrators via authenticated download (dashboard kit + MFA challenge); never embedded in public docs, source code, or unauthenticated APIs. Rotating the tag secret invalidates all customer-side verification kits — schedule a 30-day overlap (manifests publish BOTH old-tag and new-tag entries during transition) and document in the rotation runbook in lockstep with signing-key rotation. **Threat-model boundary (closes N4)**: an attacker who steals an authenticated dashboard session of a tenant administrator AND survives any session-revalidation challenge can download the kit and recover any tenant's tag for which they know the tenant ID. This is OUTSIDE the threat model the `tenantTag` design defends against — the design defeats anonymous third-party enumeration; insider abuse via stolen admin sessions is governed by session-management controls (idle timeout, MFA step-up on sensitive downloads, dashboard audit logging), not by the tag mechanism itself. Document this scope explicitly in `docs/security/audit-anchor-verification.md`.
- **Multi-tenant isolation in publisher's DB role**: see Implementation steps 2 + 2a. Publisher holds SELECT on `audit_chain_anchors` (full row) + UPDATE on `(publish_paused_until, last_published_at)` only + SELECT on `tenants(id, audit_chain_enabled)` only + INSERT on `audit_outbox`. NO `SELECT on audit_logs` is granted; column-level REVOKE would be a no-op (S2). Cross-tenant reads use `withBypassRls(prisma, fn, BYPASS_PURPOSE.AUDIT_ANCHOR_PUBLISH)` — a NEW dedicated bypass purpose distinct from `SYSTEM_MAINTENANCE` for audit-trail clarity.
- **Trust zone analysis (S3)**: Axis 3B v1 wraps the signing key with `share-master` KEK (env var `SHARE_MASTER_KEY`). Operators with both DB write access (`MIGRATION_DATABASE_URL`) AND app-server env access (`docker exec app env`) hold both halves of the wrap and CAN forge manifests. The plan ships v1 anyway because (a) most insider attack scenarios have only DB write, not env, (b) v1 still defeats those attackers, (c) KMS migration to v2 establishes the actual hardware boundary. **Operational mitigation during v1**: document in the runbook that `SHARE_MASTER_KEY` rotation rights and DB write rights SHOULD be held by different operator roles where feasible; add a check to the deployment-validation script that warns if the same IAM principal holds both `KMSEncrypt` (or env access) AND `rds:*` write privileges. **KMS migration milestone (closes N2)**: v2 (Axis 3C — KMS-managed signing) is mandatory before either of these triggers, whichever comes first: (a) the deployment's first SOC 2 Type II audit window opens; (b) 6 months of v1 production operation elapse from the implementation PR's merge date; (c) any compliance / customer contract obligation requires hardware-key custody. Until the v2 migration ships, customer-facing `docs/security/audit-anchor-verification.md` MUST disclose: "v1 protection is software-only; an operator with both DB write AND application-server env access can forge manifests. v2 (KMS-managed) closes this boundary and is on the roadmap."
- **SYSTEM-actor unchained rows (S10)**: the audit-outbox-worker's `writeDirectAuditLog` path (used for dead-letter, reaper, retention-purge) bypasses the chain — those rows have `chain_seq IS NULL` and are NOT covered by any manifest. This is an accepted design trade-off (avoiding chain-write recursion under failure paths). `docs/security/audit-anchor-verification.md` MUST state explicitly: "the chain covers events with `chain_seq IS NOT NULL` only; SYSTEM-internal events (dead-letter, reaper, retention-purge) appear in `audit_logs` as unchained rows and must be audited separately."
- **Self-hosted deployments**: the recommended S3 + GitHub Release combo requires AWS + GitHub credentials at runtime. Self-hosters who lack either need an alternate destination story. Ship at minimum a "filesystem-only" mode (write to a configurable directory; operator mirrors to their own immutable store). Documented as supported but lower-assurance.
- **Genesis publication**: the first manifest cannot reference a `previousManifest`; treat this as `"previousManifest": null` and document that the verifier accepts null only at the documented genesis timestamp per deployment.
- **Chain reset / epoch increment**: not currently part of the schema. The `epoch` field is added in implementation step 1; this ADR's manifest schema accommodates it (FR8 tuple comparison) but does not specify reset *triggers* — that is a future operational decision.
- **Customer-side trust**: this design protects against rewrites detectable by a customer who *holds prior manifests*. A customer who never downloads any manifest gets no benefit. The CLI must auto-archive last N days of manifests on `audit-verify` invocation; the customer-email opt-in is the recommended way to guarantee customer-side custody for at-rest retention.
- **Time source**: `anchoredAt` is the publisher's NTP-synced clock. Skew detection via `previousManifest.anchoredAt` monotonicity is part of the verifier obligation. Document the maximum tolerated skew (e.g., 5 minutes) in the verifier rules.
- **R31 destructive-op interaction (refined per S5 — public-key archival distinct from private destruction)**: key rotation involves disabling/destroying the old PRIVATE signing key. This is category (e) "secret/key material destruction" — the rotation runbook MUST gate destruction behind explicit operator confirmation per the R31 contract; the corresponding harness hook (`block-secret-key-destruction.sh`) will fire on the rotation script's `vault kv delete` / `aws kms schedule-key-deletion` call. **Public-key archival**: the OLD PUBLIC key is permanently archived at a stable URL (e.g., `docs/security/audit-anchor-public-keys/<kid>.pub` in the repo, or `s3://<bucket>/audit-anchors/public-keys/<kid>.pub`). Archive entries are IMMUTABLE — once a `kid` is published, its public-key entry is never deleted, even after rotation. This satisfies FR7's "rotation does NOT invalidate historical artifacts": customers verifying a manifest signed under `kid=audit-anchor-<old-kid>` can fetch the corresponding public key from the archive indefinitely. The runbook step "destroy old private key" requires confirming the old public key is in the archive BEFORE the harness hook proceeds.
- **Pause-window protection boundary (S9)**: events with `chain_seq ≤ last_published_chain_seq` are protected by the published manifest. Events with `chain_seq > last_published_chain_seq` (including PENDING `audit_outbox` rows during a fail-closed pause) are NOT yet protected — an insider with DB write can modify them. The 3× cadence cap on `publish_paused_until` (Axis 8) bounds this exposure; sustained failure beyond 3× cadence pages on-call as incident severity. Customer-facing wording in `docs/security/audit-anchor-verification.md`: "your downloaded manifest authoritatively covers events up through `chain_seq = N`. Events after `N` are pending and not yet committed."
- **Anti-Deferral on `epoch` column**: adding `epoch` only at implementation time, not now, leaves the manifest schema with a mandatory field that the table can't supply. This is the "additive then strict" R24 split applied across PRs — the implementation PR MUST start with the schema change as step 1, before the publisher (Migration A → backfill → Migration B; Testing strategy T13 covers the intermediate-state test).

## User operation scenarios

These are the operator-facing scenarios that this ADR's recommended option must support. Each surfaces a constraint the implementation PR must honor.

1. **Daily happy-path publication**: at 00:05 UTC the publisher wakes, reads anchor rows for chain-enabled tenants, builds manifest, signs, uploads to S3 + GitHub. Operator sees `AUDIT_ANCHOR_PUBLISHED` audit row with manifest SHA-256 and destinations. Customer downloads the manifest, runs `passwd-sso audit-verify --manifest <file>` against their own DB export, gets PASS.
2. **Customer detects tamper**: a malicious operator rewrote three audit_log rows for tenant T two days ago. Customer fetches yesterday's manifest (which was signed before the tamper) and runs `audit-verify`. Verifier reports `CHAIN_MISMATCH at chainSeq=N for tenantId=T`, citing the manifest's `prevHash` differs from the recomputed chain.
3. **Signing key unavailable** (HSM offline / KMS quota exhausted / KeyProvider misconfigured on a fresh deployment): publisher fails closed at 00:05 UTC. Audit row `AUDIT_ANCHOR_PUBLISH_FAILED`. After 24h with no resolution, on-call paged. Chain advancement blocks for chain-enabled tenants — verify this does not block other audit emission paths (open question; needs implementation-PR investigation).
4. **Primary destination outage**: S3 returns 503 for 4 hours. Publisher retries with backoff, succeeds against GitHub Release in the meantime. At final retry, S3 succeeds. Manifest exists on both destinations with byte-identical content; audit row notes `degraded-mode publish` for the time window.
5. **Key rotation (S4 — explicit JWS file format, S5 — archival precondition)**: operator runs `scripts/rotate-audit-anchor-key.sh`, which: (a) generates new Ed25519 key (`kid-new`); (b) confirms the OLD public key is archived at `docs/security/audit-anchor-public-keys/<kid-old>.pub` (or the immutable S3 path) BEFORE proceeding (S5 archival precondition); (c) for an overlap period (default 7 days), each cadence publishes TWO independent JWS files at `s3://<bucket>/audit-anchors/<date>.kid-<kid-old>.jws` and `s3://<bucket>/audit-anchors/<date>.kid-<kid-new>.jws` — both files have IDENTICAL payload bytes (same `tenants[]`, same `anchoredAt`), differing only in `kid` and signature; (d) publishes a `key-rotation` advisory at `s3://<bucket>/audit-anchors/key-rotation-<date>.jws`, signed by the OLD key, with `typ: passwd-sso.audit-anchor.v1` and payload `{op: "rotation", oldKid, newKid, overlapStart, overlapEnd}`; (e) after overlap, the publisher signs only with the new key going forward; the OLD private key is destroyed (R31-gated `vault kv delete` / `aws kms schedule-key-deletion`); the OLD public key remains in the archive forever. CLI behavior: `passwd-sso audit-verify --manifest <file>` auto-detects `kid` from the JWS header, fetches the corresponding public key from the archive, verifies. Both files in the overlap window verify; CLI accepts whichever the customer downloaded.
6. **Cross-deployment verification (auditor scenario, S6-aware)**: an external auditor holds the public-key URL (from the immutable archive) and the manifest URL. They run the openssl JWS recipe in `docs/security/audit-anchor-verification.md` to confirm: (1) the signature is valid, (2) `header.typ === 'passwd-sso.audit-anchor.v1'`, (3) `header.alg === 'EdDSA'`. They are NOT given DB access or `AUDIT_ANCHOR_TAG_SECRET` — chain replay is the customer's job, signature integrity is the auditor's. **The auditor sees only `tenantTag` values, not raw `tenantId`** — preserving customer-tenancy confidentiality even from auditors.
7. **Customer self-verification (S6 `tenantTag` flow)**: a customer admin downloads the manifest, the public key (auto-fetched via `kid`), AND their `AUDIT_ANCHOR_TAG_SECRET` (from the dashboard kit). They run `passwd-sso audit-verify --manifest <file> --my-tenant-id <UUID> --tag-secret <hex>`. The CLI: (a) verifies signature + `alg` + `typ`; (b) computes the customer's own `tenantTag` from the supplied secret + tenantId; (c) locates the matching entry in `manifest.tenants[]`; (d) reads `chainSeq` and `prevHash` from that entry; (e) replays the customer's own `audit_logs` chain (via DB export or REST API export) and asserts `event_hash` at `chain_seq` matches the manifest's `prevHash`. Output: `PASS — events 1..N covered, chain integrity confirmed`. The CLI never logs the secret.
8. **Self-hosted deployment without AWS**: operator configures `AUDIT_ANCHOR_DESTINATION_FS_PATH=/var/audit-anchors`. Publisher writes signed manifests to that path. Operator's responsibility to mirror to their own immutable store (rsync to off-site, `cp` to write-once mount, etc.). Documented as supported but lower-assurance than the recommended S3 + GitHub combo.

## Alternatives considered (overall)

### Alt A: Do nothing (rely on internal chain + verify endpoint only)

- **Cost**: 0
- **Why rejected**: the internal verify path is fully reproducible by anyone with DB write access. The original review item (`#3`) flagged this exact gap.

### Alt B: Publish unsigned anchors only (transparency, no signature)

- **Cost**: ~1 week (S3 publisher only)
- **Why rejected**: an attacker with our infra access also controls the publisher; unsigned publication offers nothing the attacker cannot replicate.

### Alt C: Sign + publish, but only on-demand (customer pulls a fresh signed snapshot)

- **Cost**: similar to recommended, slightly less infra
- **Why rejected**: violates FR1's "without server cooperation" — customer cannot detect tamper that occurred between their pulls if the server is the only signing source AND the server doesn't proactively distribute. Pull-only also lets the server selectively withhold inconvenient snapshots.

### Alt D: Recommended option (X)

- See "Recommended overall configuration" above.

## Action items (post-ratification)

- [ ] Maintainer ratifies Decision (each axis ✅ or amend).
- [ ] Open a dedicated implementation plan PR following the steps in "Implementation steps".
- [ ] Establish the immutable public-key archive at the chosen location BEFORE shipping the publisher (S5): `docs/security/audit-anchor-public-keys/` directory in the repo OR a dedicated `s3://<bucket>/audit-anchor-public-keys/` (Object Lock compliance, indefinite retention). Document the archive URL in CLAUDE.md and the verification doc.
- [ ] (resolved in Round 2 N5) Concurrent-publisher serialization fixed at Mechanism A (PG advisory lock); Mechanism B rejected. Record in the rotation runbook.
- [ ] **Schedule KMS v2 migration tracking (closes R3-N2)**: open a tracking issue on implementation PR merge with body referencing the three N2 trigger conditions: (a) deployment's first SOC 2 Type II audit window opens, (b) 6 months post-merge, (c) any compliance / customer contract obligation requires hardware-key custody. Set the issue's due-date to 6 months from merge so the project backlog surfaces it; close only after KMS v2 ships or a documented re-decision is recorded.
- [ ] Decide the destination concrete URLs / GitHub repo / S3 bucket before the implementation PR: `AUDIT_ANCHOR_DESTINATION_S3_BUCKET`, `AUDIT_ANCHOR_DESTINATION_GH_REPO`, `AUDIT_ANCHOR_DESTINATION_FS_PATH`.
- [ ] Add `audit_chain_anchors.epoch` column (R24 additive split — separate migration for the strict NOT NULL flip; covered by Implementation step 1).
- [ ] Review `docs/operations/` and `docs/security/` index pages to add forward-references once the runbook + verification doc land.
- [ ] After implementation, schedule a follow-up audit (90 days post-launch) to verify customer-side artifact retention is actually happening (FR1's "without server cooperation" only works if customers retain copies).

## References

- [src/lib/audit/audit-chain.ts](../../../src/lib/audit/audit-chain.ts) — chain hash function and ChainInput shape (citation unverified for downstream specs — the file's RFC 8785 reference was confirmed in the file header).
- [src/workers/audit-outbox-worker.ts:204-308](../../../src/workers/audit-outbox-worker.ts#L204-L308) — sole writer of `audit_chain_anchors`.
- [src/app/api/maintenance/audit-chain-verify/route.ts](../../../src/app/api/maintenance/audit-chain-verify/route.ts) — internal verify endpoint, op_*-token gated.
- `prisma/migrations/20260413110000_add_audit_chain/migration.sql` — `audit_chain_anchors` schema, `audit_chain_enabled` default false.
- `docs/archive/review/durable-audit-outbox-phase4-review.md` — prior anchor design review (genesis prev_hash, INSERT grants, reprocessing semantics).
- `docs/archive/review/email-uniqueness-design.md` — ADR style template followed by this document.
- `docs/archive/review/pepper-rotation-runbook.md` — example of an operational runbook bundled with a security-sensitive feature; the audit-anchor key rotation runbook will follow the same shape.
- PR #413 — "Security hardening batch 1"; this ADR addresses the deferred `#3` item from that PR's "Out of scope" section.
- RFC 8785 — JSON Canonicalization Scheme (JCS), used by the chain. **Citation status**: revision/verbatim phrases not directly cited in this ADR; if implementation-PR review introduces a verbatim quote, run R29 verification.
- RFC 8032 — Edwards-curve Digital Signature Algorithm (EdDSA / Ed25519). **Citation status**: high-level reference only; no section claims made.
- RFC 7515 — JSON Web Signature (JWS). **Citation status**: high-level reference only; the `alg: EdDSA` requirement comes from RFC 8037, which the implementation PR must cite precisely.
- RFC 6962 — Certificate Transparency (mentioned for Alt 5E only; no claims requiring section-level verification).

---

## Implementation Checklist (Phase 2 — generated from Step 2-1 impact analysis on 2026-05-01)

### Files to modify

**Schema / migrations**:
- `prisma/schema.prisma` — extend `model AuditChainAnchor` with `epoch INT?`, `publishPausedUntil TIMESTAMPTZ?`, `lastPublishedAt TIMESTAMPTZ?`. Add new `model SystemSetting` (PascalCase singular per project convention). Add 4 enum values to `AuditAction`.
- `prisma/migrations/<ts>_audit_anchor_publisher_phase2/migration.sql` (new) — Migration A (additive: 3 columns + new table + 4 enum values + RLS on system_settings + grants).
- Migration B (epoch NOT NULL flip) — deferred, separate migration after backfill.

**Constants / env / RLS**:
- `src/lib/constants/audit/audit.ts:17-170` — add 4 `AUDIT_ANCHOR_*` actions.
- `src/lib/constants/audit/audit.ts:178-327` — add to `AUDIT_ACTION_VALUES`.
- `src/lib/constants/audit/audit.ts:326-352` — add `MAINTENANCE` to `AUDIT_ACTION_GROUP` if not present, register actions there.
- `src/lib/constants/audit/audit.ts:722-730` — keep new actions OUT of `OUTBOX_BYPASS_AUDIT_ACTIONS`.
- `src/lib/constants/audit/audit.ts:753-765` — add 4 new actions to `WEBHOOK_DISPATCH_SUPPRESS`.
- New constants: `AUDIT_ANCHOR_CADENCE_MS`, `AUDIT_ANCHOR_PUBLISH_OFFSET_MS`, `AUDIT_ANCHOR_RETENTION_YEARS`, `AUDIT_ANCHOR_MANIFEST_VERSION`, `AUDIT_ANCHOR_TYP`, `AUDIT_ANCHOR_PAUSE_CAP_FACTOR`, `AUDIT_ANCHOR_TAG_DOMAIN`, `AUDIT_ANCHOR_KID_PREFIX`.
- `src/lib/env-schema.ts:44-95` — add `DEPLOYMENT_ID`, `AUDIT_ANCHOR_SIGNING_KEY`, `AUDIT_ANCHOR_TAG_SECRET`, `AUDIT_ANCHOR_PUBLISHER_ENABLED`, `AUDIT_ANCHOR_PUBLIC_KEY_ARCHIVE_URL`, `AUDIT_ANCHOR_DESTINATION_*`.
- `src/lib/tenant-rls.ts:5-12` — extend `BYPASS_PURPOSE` with `AUDIT_ANCHOR_PUBLISH`.

**KeyProvider** (4 providers):
- `src/lib/key-provider/types.ts:8` — extend `KeyName`: `"audit-anchor-signing"`, `"audit-anchor-tag-secret"`.
- `src/lib/key-provider/env-provider.ts:22-33` — extend `getKeySync` switch.
- `src/lib/key-provider/env-provider.ts:35-59` — extend `validateKeys`.
- `src/lib/key-provider/aws-sm-provider.ts` — `validateKeys` extension.
- `src/lib/key-provider/gcp-sm-provider.ts` — same.
- `src/lib/key-provider/azure-kv-provider.ts` — same.

**i18n**:
- `messages/en/AuditLog.json` — 4 new entries.
- `messages/ja/AuditLog.json` — 4 new entries.

**New code**:
- `src/lib/audit/anchor-manifest.ts` — manifest library. **REUSE `jcsCanonical` from `src/lib/audit/audit-chain.ts:9-30` (R1)**.
- `src/lib/audit/anchor-destinations/destination.ts` — interface.
- `src/lib/audit/anchor-destinations/s3-destination.ts` — REUSE pattern from `src/lib/blob-store/s3-blob-store.ts:54-63`.
- `src/lib/audit/anchor-destinations/github-release-destination.ts`.
- `src/lib/audit/anchor-destinations/filesystem-destination.ts`.
- `src/workers/audit-anchor-publisher.ts` — REUSE pattern from `src/workers/dcr-cleanup-worker.ts`.
- `scripts/audit-anchor-publisher.ts` — entrypoint with `pick`-list.
- `cli/src/commands/audit-verify.ts` — register at `cli/src/index.ts:47+`.

**Existing modifications**:
- `src/workers/audit-outbox-worker.ts:204-309` — honor `publish_paused_until` per-tenant skip.

**CI / scripts**:
- `infra/postgres/initdb/02-create-app-role.sql:8-79` — add `passwd_anchor_publisher` role.
- `.github/workflows/ci-integration.yml:96-124` — bootstrap step for `passwd_anchor_publisher`.
- `scripts/checks/check-bypass-rls.mjs:22+` — `ALLOWED_USAGE` entry: `["src/workers/audit-anchor-publisher.ts", ["auditChainAnchor", "tenant", "systemSetting"]]`.
- `scripts/generate-audit-anchor-signing-key.sh` (new — pattern from `scripts/set-outbox-worker-password.sh`).
- `scripts/generate-audit-anchor-tag-secret.sh` (new).
- `scripts/set-audit-anchor-publisher-password.sh` (new).

**Tests**:
- `src/__tests__/audit-bypass-coverage.test.ts:35-40` — extend sweep to `AUDIT_ANCHOR_*`.
- `src/__tests__/audit-i18n-coverage.test.ts` — auto-picks up via `AUDIT_ACTION_VALUES`.
- New: `src/__tests__/audit-chain.unit.test.ts` extensions; `src/lib/audit/anchor-manifest.unit.test.ts`; `src/__tests__/db-integration/audit-anchor-*.integration.test.ts` (5+ files); `cli/src/__tests__/{unit,integration}/audit-verify.test.ts`.

**Docs** (placeholders OK in this phase):
- `docs/security/audit-anchor-verification.md`.
- `docs/operations/audit-anchor-rotation-runbook.md`.
- `docs/archive/review/audit-anchor-publisher-impl-manual-test.md` (R35 Tier-2).

### Reuse-mandatory utilities (R1, R17 obligations)

| Helper | Location | Why |
|---|---|---|
| `jcsCanonical` | `src/lib/audit/audit-chain.ts:9-30` | Manifest canonicalization byte-identical to chain |
| `buildChainInput` / `computeEventHash` | `src/lib/audit/audit-chain.ts:53-91` | Existing chain primitives |
| `withBypassRls` | `src/lib/tenant-rls.ts:40-52` | Cross-tenant anchor + system_settings access |
| `enqueueAuditInTx` / `logAuditAsync` | `src/lib/audit/audit-outbox.ts:20-59`, `src/lib/audit/audit.ts:77-97` | Publisher emit path |
| `encryptWithKey` / `decryptWithKey` envelope | `src/lib/crypto/account-token-crypto.ts:1-90` | Future signing-key wrap (KMS migration / advanced custody) |
| S3 PUT | `src/lib/blob-store/s3-blob-store.ts:54-63` | Destination uploader |
| `KeyProvider` interface | `src/lib/key-provider/types.ts:10-26` | Extend, do not duplicate |
| Worker / cron pattern | `src/workers/dcr-cleanup-worker.ts:16-200+` | Publisher worker shape |
| Subprocess test pattern | `cli/src/__tests__/integration/version.test.ts:1-26` | CLI integration test |

### Batch order

| # | Batch | Steps in plan | Notes |
|---|---|---|---|
| 1 | Schema foundation | 1 (schema A), 2/2a (DB role + RLS bypass purpose), 14 partial (initdb + ci-integration role bootstrap) | Establishes DB layer that all other batches depend on |
| 2 | Constants + env + KeyProvider | 4 (KeyProvider 4 providers), 8 (constants + env) | No runtime code yet, sets up symbols batches 3-7 use |
| 3 | Manifest library | 6 | Pure code, depends on Batch 2 constants |
| 4 | Destination layer + Publisher worker | 7, 9 | Depends on Batches 2-3 |
| 5 | CLI subcommand | 10 | Depends on Batches 2-3 |
| 6 | Outbox-worker patch | 3 | Depends on Batch 1 schema |
| 7 | Generation scripts + CI bootstrap finalization + ALLOWED_USAGE | 5, 14 (remainder) | Glue |
| 8 | Docs (placeholders OK) | 11, 12, 13 | Independent |
