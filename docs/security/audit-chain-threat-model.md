# Audit Chain Threat Model

This document consolidates the audit-log hash-chain threat model: how the chain is
constructed and serialized, the attack tree against it, and — most importantly — the
real (verified, not estimated) interaction between retention purge and chain-verify.
It cross-links rather than duplicates
[`audit-anchor-verification.md`](audit-anchor-verification.md) (customer-facing
verification procedure) and the STRIDE-based [`threat-model.md`](threat-model.md).

---

## Chain construction

**Canonicalization**: `src/lib/audit/audit-chain.ts` implements a minimal JCS
(RFC 8785) canonicalizer (`jcsCanonical`) — recursively sorts object keys, serializes
primitives via `JSON.stringify`, and throws on unsupported types (`BigInt`, `undefined`,
symbols, functions). `buildChainInput` assembles a `ChainInput` (`id`, ISO-8601
`createdAt`, `chainSeq` serialized as a **string** to avoid IEEE-754 precision loss,
hex-encoded `prevHash`, sanitized `payload`), and `computeCanonicalBytes` turns it into
UTF-8 bytes.

**Hash link**: `computeEventHash(prevHash, canonicalBytes)` = `SHA-256(prevHash ||
canonicalBytes)`. `prevHash` is 1 byte (`0x00`) for the genesis link and 32 bytes
(the previous row's `event_hash`) otherwise.

**Per-tenant anchor row**: `audit_chain_anchors` holds one row per tenant
(`tenant_id`, `chain_seq`, `prev_hash`, `publish_paused_until`, `last_published_at`).
`deliverRowWithChain` (`src/workers/audit-outbox-worker.ts:198`) is the only writer:

1. Idempotent upsert of the tenant's anchor row on first delivery
   (`chain_seq = 0, prev_hash = '\x00'` — the genesis seed).
2. `SELECT ... FOR UPDATE` on the anchor row — serializes concurrent deliveries for
   the same tenant so `chain_seq` increments are never raced.
3. If `publish_paused_until` is in the future, chain advancement is skipped
   (fail-closed: the outbox row is reset to `PENDING` and retried later, rather than
   chaining into a state the publisher hasn't yet committed to a manifest).
4. Compute `newSeq = chain_seq + 1`, the event hash, and `INSERT ... ON CONFLICT
   (outbox_id) DO NOTHING RETURNING id` into `audit_logs` (dedup-safe replay).
5. Only if the insert actually happened (no conflict) does the anchor row advance
   to `chain_seq = newSeq, prev_hash = eventHash`.

**Anchor publishing**: `src/workers/audit-anchor-publisher.ts` runs on a cadence,
acquiring `pg_try_advisory_xact_lock(hashtext('audit-anchor-publish'))` before each
cycle so overlapping cron/process instances never both attempt a publish
(`lock_held` outcome for the loser). A `DEPLOYMENT_ID` value is pinned in
`system_settings` at boot (`ensureDeploymentIdMatch`); a mismatch throws
`DeploymentIdMismatchError` and emits `AUDIT_ANCHOR_PUBLISH_FAILED` — this prevents
two differently-configured publisher deployments from racing over the same anchor
state. On a publish failure the publisher sets `publish_paused_until` on the
non-paused, not-yet-updated anchor rows (capped at `pauseCapFactor × cadenceMs`,
documented as up to 72h in the customer-facing doc) — this is the same
`publish_paused_until` column `deliverRowWithChain` reads to gate chain advancement,
so a failed publish cannot silently let the chain run ahead of what will eventually
be committed to a manifest.

**Genesis**: `Buffer.from([0x00])` — a single zero byte, distinct from a 32-byte
`event_hash`, so genesis is unambiguous in the hash computation.

---

## Attack tree

**Row tamper (in-place UPDATE of a stored `audit_logs` row)** — DETECTED. Any
byte-level change to `metadata`, `created_at`, `id`, or `chain_seq` changes the
JCS-canonical bytes for that row, so the stored `event_hash` no longer matches
`computeEventHash(chain_prev_hash, canonicalBytes)`. `audit-chain-verify`
(`src/app/api/maintenance/audit-chain-verify/route.ts`) walks the range and reports
`TAMPER_DETECTED` (`firstTamperedSeq`) at the first mismatch, then bails (does not
continue walking with a known-bad hash). Prevention, not just detection: `passwd_app`
has no direct `UPDATE`/`DELETE` grant on `audit_logs` (revoked in
`prisma/migrations/20260522000200_audit_log_revoke_via_definer/migration.sql`) — the
only sanctioned mutation paths are the two `SECURITY DEFINER` routines
(`audit_log_tenant_migrate`, `audit_log_purge`).

**Low-end truncation via retention purge** — DETECTED ONLY BY THE INTERNAL VERIFY
ENDPOINT, in a form that is a false-positive, not a clean signal; see
"Retention-purge interaction" below. The externally-published anchor manifest does
**not** detect this at all: it commits only to the *head* of the chain
(`tenantTag`, `chainSeq` — see `src/lib/audit/anchor-manifest.ts:18-21`), never to the
full row range, so deleting the earliest rows leaves the manifest's committed head
unchanged and undetectable by manifest comparison alone.

**Gap injection** (deleting a row from the *middle* of a chain-seq range, or any
non-monotonic `chain_seq` sequence in the retained rows) — DETECTED. The verify walk
tracks `prevSeq` and flags the first place `seq !== prevSeq + 1` as
`firstGapAfterSeq`, surfaced as `reason: "GAP_DETECTED"`.

**Anchor race** (two processes both trying to extend the same tenant's chain, or two
publisher instances both trying to publish) — PREVENTED structurally, not just
detected. Row-level: `deliverRowWithChain`'s `SELECT ... FOR UPDATE` on the anchor row
serializes concurrent delivery attempts for the same tenant. Publisher-level: the
`pg_try_advisory_xact_lock` + `DEPLOYMENT_ID` single-owner check (see "Chain
construction" above) means only one publisher instance can hold the publish slot at a
time.

**Tag-secret boundary** — the tag secret (used to derive `tenantTag` so the public
manifest does not expose raw tenant UUIDs) has its own threat-model section; see
[`audit-anchor-verification.md` § Threat-model boundary for the tag secret](audit-anchor-verification.md#threat-model-boundary-for-the-tag-secret)
rather than duplicating it here. Likewise, the "who can forge a manifest" question
(operator-held signing key in v1) is covered by
[`audit-anchor-verification.md` § v1 trust-zone caveat](audit-anchor-verification.md#v1-trust-zone-caveat).

---

## Retention-purge interaction

**This section documents the ADJUDICATED, test-verified behavior — not the plan-time
estimate.** Two independent review lenses initially predicted different (both wrong)
outcomes for what happens when `audit-chain-verify` is run after a retention purge;
neither prediction matches what the database actually does. The real behavior is
pinned by the T5 characterization test
(`src/__tests__/db-integration/audit-chain-verify-endpoint.integration.test.ts`, test
name `"A1: after purging the earliest chained rows, default fromSeq=1 verify reports
a false tamper at the first retained row (characterization)"`).

**What `audit_log_purge` does**: the `SECURITY DEFINER` function
(`prisma/migrations/20260522000200_audit_log_revoke_via_definer/migration.sql`) is a
plain `DELETE FROM audit_logs WHERE tenant_id = $1 AND created_at < $2`. It does not
touch `audit_chain_anchors`, does not renumber `chain_seq` on the surviving rows, and
records no "purged up to sequence N" watermark anywhere.

**Verified real behavior** (5 chained rows delivered via the real
`deliverRowWithChain`; rows 1-3 purged; rows 4-5 retained):

- Before purge: full walk from genesis is clean — `ok:true, totalVerified:5`.
- After purge: the default (`from` query param omitted) `audit-chain-verify` request
  uses `fromSeq = 1`, which is `<= 1`, so the seed-lookup branch is skipped and the
  walk seeds `prevHash` from **genesis** (`0x00`) — see the `seedPrevHash` default
  assignment in `src/app/api/maintenance/audit-chain-verify/route.ts` (symbol
  reference, not a line number, so the pointer survives edits to that file).
  The query then selects `chain_seq >= 1 AND chain_seq <= toSeq`, which returns rows
  4 and 5 (the only surviving rows — `chain_seq` was never renumbered). Row 4's
  stored `event_hash` was originally chained from row 3's hash, not from genesis, so
  re-deriving it from `0x00` produces a hash mismatch at the **first retained row**.
- **Result: `ok:false`, `firstTamperedSeq:4` — a FALSE TAMPER report.** This is
  cryptographically indistinguishable from a real in-place tamper of row 4; nothing
  in the response tells the operator "this is expected because of a purge."

This differs from both pre-implementation predictions: the functionality lens
expected a benign `ok:true, totalVerified:0`; the security lens expected the
explicit-error path `AUDIT_CHAIN_SEED_NOT_FOUND`. **Neither occurs on the default
(`fromSeq=1`) path.** `AUDIT_CHAIN_SEED_NOT_FOUND` DOES occur, but only when an
explicit `from` query param resolves to a `fromSeq` that straddles the purge boundary
in a way that lands the seed-lookup (`fromSeq - 1`) exactly on an already-purged row
— i.e. only for a caller-supplied range, never the default full-history call most
operators will actually run.

**Scope of the chain-verify guarantee**: chain-verify's integrity guarantee is scoped
to *currently-retained* rows walked from a *correct* seed. It was never designed to
prove "nothing was ever deleted" — but the current implementation also does not
distinguish "purge happened, seed is wrong" from "someone tampered with row 4",
which is the operational problem this section exists to flag.

**Purge's own audit record**: the purge route (`purge-audit-logs/route.ts`) and the
retention-gc worker's `sweepAuditLogs` both call `logAuditAsync` — the standard
codebase-wide best-effort pattern (see CLAUDE.md's Audit outbox section): a
structured JSON log line is emitted synchronously (compensating control, never
throws), and the outbox enqueue happens in its own transaction after the caller's
business transaction has already committed. A crash in the narrow window between
commit and enqueue loses the outbox row (and therefore the `AUDIT_LOG_PURGE`
`audit_logs` entry itself), though the synchronous structured log still captured the
purge having happened. This is the same accepted pattern used by every other
maintenance route, not a purge-specific weakness; tracked as a cross-cutting
follow-up:
`TODO(route-policy-sql-security): purge audit-record atomicity (enqueueAuditInTx within the purge round-trip)`.

**Tracked fix** (schema work, deferred — not a 30-minute in-branch fix):
`TODO(route-policy-sql-security): purge watermark (purged_up_to_seq) so chain-verify re-seeds from the first retained row and reports RANGE_PRECEDES_RETENTION instead of a false tamper`.
The intended shape: `audit_log_purge` records the highest `chain_seq` it deleted (a
per-tenant watermark column, e.g. on `audit_chain_anchors`), and
`audit-chain-verify`'s default-path seed lookup consults that watermark — when the
walk's implied seed predates the watermark, the endpoint returns an explicit
`RANGE_PRECEDES_RETENTION` reason instead of silently re-seeding from genesis and
misreporting tamper.

---

## Residual risks

- **Anti-forensics via low-end purge**: an operator-token holder authorized for
  `/api/maintenance/purge-audit-logs` (or the automated retention-gc sweep, for
  tenants with `auditLogRetentionDays` configured) can permanently remove the
  earliest audit evidence for their own tenant. This is a legitimate, policy-driven
  operation by design (tenants are entitled to configure and exercise a retention
  policy) — the residual risk is *detectability*: today, purging early rows produces
  a **false tamper report** on the next default chain-verify run rather than a
  neutral "range starts after retention" signal, which actively obscures the
  distinction between "expected purge" and "someone tampered with the chain."
  Tracked by the watermark TODO above.
- **External manifest detects head-rollback only**: the published anchor manifest
  commits to each tenant's `chainSeq` (head position) at publish time, not to the
  full row range. A low-end truncation (purge of early rows) that does not move the
  head is invisible to manifest-based external verification — only an internal
  chain-verify run (subject to the false-tamper caveat above) or a full audit_logs
  export comparison would surface it. This is a structural property of a
  head-committing manifest design, not a bug; see
  [`audit-anchor-verification.md` § What is NOT covered](audit-anchor-verification.md#what-is-not-covered).
- **v1 trust-zone / signing-key co-location** and **tag-secret distribution
  boundary**: both already documented in `audit-anchor-verification.md` (linked
  above); not restated here to avoid drift between two copies of the same claim.
