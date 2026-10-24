# Runbook: Audit Anchor Key Rotation

**Audience**: operators with deployment env access and the ability to update application secrets.
**Trigger**: annual scheduled rotation, or immediately on suspected signing key compromise.
**Status**: partly automated. What exists: the publisher (one signing key, one tag secret),
the key-generation scripts, and the anchors bucket's write paths for Steps 4–5 (written by
hand with `aws s3api put-object`, below). What does not exist yet, and is marked
**Not yet automated** where a step relies on it: the npm scripts `audit-anchor-kid`,
`audit-anchor-rotation-advisory`, `audit-anchor-emit-rotation-event` and
`audit-anchor-publish-pubkey`; the overlap variables `AUDIT_ANCHOR_SIGNING_KEY_OVERLAP`,
`AUDIT_ANCHOR_OVERLAP_END` and `AUDIT_ANCHOR_TAG_SECRET_NEW`, which no code reads (the
publisher signs each manifest under one key); and any emitter of `AUDIT_ANCHOR_KEY_ROTATED`.
Until they exist, a rotation is a hard cutover: the day after the key changes, the manifest
is under the new kid only. Tracked as SC6 of
`docs/archive/review/aws-anchor-publisher-verify-worker-plan.md`.

---

## Overview

The audit anchor signing key (Ed25519 seed) and tag secret (HMAC-SHA256 key) should be rotated
at least annually. Rotation does NOT invalidate historical artifacts signed under the old key;
customers who have downloaded prior manifests retain the ability to verify those manifests using
the archived old public key. Key rotation is a forward-only operation.

Rotate immediately if:
- The signing key or tag secret is believed to have been exfiltrated.
- The application-server environment was compromised (env dump, leaked deployment config).
- The key-provider backend (KMS / Secrets Manager) reports unauthorized access.

---

## Pre-rotation checklist

Before starting any rotation step, confirm all of the following:

- [ ] Old public key is archived: `curl -fsSL "$ARCHIVE_URL/public-keys/<old-kid>.pub"` returns 200.
- [ ] `AUDIT_ANCHOR_PUBLISHER_ENABLED=true` in the running deployment's env.
- [ ] The publisher worker is running and healthy (check the `AUDIT_ANCHOR_PUBLISHED` audit log
      for an entry within the last 25 hours; absence indicates the worker is not publishing).
      On AWS the alarm `<name_prefix>-audit-anchor-cadence-absent` is OK.
- [ ] On AWS, `audit_anchor_break_glass_role_arn` names the operator role that runs Steps 4–5,
      and you can act as it (below). With the variable empty, the bucket policy refuses
      those writes to everyone.
- [ ] At least one prior manifest exists at `<ARCHIVE_URL>/<date>.kid-<old-kid>.jws`.
- [ ] The audit-outbox pipeline is healthy: `audit_outbox` has no rows stuck in `PENDING` for
      more than 2× poll cadence.
- [ ] A DB snapshot / PITR marker has been created for rollback.

---

## Signing key rotation steps

### Step 1: Generate the new signing key

Run on a secure host with no persistent shell history (or with history disabled):

```bash
npm run generate:audit-anchor-signing-key -- --out /secure/path/new-key.hex
# Writes a 64-char hex string (32-byte Ed25519 seed) with mode 0600.
# Treat this file like a private TLS key.
```

`--out`, not `> file`: `npm run` prints its own banner to stdout, which a redirect would
write into the key file.

Derive the `kid` for the new key. The publisher derives `kid` from the first 8 bytes of the
raw public key in hex, prefixed by `audit-anchor-`.

**Not yet automated**: `npm run audit-anchor-kid` does not exist. The same derivation with
openssl (the DER prefix is the PKCS#8 header the publisher wraps the seed in):

```bash
PUB=$( (printf '302e020100300506032b657004220420'; tr -d '\n' < /secure/path/new-key.hex) \
  | xxd -r -p | openssl pkey -inform DER -pubout -outform DER | tail -c 32 | xxd -p -c 64)
echo "public key: $PUB"            # 64 hex chars — Step 5 publishes this
echo "kid: audit-anchor-${PUB:0:16}"
```

Call the new kid `<new-kid>` in the steps below.

### Step 2: Set the new key in env

Update the deployment environment with the NEW key:

```
AUDIT_ANCHOR_SIGNING_KEY=<new-key-hex-64-chars>
```

**Not yet automated**: the overlap below is not implemented — no code reads
`AUDIT_ANCHOR_SIGNING_KEY_OVERLAP` or `AUDIT_ANCHOR_OVERLAP_END`, and setting them has no effect.
On ECS the key is the app secret's `AUDIT_ANCHOR_SIGNING_KEY` (read-merge-write as in
`infra/terraform/README.md` "Adding a key to an existing app secret"), picked up when the
publisher task restarts (`aws ecs update-service … --force-new-deployment`). The design
intent follows.

Do NOT remove the old key from env yet. The overlap window requires the publisher to produce
manifests under BOTH the old and new key simultaneously. The publisher's key-selector logic
reads `AUDIT_ANCHOR_SIGNING_KEY` for the primary (new) key and
`AUDIT_ANCHOR_SIGNING_KEY_OVERLAP=<old-key-hex>` for the secondary during the overlap period.

Set the overlap period start and end:

```
AUDIT_ANCHOR_SIGNING_KEY_OVERLAP=<old-key-hex-64-chars>
AUDIT_ANCHOR_OVERLAP_END=<ISO-8601 date 7 days from now, e.g. 2026-05-08T00:00:00Z>
```

Deploy the updated env. Restart the publisher worker.

### Step 3: Configure the overlap window (default 7 days)

During the overlap window the publisher signs each daily manifest TWICE — once under the old key
and once under the new key — and publishes both to all destinations:

```
<ARCHIVE_URL>/<date>.kid-<old-kid>.jws   # signed with old key
<ARCHIVE_URL>/<date>.kid-<new-kid>.jws   # signed with new key
```

Both files contain byte-identical manifest bodies (same canonical JSON). Customers who
auto-detect the `kid` in the JWS header transparently migrate to the new public key without
configuration changes.

### Step 4: Publish the key-rotation advisory JWS

The rotation advisory is a JWS signed by the OLD key, announcing the new key. It serves as
a verifiable, machine-readable bridge for auditors who hold only the old key.

**Not yet automated**: `npm run audit-anchor-rotation-advisory`, which would sign the
advisory, does not exist; produce `advisory.jws` (payload below, signed with the old key)
by other means.

Write it to the bucket **as the break-glass role** — the only principal the bucket policy
lets write `<prefix>/key-rotation-*` (`audit_anchor_break_glass_role_arn`). The PUT must carry
COMPLIANCE mode, a retain-until within the policy's cap (`audit_anchor_object_lock_days` + 31
days; 2555 days matches the publisher's), and SSE-S3; without the lock headers the policy
refuses it. Use the configured prefix, never a literal `audit-anchors/`. Run from
`infra/terraform`; `anchor-break-glass` is a CLI profile whose `role_arn` is the break-glass
role:

```bash
B=$(terraform output -raw audit_anchors_bucket_name)
PREFIX=$(terraform output -raw audit_anchor_s3_prefix)
RETAIN_UNTIL=$(node -e 'console.log(new Date(Date.now()+2555*864e5).toISOString().replace(/\.\d{3}Z$/,"Z"))')

aws s3api put-object --profile anchor-break-glass --region <region> \
  --bucket "$B" --key "$PREFIX/key-rotation-$(date -u +%Y%m%d).jws" \
  --body advisory.jws --content-type application/jose \
  --object-lock-mode COMPLIANCE --object-lock-retain-until-date "$RETAIN_UNTIL" \
  --server-side-encryption AES256 --checksum-algorithm SHA256

aws s3api get-object-retention --profile anchor-break-glass --region <region> \
  --bucket "$B" --key "$PREFIX/key-rotation-$(date -u +%Y%m%d).jws"
# Expected: "Mode": "COMPLIANCE", "RetainUntilDate": the value above
```

The key is written once: COMPLIANCE keeps every version, so a second PUT of the same key
adds a version rather than replacing the first.

Advisory JWS payload:

```json
{
  "op": "rotation",
  "oldKid": "<old-kid>",
  "newKid": "<new-kid>",
  "overlapStart": "<ISO-8601>",
  "overlapEnd": "<ISO-8601>"
}
```

Emit the `AUDIT_ANCHOR_KEY_ROTATED` audit event (`phase: "overlap-start"`) via the publisher.
**Not yet automated**: the script below does not exist and nothing emits this action yet;
record the rotation in your change log instead.

```bash
npm run audit-anchor-emit-rotation-event -- \
  --old-kid <old-kid> --new-kid <new-kid> --phase overlap-start
```

### Step 5: Upload the new public key to the archive

**Not yet automated**: `npm run audit-anchor-publish-pubkey` does not exist (nor the GitHub
Release mirror it describes). Write the public key from Step 1 (`$PUB`, 64 hex chars) by hand,
as the break-glass role, with the same lock headers as Step 4:

```bash
printf '%s' "$PUB" > "<new-kid>.pub"

aws s3api put-object --profile anchor-break-glass --region <region> \
  --bucket "$B" --key "$PREFIX/public-keys/<new-kid>.pub" \
  --body "<new-kid>.pub" --content-type text/plain \
  --object-lock-mode COMPLIANCE --object-lock-retain-until-date "$RETAIN_UNTIL" \
  --server-side-encryption AES256 --checksum-algorithm SHA256

aws s3api head-object --profile anchor-break-glass --region <region> \
  --bucket "$B" --key "$PREFIX/public-keys/<new-kid>.pub"
# Expected: "ObjectLockMode": "COMPLIANCE", "ContentLength": 64
```

Verify where verifiers fetch it: `curl -fsSL "$ARCHIVE_URL/public-keys/<new-kid>.pub"` returns
200 and 64 hex chars (the bucket blocks public access, so `$ARCHIVE_URL` is whatever you serve
it from).

### Step 6: Monitor the overlap window

After the overlap window start, confirm daily publication of BOTH kid variants:

```bash
# Check S3 for today's manifests (the key date is the UTC boundary date)
aws s3api list-object-versions --region <region> \
  --bucket "$B" --prefix "$PREFIX/$(date -u +%Y-%m-%d)."
# Expected with an overlap: one key per kid. Today (no overlap, see Status): one key, the new kid.
```

Monitor the `AUDIT_ANCHOR_PUBLISHED` audit log for successful publication. The publisher
writes these rows under the `__system__` sentinel tenant, so the read runs in its scope (see
`docs/operations/alerts.md` "Finding an unattributable event"):
```sql
BEGIN READ ONLY;
SET LOCAL app.tenant_id = '00000000-0000-4000-8000-000000000002';
SELECT created_at, metadata->>'manifestSha256', metadata->>'artifactKey', metadata->>'destinations'
FROM audit_logs
WHERE tenant_id = '00000000-0000-4000-8000-000000000002'
  AND action = 'AUDIT_ANCHOR_PUBLISHED'
ORDER BY created_at DESC LIMIT 10;
ROLLBACK;
```

### Step 7: Retire the old key (after overlap end)

Wait until `AUDIT_ANCHOR_OVERLAP_END` has passed AND confirm the last manifest under the old kid
was published. Then:

**Pre-destruction precondition (R31 gate)**:
- Confirm old public key is permanently archived: `curl -fsSL "$ARCHIVE_URL/public-keys/<old-kid>.pub"` → 200.
- Confirm the S3 bucket has Object Lock enabled (retention mode COMPLIANCE): the file cannot
  be deleted even by the account root. Verify with:
  ```bash
  aws s3api get-object-lock-configuration --bucket "$B" --region <region>
  # Expected: "ObjectLockEnabled": "Enabled", DefaultRetention "Mode": "COMPLIANCE"
  ```
- If the key is stored in a secret manager, the `block-secret-key-destruction.sh` harness hook
  fires on `vault kv delete` / `aws kms schedule-key-deletion`. The hook requires confirmation
  that the OLD public key is archived and immutable before allowing destruction to proceed.

Remove the overlap env vars and destroy the old private key:

```bash
# Remove from env:
#   AUDIT_ANCHOR_SIGNING_KEY_OVERLAP
#   AUDIT_ANCHOR_OVERLAP_END
# Deploy the updated env. Restart the publisher worker.

# Destroy old private key from secret manager (after hook confirmation):
# vault kv delete secret/audit-anchor/<old-kid>   # or AWS KMS equivalent
```

Emit the `AUDIT_ANCHOR_KEY_ROTATED` audit event (`phase: "overlap-end"`).
**Not yet automated** (as in Step 4):

```bash
npm run audit-anchor-emit-rotation-event -- \
  --old-kid <old-kid> --new-kid <new-kid> --phase overlap-end
```

---

## Tag secret rotation

Tag secret rotation is a customer-facing event: all existing verification kit holders must
download a new kit after rotation. Plan a 30-day overlap period.

During the overlap period, the publisher includes BOTH old-tag and new-tag entries for each
tenant in every manifest:

```json
{ "tenantTag": "<old-tag>", "chainSeq": "...", "prevHash": "...", "epoch": 1 }
{ "tenantTag": "<new-tag>", "chainSeq": "...", "prevHash": "...", "epoch": 1 }
```

**Not yet automated**: no code reads `AUDIT_ANCHOR_TAG_SECRET_NEW`, so the dual-tag overlap
below does not happen; replacing `AUDIT_ANCHOR_TAG_SECRET` is a hard cutover for every kit
holder. The design intent follows.

Rotation procedure:

1. Generate new tag secret: `npm run generate:audit-anchor-tag-secret -- --out /secure/path/new-secret.hex`
2. Set `AUDIT_ANCHOR_TAG_SECRET_NEW=<new-hex>` in env alongside the existing
   `AUDIT_ANCHOR_TAG_SECRET=<old-hex>`. Deploy.
3. Notify all tenant administrators that a new verification kit is available. Allow 30 days
   for customers to download and update their automation.
4. After the overlap period, remove `AUDIT_ANCHOR_TAG_SECRET` (old) and rename
   `AUDIT_ANCHOR_TAG_SECRET_NEW` to `AUDIT_ANCHOR_TAG_SECRET`. Deploy.
5. Destroy the old secret material using the R31 gate (same pattern as signing key destruction).

---

## DEPLOYMENT_ID change recovery (rare)

`DEPLOYMENT_ID` is a stable UUID set once at first deployment and never changed under normal
operations. Changing it invalidates all existing manifests' `deploymentId` claim. Only attempt
this if the environment has been completely re-provisioned.

The same procedure gives a clone or a restored copy of a deployment its own value (see
`docs/operations/deployment.md` "`DEPLOYMENT_ID`").

1. Stop the publisher worker (ECS: `aws ecs update-service --cluster <cluster> --service
   <name_prefix>-audit-anchor-publisher --desired-count 0 --region <region>`).
2. Update `system_settings` in the database, as the owner role. `system_settings` admits only a
   bypassed session — without the `SET LOCAL` lines the `UPDATE` matches no row and reports
   `UPDATE 0`:
   ```sql
   BEGIN;
   SET LOCAL app.bypass_rls = 'on';
   SET LOCAL app.bypass_tables = 'system_settings';
   SET LOCAL app.bypass_purpose = 'system_maintenance';
   UPDATE system_settings
   SET value = '<new-uuid>', updated_at = now()
   WHERE key = 'audit_anchor_deployment_id';
   -- Expect UPDATE 1 (UPDATE 0 on a database where no publisher has booted: nothing to change)
   COMMIT;
   ```
3. Update the deployment env: `DEPLOYMENT_ID=<new-uuid>` (ECS: the app secret's
   `DEPLOYMENT_ID` key, read-merge-write).
4. Restart the publisher worker (ECS: `--desired-count 1`; the next `terraform apply` sets it
   from `worker_desired_count` anyway).
5. Verify the publisher boots without `DEPLOYMENT_ID_MISMATCH` in the audit log.

This `system_settings` update is captured by the database-level audit trail (pgaudit,
connection `application_name` logs), not by application-layer `AUDIT_ANCHOR_KEY_ROTATED`
emission. The `AUDIT_ANCHOR_KEY_ROTATED` action is reserved for signing-key rotation events.

---

## Concurrent publisher serialization

Two publisher instances racing (accidental double-start; on ECS the service runs at most
one task and a deploy stops the old one first) are safe by design. Every run sets
`lock_timeout` (10 s) and takes the blocking `pg_advisory_xact_lock(hashtext('audit-anchor-publish'))`,
then reads the boundary marker `audit_anchor_last_published_boundary` under it: a run for a
boundary at or before the marker reports `skipped_already_published` (the marker only moves
forward; one past the wall clock's current boundary fails the run closed instead, with
`CADENCE_FAILED:BOUNDARY_MARKER_AHEAD`). A run that waits past the timeout stands down with `lock_held`
(`LOCK_HELD_BY_OTHER_INSTANCE`). Neither produces an `AUDIT_ANCHOR_PUBLISH_FAILED` row. A
`lock_held` run is retried for the same boundary like a failure (every 15 minutes, at most
three times per process); when the holder did publish, the retry's marker re-check skips. The
holder is not guaranteed to publish — any role that can connect can take the advisory lock —
so on AWS `lock_held` is alarmed (`<name_prefix>-audit-anchor-publisher-lock-held`); find the
holder with the `pg_locks` query under `audit-anchor-publisher.lock_held` in
`docs/operations/alerts.md`. `DEPLOYMENT_ID` does not serialize instances: it only stops a
publisher configured for another deployment from booting.

---

## Failure response

### Signing key unavailable

- The publisher's env schema requires `AUDIT_ANCHOR_SIGNING_KEY` whenever it is enabled, so a
  missing or malformed key stops it at boot (`env validation failed`, path and code only). No
  `AUDIT_ANCHOR_PUBLISH_FAILED` row and no pause is written: nothing ran.
- On AWS the alarm `<name_prefix>-audit-anchor-publisher-down` fires after 10 minutes, and
  `<name_prefix>-audit-anchor-cadence-absent` once a day has passed without a publish.
- **Recovery**: restore the key in the app secret and restart the publisher. Its boot run
  publishes the current boundary; a boundary missed meanwhile is reported once as
  `MISSING_PRIOR_CADENCE_PUBLICATION`.

### Destination outage (S3 or GitHub Release)

- Every configured destination must accept the manifest; a refusal at any of them, or the
  60 s upload bound, fails the run: `AUDIT_ANCHOR_PUBLISH_FAILED` with
  `failureReason: "<destination>_UPLOAD_FAILED:<code>"`.
- The run pauses the manifest's tenants until the next boundary: the outbox worker stops
  advancing their `chain_seq`. The pause no longer holds publishing, and it ends at the next
  boundary whatever happens.
- The scheduler retries the boundary every 15 minutes, at most three times per process and not
  later than 30 minutes before the next one. At most three runs per boundary reach the upload,
  across restarts; the fourth reports `upload_cap_reached`
  (alarmed) and writes one `UPLOAD_ATTEMPT_CAP_REACHED` row. A successful retry clears the
  pause. See `docs/operations/alerts.md` "Audit anchor publisher".
- S3 Object Lock integrity is unaffected by a GitHub Release outage (artifacts are independent).

### Manifest build failure

- A failure to build or sign the manifest (including an `audit_anchor_previous_manifest` that
  does not parse) fails the run before the upload: `failureReason: "CADENCE_FAILED:<code>"`,
  stage `before_upload`. It costs an attempt and is retried every 15 minutes like any failure, so
  a deterministic one reaches the cap (`upload_cap_reached`) after three runs.
- A `before_upload` failure before the attempt count is written (the database unreachable, the
  tenants read failing) costs no attempt; the scheduler's three-retry bound per process is what
  stops it. An `audit_anchor_upload_attempts` value that does not parse is treated as past the
  cap for that boundary (`upload_cap_reached` with `countUnreadable: true`, one
  `UPLOAD_ATTEMPT_COUNT_UNREADABLE` row); the next boundary counts 1 again and publishes.
- Escalate to engineering. Roll back the publisher worker to the prior release if a release
  introduced it.

### Chain-sequence regression

- The publisher does not compare `chainSeq` across manifests; it publishes the anchor rows as
  they are. A regression is detected on the verifier's side: `passwd-sso audit-verify
  --prior-manifest` exits 17 (`ChainSeqRegressionError`).
- A regression is either a bug or active tampering. Treat as a security incident.

---

## References

- Plan ADR: `docs/archive/review/audit-anchor-external-commitment-plan.md`
- Customer verification guide: `docs/security/audit-anchor-verification.md`
- Pepper rotation runbook (style reference): `docs/archive/review/pepper-rotation-runbook.md`
- Publisher implementation: `src/workers/audit-anchor-publisher.ts`
- Key generation scripts: `scripts/generate-audit-anchor-signing-key.sh`,
  `scripts/generate-audit-anchor-tag-secret.sh`
