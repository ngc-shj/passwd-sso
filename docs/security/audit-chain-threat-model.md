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
passes in (`runCadence(boundary)`); the boundary fixes the artifact key and
`anchoredAt`. What is already published is read from the **primary destination** — the
first configured: S3, else GitHub Releases, else the filesystem — never from a database
value (`src/lib/audit/anchor-published-state.ts`). Each run lists the primary, reads the
latest manifest and verifies it: under the publisher's own key when the key's `kid` is
its own, else under `public-keys/<kid>.pub` from the same destination; the signature
must verify under the key its `kid` names, and the key's date must be the UTC date of
`anchoredAt`. From that manifest and one database value — the greatest
`audit_chain_anchors.last_published_at` — the run decides, first match:

- the listing or a read fails, the latest manifest does not verify, it is not of this
  chain location (below), it is dated after the
  wall clock's boundary, `last_published_at` is past the wall clock's boundary or past the
  latest manifest, or the latest manifest is under another `kid` while a manifest key
  named with the own `kid` exists → the run **fails closed** before any write;
- the latest manifest is dated after the run's boundary → skip (`stale_boundary`);
- it is the boundary's own and was published under another `kid` or `DEPLOYMENT_ID` →
  skip (`published_by_other_identity`);
- it is the boundary's own, this publisher's, and the database records it → skip;
- it is the boundary's own, this publisher's, and the database does not record it →
  **adopt**: mirror its bytes and record it, without signing anything;
- otherwise → **publish**, with the latest manifest as `previousManifest`.

`last_published_at` can therefore make a run refuse or adopt again; it cannot make one
skip, and it does not choose `previousManifest`. A skip never counts as health.

**Chain location.** A manifest of format version 2 — the only one this release writes —
carries `chainLocation`, the hash of the primary destination's location
(`s3://<bucket>/<prefix>`, `github://<owner>/<repo>`, `file://<absolute base path>`), under
the signature. A version 2 manifest at the primary that carries another value was
published somewhere else and copied: as the latest manifest, or as the object a create
finds at its key, it fails the run closed (`PUBLISHED_OBJECT_FOREIGN_LOCATION`) and is
neither chained to nor adopted. A version 1 manifest, written by an earlier release, names
no location; it is accepted only while the database vouches for it — its date is the date
of the greatest `last_published_at` — and otherwise fails the run closed
(`LEGACY_MANIFEST_UNSETTLED`). So an upgrade in place chains to the last version 1
manifest, and a version 1 manifest is never adopted. Secondaries hold the primary's bytes
and so the primary's `chainLocation`; a secondary's own location is compared with nothing.

Every manifest write is create-only (`If-None-Match: *` on S3, `link()` on the
filesystem, the asset name on GitHub Releases). A write that finds the key taken reads
the stored object back: one the publisher's own key and `DEPLOYMENT_ID` produced is
adopted, anything else fails the run or ends as the other-identity skip. A day's key
therefore gets one version however many times a run is retried.

Each run sets `lock_timeout` (10 s) and takes the blocking
`pg_advisory_xact_lock(hashtext('audit-anchor-publish'))`; a wait past the timeout is the
`lock_held` outcome, retried for the same boundary like a failure (any role that can
connect can hold the key, so the holder is not assumed to publish; alarmed on AWS).
Under the lock the publish transaction reads the database and the primary again and
decides again. A `DEPLOYMENT_ID` value is pinned in `system_settings` at boot
(`ensureDeploymentIdMatch`); a mismatch throws `DeploymentIdMismatchError` and emits
`AUDIT_ANCHOR_PUBLISH_FAILED` — this stops a publisher configured for another deployment
from booting against this database. It does not serialize two instances of the same
deployment; the lock and the create-only write do. The `system_settings` rows
`audit_anchor_last_published_boundary` and `audit_anchor_previous_manifest`, which
earlier releases decided from, are read by nothing and removed by the migration
`20261115000000_remove_audit_anchor_legacy_settings`.

Secondary destinations mirror the primary's bytes: the boundary's own object within the
run (one that already holds other bytes fails the run), older gaps by a byte copy of at
most 7 manifests per publishing run.

**Pause**: an upload failure sets `publish_paused_until` on the manifest's tenants
until the **next cadence boundary** — at most one cadence (24 h), no longer the 72 h
(3× cadence) cap this document used to give. It is the same column
`deliverRowWithChain` reads to gate chain advancement, so a failed upload cannot let
the chain run ahead of what the next manifest commits to. It no longer holds
publishing: every chain-enabled tenant is published on each run, and a success
clears it, so in practice it lasts until the scheduler's next same-boundary retry
(every 15 min, at most three times per process, until 30 min before the next
boundary) succeeds.

**Attempt cap**: each run that passes the decision above with something to publish or
adopt is counted per boundary in `system_settings.audit_anchor_upload_attempts`, in its
own transaction committed before the publish transaction opens, so neither a rollback
nor a crash after the write resets it. Above 3 the run writes nothing and logs
`audit-anchor-publisher.upload_cap_reached`, alarmed on AWS
(`<name_prefix>-audit-anchor-publisher-upload-cap-reached`), and the first such run
writes one `AUDIT_ANCHOR_PUBLISH_FAILED` row (`UPLOAD_ATTEMPT_CAP_REACHED`). A
stored count that does not parse is treated as past the cap for that boundary
(overwritten with the first count past it; `UPLOAD_ATTEMPT_COUNT_UNREADABLE`),
so damaging the row costs one boundary, as planting a count does. The cap
bounds how often a crash loop or a retry storm reaches the destinations for one
boundary; that it cannot lock a second version of the day's key into the COMPLIANCE
bucket is the create-only write's doing, not the cap's. Because the count is a
database row, a database writer can plant it to suppress a day's publish; the alarm
makes that visible the same day rather than at the ~25 h cadence-absent alarm.

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
blocking advisory lock, under which each run reads the primary destination again, plus
the create-only write (see "Chain construction" above) let one run per boundary
publish and make every other run skip or adopt the same object; on ECS the service also
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
task state change (`<name_prefix>-anchor-publisher-family-outside-svc`, no
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
- **Database-write adversary against the publisher** and **what each destination
  bounds**: see the next section.

---

## Publisher adversaries

### A database writer

Someone who can write the publisher's tables — `system_settings`,
`audit_chain_anchors`, `tenants` — but holds neither the signing key nor write access to
a destination.

**Prevented.** No database grant writes a destination, and the decisions below read the
destination, not the database:

- *Suppressing a publication by claiming it happened.* No database value produces a
  skip. The marker row earlier releases wrote is gone, and written again it is read by
  nothing; a `last_published_at` at or past the boundary
  with no manifest at the primary fails the run closed instead.
- *Redirecting the chain.* `previousManifest` is the latest verified manifest at the
  primary. The pointer row earlier releases wrote is gone, and written again it is read
  by nothing.
- *Forcing a second version of a day's key.* Rewinding `last_published_at` makes the
  next run adopt the stored object again — same bytes, no write to the primary.

**Residual and alarmed.** Each stops or wedges publishing, visibly, and is reset by
correcting the value (`docs/operations/audit-anchor-rotation-runbook.md`), never by
restarting the chain:

| Database write | What happens | Alarm |
|---|---|---|
| attempt count planted or damaged | that boundary is not published | `upload_cap_reached` |
| the advisory lock held by a session | runs stand down | `lock_held` |
| `last_published_at` moved forward | every run fails closed (`LAST_PUBLISHED_AHEAD_OF_CLOCK` or `DESTINATION_BEHIND_DATABASE`) | `cadence_failed` |
| `last_published_at` moved, or cleared, while the latest manifest is version 1 | every run fails closed (`LEGACY_MANIFEST_UNSETTLED`) until the value is back on that manifest's date | `cadence_failed` |
| every tenant's `audit_chain_enabled` cleared | `skipped_no_tenants`, unhealthy: an anchor row, or a manifest at the primary, shows the chain was once on — deleting the anchor rows as well does not make the skip healthy | `chain-enabled-fell-to-zero`, then cadence-absent |
| every chain-enabled tenant's anchor row deleted | `skipped_no_tenants`, unhealthy while the primary holds a manifest: the enabled tenants have nothing to publish until the outbox worker writes each one's next chained event, which recreates the row from the genesis seed (the sequence restarts: `CHAIN_SEQ_REGRESSION` below) | cadence-absent, if it lasts a day |
| `audit_anchor_deployment_id` changed | the publisher refuses to boot | `publisher-down` |

**Detected by a row only.** No alarm; one `AUDIT_ANCHOR_PUBLISH_FAILED` row, written
with the publish that noticed it, and the same event on the publisher's structured audit
log line, which leaves the database's reach:

- one tenant's `audit_chain_enabled` cleared, or its anchor row deleted →
  `TENANT_DROPPED_FROM_MANIFEST` (a tag of the previous manifest is absent from this
  one);
- a tenant's `chain_seq` lowered within an epoch → `CHAIN_SEQ_REGRESSION`; a verifier
  comparing the two manifests gets exit 17;
- a tenant's `epoch` changed, which takes it out of the `chain_seq` comparison →
  `EPOCH_CHANGED` (no code path writes the column); the verifier prints a warning.

These rows are written by every run that ends `published`, for the manifest it
published — signed by it or adopted — and for every earlier manifest that was stored
and never settled; and by every run that **fails once the primary holds the boundary's
manifest** (a mirror failure, a commit lost after the upload, any error past the create),
for that manifest, right after its failure row. A run that fails before the primary holds
the manifest, or skips, writes none of them. A database
writer can force an adopt — fail the commit after the create (a held row lock), let the
retry find the stored object — and an adopt signs nothing, so it has no chained-to
manifest in hand. It reads the previous manifest its stored manifest names back from the
primary, holds it to the `sha256` that manifest carries, and compares against it; when
that object is missing, does not verify, has another hash or cannot be read inside the
run's bound, the publish writes `PREVIOUS_MANIFEST_UNAVAILABLE_FOR_COMPARISON` instead
of passing silently. A boundary adopted repeatedly writes the rows with each adopt,
bounded by the attempt cap.

The same writer can keep the commit failing through every attempt of a boundary, so
that its manifest — already without the tenant — is stored and no run of that boundary
ends `published`; the next boundary's manifest then chains to one that lacks the tenant
too. So a publish does not stop at the manifest it chains to: from there it walks back
through every manifest dated after the published high-water (the greatest
`last_published_at`, read under the lock before the publish writes it; every manifest
when no row has one), reads each one's previous manifest back as an adopt does, and
writes the rows for it, `comparedArtifactKey` naming the manifest a row is about. A
manifest dated on the high-water's date is one a publish settled, and with it compared.
The walk reads under the run's one destination bound, after the mirror backfill, and
compares at most 7 manifests (`AUDIT_ANCHOR_UNSETTLED_WALK_MAX`); when an unsettled
manifest lies past them it stops and writes one `UNSETTLED_WALK_TRUNCATED` row naming the
last manifest compared, so a walk cut short does not read as one that found nothing. A
read that fails or outlasts the bound ends it with the unavailable row. The high-water is
a database value. Moved back, or set to null, it costs a publish at most those 7
read-backs and the rows they yield — changes already reported are reported again — and
the truncation row when more than 7 manifests lie after it; that repeats on every publish
while the value is null or behind, not once. Moving it forward past what the primary
holds fails every run closed (above); moved onto the date of a manifest that is stored
and unsettled, it makes that manifest count as settled and the walk skips it.

That no longer hides the manifest's comparison, because the run that stored it has
already written it. The run that creates a manifest holds the manifest it chained to; a
run that adopts one reads the predecessor back. When such a run fails — the way a database
writer forces an unsettled manifest is a commit failed after the create — it writes the
comparison rows itself, after its failure row and inside the same bound, before it
returns. A failed commit followed by a write to `last_published_at` therefore leaves the
drop on record, and so does a process killed between a later publish's commit and its
walk. A retry of the boundary reports the same comparison again, at most the attempt cap
(3) times, plus once more by the adopt that settles it.

What remains uncompared is a manifest for which **both** hold: the run that stored it
was killed after the create and before it wrote its rows (a crash or a stop, which a
database writer cannot cause; an error is not enough, the failure path writes them), and
the published high-water then reached that manifest's date before any run compared it —
a database writer setting `last_published_at` onto it, or the run that settled it or the
next boundary being killed in turn between its commit and its rows. Without the second,
the next run adopts the manifest or the next publish walks back to it. The rows are
written to the database the adversary writes; the same events on the publisher's
structured log line are not.

**Out of reach.** The publisher signs what the anchor rows hold at the boundary. A
writer who rewrites `audit_logs` and the tenant's anchor row consistently before a
publish has the rewritten head anchored; the manifest protects history from the moment
it is published, not before. The rows above are themselves database content.

### What each destination bounds

"Terraform bucket" is the anchors bucket of `infra/terraform`. "Other stores" are GitHub
Releases, the filesystem, and an S3 bucket without that bucket policy.

| Adversary | Terraform bucket | Other stores |
|---|---|---|
| Database writer | Enforceable boundary: no database grant writes the bucket, and nothing that decides what is published reads the database. | The same. |
| Writer of the destination without the current signing key | The key archive (`public-keys/*`) is writable only by the break-glass role, so a foreign `kid` resolves only to a key an operator archived: the verification of the latest manifest is a fail-closed gate. Nobody can delete. | The same writer can archive a key of its own, so the foreign-`kid` check is a best-effort tripwire: it catches corruption and misfiling, and a forged predecessor is *detected* — the publish that chains to it writes `AUDIT_ANCHOR_KEY_ROTATED` naming the unknown `kid` — not prevented. The writer can also delete, so `DESTINATION_BEHIND_DATABASE` and `LATEST_UNDER_RETIRED_KEY` are tripwires too. Adoption never rests on a foreign key: only an object the publisher's own key signed is adopted. |
| Holder of the publisher task role's credentials, without the signing key | Can only wedge publishing: a manifest key holding bytes that do not verify as the latest (`PUBLISHED_OBJECT_UNVERIFIABLE`), a key *named* with a newly archived `kid` (`LATEST_UNDER_RETIRED_KEY`), or a manifest-named key that turns a never-enabled deployment's healthy skip unhealthy. All alarmed; all repeatable, so the reset is the role-credential incident, not a key change. Cannot add a version to a stored key: the bucket policy refuses a `PutObject` that creates an object without `If-None-Match` (`DenyUnconditionalPut`), whoever sends it. A manifest copied from another prefix is refused by its `chainLocation`. | — (the row above: these stores have one writer) |
| Holder of the current signing key | Not bounded by anything here (see the v1 trust-zone caveat). | Not bounded. |

### Stated limits

- **Create-only is platform-enforced on the Terraform bucket only.** There the bucket
  policy's `DenyUnconditionalPut` refuses every `PutObject` that creates an object
  without `If-None-Match`, for every principal, so a stored key cannot be given a second
  version; it holds while the policy does (a change to it is alarmed). On an S3 bucket
  without that statement the publisher alone keeps the rule, and a holder of its
  credentials can add a version; an operator running `list-object-versions` sees it
  ([`audit-anchor-verification.md` § Object versions](audit-anchor-verification.md#object-versions)).
  The statement's effect on real AWS has not been exercised here: MinIO, which the tests
  run against, evaluates no bucket policy. If it were wrong the publisher's creates would
  be refused (`s3-object-lock_UPLOAD_FAILED:AccessDenied`, alarmed), not accepted twice.
- **The chain-location binding rests on `last_published_at` for version 1 manifests.** A
  version 2 manifest names its location under the signature; a version 1 one names none,
  and the publisher accepts it when its date is the date of the greatest
  `last_published_at`. An adversary who can write the destination **and** that column can
  therefore present an authentic version 1 manifest of another chain as the settled one:
  copy it in, set the value onto its date, and the next publish chains to it. What shows
  it is the `AUDIT_ANCHOR_KEY_ROTATED` row and the `previous_manifest_deployment_changed`
  log line when the copied manifest is under another key or `DEPLOYMENT_ID`, and nothing
  when it is under the same ones. A destination writer alone can do the same only where a
  second manifest key on the high-water's date is chosen as the latest: no key of the
  publisher's own `kid` holds that date (the day of a key rotation) and the copied key
  sorts after the legitimate one; the publish that chains to it then writes
  `MULTIPLE_MANIFESTS_FOR_DATE` for that date. Once every manifest a deployment may still
  chain to is version 2, neither is possible. The first `AUDIT_ANCHOR_PUBLISHED` row
  after a chain restart must still carry `genesis: true`; the runbook keeps that check.
- **A `chainLocation` is a hash of the configured location's name.** A filesystem
  destination reached under another path, or an S3 prefix or repository that was renamed,
  is another location: its own manifests are then refused as foreign, and the reset is a
  chain restart. The GitHub location names the repository and not the API host.
- **SC5 — GitHub Releases and the filesystem do not separate writers or prevent
  deletion.** One credential writes manifests, the key archive and the statements, and
  can remove any of them; the column "Other stores" above is what that leaves
  unbounded. On GitHub the create-only write also rests on the API refusing a second
  asset of the same name, which has been exercised against a fake of the documented API
  only, and a name reserved by an upload that never finished is removed after 10 minutes
  with no conditional delete to close the window. A deployment that needs the bounds of
  the left column uses the Terraform bucket as its primary.
