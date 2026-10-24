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

**Anchor publishing**: `src/workers/audit-anchor-publisher.ts` publishes once per
daily cadence boundary, which `src/workers/audit-anchor-scheduler.ts` computes and
passes in (`runCadence(boundary)`); the boundary fixes the idempotency marker, the
artifact key and `anchoredAt`. Each run sets `lock_timeout` (10 s) and takes the
blocking `pg_advisory_xact_lock(hashtext('audit-anchor-publish'))`; a wait past the
timeout is the `lock_held` outcome, retried for the same boundary like a failure (any
role that can connect can hold the key, so the holder is not assumed to publish; alarmed
on AWS). Under the lock the run reads the marker
`system_settings.audit_anchor_last_published_boundary`, which is monotonic: a boundary
at or before it is `skipped_already_published` (before it also logs `stale_boundary`,
alarmed on AWS), and a marker that does not parse, or one past the wall clock's
current boundary, fails the run closed rather than reading as published or absent. A publish writes the marker — only forward — in the same commit as the
manifest pointer. A `DEPLOYMENT_ID` value is pinned in
`system_settings` at boot (`ensureDeploymentIdMatch`); a mismatch throws
`DeploymentIdMismatchError` and emits `AUDIT_ANCHOR_PUBLISH_FAILED` — this stops a
publisher configured for another deployment from writing this one's anchor state.
It does not serialize two instances of the same deployment; the lock and the marker
do.

**Pause**: an upload failure sets `publish_paused_until` on the manifest's tenants
until the **next cadence boundary** — at most one cadence (24 h), no longer the 72 h
(3× cadence) cap this document used to give. It is the same column
`deliverRowWithChain` reads to gate chain advancement, so a failed upload cannot let
the chain run ahead of what the next manifest commits to. It no longer holds
publishing: every chain-enabled tenant is published on each run, and a success
clears it, so in practice it lasts until the scheduler's next same-boundary retry
(every 15 min, at most three times per process, until 30 min before the next
boundary) succeeds.

**Attempt cap**: each run that passes the marker and tenant checks is counted per
boundary in `system_settings.audit_anchor_upload_attempts`, in its own transaction
committed before the publish transaction opens, so neither a rollback nor a crash
after the PUT resets it. Above 3 the run uploads nothing and logs
`audit-anchor-publisher.upload_cap_reached`, alarmed on AWS
(`<name_prefix>-audit-anchor-publisher-upload-cap-reached`), and the first such run
writes one `AUDIT_ANCHOR_PUBLISH_FAILED` row (`UPLOAD_ATTEMPT_CAP_REACHED`). A
stored count that does not parse is treated as past the cap for that boundary
(overwritten with the first count past it; `UPLOAD_ATTEMPT_COUNT_UNREADABLE`),
so damaging the row costs one boundary, as planting a count does. The cap
bounds how many versions of one day's key a crash loop or a retry storm can lock
into the COMPLIANCE bucket. Because the count is a database row, a database writer
can plant it to suppress a day's publish; the alarm makes that visible the same day
rather than at the ~25 h cadence-absent alarm.

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
blocking advisory lock plus the boundary marker (see "Chain construction" above) let
one run per boundary publish and make every other run skip; on ECS the service also
runs at most one task and a deploy stops the old one before starting the new.

**Publisher task role reuse** — the anchors bucket policy lets only the publisher's
task role write a manifest key, and the role's trust policy admits ECS tasks of this
account only (`aws:SourceAccount`). Within the account, a principal allowed
`iam:PassRole` on it can still run a task of its own choosing as that role, and a principal
with IAM write access to the role can make it trusted by anything. The controls for that
whole class are operator-owned, outside this stack (an SCP or permission boundary): who holds
`iam:PassRole` on the publisher role — every task-launch route below needs it — and who holds
`iam:UpdateAssumeRolePolicy`, `iam:PutRolePolicy`, `iam:AttachRolePolicy`, `iam:DeleteRolePolicy`, `iam:DetachRolePolicy`, `iam:PutRolePermissionsBoundary`, `iam:DeleteRolePermissionsBoundary`, `iam:DeleteRole`, and `iam:CreateRole` scoped to its name (and, for any customer-managed policy attached to it, `iam:CreatePolicyVersion` / `iam:SetDefaultPolicyVersion` on that policy; Terraform gives it an inline policy only) — the role-change routes need no `iam:PassRole` at all. The alarms below are
detective and cover a bounded part of the launch routes. Through direct ECS calls in this stack's region, a task runs
with the role iff (a) an override names it, or its task definition does — (b1) one of
another family, or (b2) one of the publisher's own family, legitimate only for a task the
publisher service launched. SURFACED, not prevented, route by route: (a) a `RunTask` /
`StartTask` naming the role as a `taskRoleArn` override
(EventBridge `<name_prefix>-audit-anchor-publisher-role-override`); (b1) a
`RegisterTaskDefinition` of any other family naming it
(`<name_prefix>-audit-anchor-publisher-role-task-definition`) — both match the role's
full ARN and its bare name; (b2) a task of the publisher's family that is not the
publisher service's — outside its cluster or with another `group` — from the native ECS
task state change (`<name_prefix>-audit-anchor-publisher-family-task-outside-service`, no
trail needed), and any `RunTask` / `StartTask` of that family whatever `group` it claims
(`<name_prefix>-audit-anchor-publisher-family-run-task`). RESIDUAL: the deploy path
itself — an `UpdateService` / `CreateService` pointing the publisher service at a revision
of its family registered outside a deploy runs it as the publisher's own task, which no
rule tells from a deploy — the same calls in any other region (the role is global; EventBridge
rules and the ECS and CloudTrail events they match are regional), another AWS service that
launches ECS tasks under a role it is passed (AWS Batch's `jobRoleArn` on Fargate, for one),
and changes to the role itself (`UpdateAssumeRolePolicy`,
`PutRolePolicy`, `AttachRolePolicy`, `DeleteRole` + `CreateRole`), which reach CloudTrail
but are not alarmed by this stack — IAM events reach EventBridge only in `us-east-1`,
where it has no provider; that alarm is the operator's (`docs/operations/alerts.md`
"Publisher task role passed to another task"). Without a trail, (b2) is surfaced only for
a task that does not claim the publisher service's `group`. The publisher's secrets reach only its container, but the
shared task execution role can read the whole app secret.

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
- **Database-written publisher state**: the publisher trusts `system_settings` for
  the manifest pointer, the boundary marker and the attempt count. A database writer
  can make runs skip (marker), stop uploading (attempt count) or chain to a pointer
  of its choosing. A marker past the wall clock's current boundary fails every run
  closed (`CADENCE_FAILED:BOUNDARY_MARKER_AHEAD`, alarmed as `cadence_failed`), so a
  future marker cannot suppress the boundaries before its date quietly; one past the
  run's boundary but not the clock's is alarmed as `stale_boundary`. What remains is a
  marker set to the current boundary before its publish: that boundary skips, and no
  alarm treats a skip as healthy, so the cadence-absent alarm sees it within a day.
  The cap is alarmed too; making the published objects the source of
  truth is the protocol-hardening follow-up (SC5 of
  `docs/archive/review/aws-anchor-publisher-verify-worker-plan.md`), as is a
  compromised publisher writing a new version of the same day's key (see
  [`audit-anchor-verification.md` § Object versions](audit-anchor-verification.md#object-versions)).
