# Runbook: Audit Anchor Key Rotation

**Audience**: operators with deployment env access and the ability to update application secrets.
**Trigger**: annual scheduled rotation, or immediately on suspected signing key compromise.
**Status**: documented. The publisher worker and key-generation scripts are prerequisites
(see Implementation steps 5 and 7 in `docs/archive/review/audit-anchor-external-commitment-plan.md`).

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
- [ ] At least one prior manifest exists at `<ARCHIVE_URL>/<date>.kid-<old-kid>.jws`.
- [ ] The audit-outbox pipeline is healthy: `audit_outbox` has no rows stuck in `PENDING` for
      more than 2× poll cadence.
- [ ] A DB snapshot / PITR marker has been created for rollback.

---

## Signing key rotation steps

### Step 1: Generate the new signing key

Run on a secure host with no persistent shell history (or with history disabled):

```bash
npm run generate:audit-anchor-signing-key > /secure/path/new-key.hex
# Output: 64-char hex string (32-byte Ed25519 seed)
# Treat this file like a private TLS key. Mode: chmod 600 /secure/path/new-key.hex
```

Derive the `kid` for the new key. By convention the publisher derives `kid` from the
first 8 bytes of the public key in hex, prefixed by `audit-anchor-`. Confirm via:

```bash
npm run audit-anchor-kid -- --key-file /secure/path/new-key.hex
# Prints: audit-anchor-<16 hex chars>
```

Call the new kid `<new-kid>` in the steps below.

### Step 2: Set the new key in env

Update the deployment environment with the NEW key:

```
AUDIT_ANCHOR_SIGNING_KEY=<new-key-hex-64-chars>
```

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

Run the advisory generation script:

```bash
npm run audit-anchor-rotation-advisory \
  --old-key-file /secure/path/old-key.hex \
  --old-kid <old-kid> \
  --new-kid <new-kid> \
  --overlap-start <ISO-8601-start> \
  --overlap-end <ISO-8601-end> \
  | aws s3 cp - "s3://$S3_BUCKET/audit-anchors/key-rotation-$(date +%Y%m%d).jws"
```

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

Emit the `AUDIT_ANCHOR_KEY_ROTATED` audit event (`phase: "overlap-start"`) via the publisher:

```bash
npm run audit-anchor-emit-rotation-event -- \
  --old-kid <old-kid> --new-kid <new-kid> --phase overlap-start
```

### Step 5: Upload the new public key to the archive

```bash
npm run audit-anchor-publish-pubkey -- \
  --key-file /secure/path/new-key.hex \
  --kid <new-kid>
# Writes to: $S3_BUCKET/audit-anchors/public-keys/<new-kid>.pub (immutable)
# Also mirrors to GitHub Release asset if GH destination is configured.
```

Verify: `curl -fsSL "$ARCHIVE_URL/public-keys/<new-kid>.pub"` returns 200 and 64 hex chars.

### Step 6: Monitor the overlap window

After the overlap window start, confirm daily publication of BOTH kid variants:

```bash
# Check S3 for both kids for today's date
aws s3 ls "s3://$S3_BUCKET/audit-anchors/$(date +%Y-%m-%d)."
# Expected: two .jws files, one per kid
```

Monitor the `AUDIT_ANCHOR_PUBLISHED` audit log for successful double-publication:
```sql
SELECT created_at, metadata->>'manifestSha256', metadata->>'destinations'
FROM audit_logs
WHERE action = 'AUDIT_ANCHOR_PUBLISHED'
ORDER BY created_at DESC LIMIT 10;
```

### Step 7: Retire the old key (after overlap end)

Wait until `AUDIT_ANCHOR_OVERLAP_END` has passed AND confirm the last manifest under the old kid
was published. Then:

**Pre-destruction precondition (R31 gate)**:
- Confirm old public key is permanently archived: `curl -fsSL "$ARCHIVE_URL/public-keys/<old-kid>.pub"` → 200.
- Confirm the S3 bucket has Object Lock enabled (retention mode COMPLIANCE): the file cannot
  be deleted even by the account root. Verify with:
  ```bash
  aws s3api get-object-lock-configuration --bucket "$S3_BUCKET"
  # MFADelete or ObjectLockEnabled: Enabled
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

Emit the `AUDIT_ANCHOR_KEY_ROTATED` audit event (`phase: "overlap-end"`):

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

Rotation procedure:

1. Generate new tag secret: `npm run generate:audit-anchor-tag-secret > /secure/path/new-secret.hex`
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

1. Stop the publisher worker.
2. Update `system_settings` in the database:
   ```sql
   UPDATE system_settings
   SET value = '<new-uuid>', updated_at = now()
   WHERE key = 'audit_anchor_deployment_id';
   ```
3. Update the deployment env: `DEPLOYMENT_ID=<new-uuid>`.
4. Restart the publisher worker.
5. Verify the publisher boots without `DEPLOYMENT_ID_MISMATCH` in the audit log.

This `system_settings` update is captured by the database-level audit trail (pgaudit,
connection `application_name` logs), not by application-layer `AUDIT_ANCHOR_KEY_ROTATED`
emission. The `AUDIT_ANCHOR_KEY_ROTATED` action is reserved for signing-key rotation events.

---

## Concurrent publisher serialization

Two publisher instances racing (rolling deploy, accidental double-start) are safe by design:
the publisher holds a PostgreSQL advisory lock (`pg_try_advisory_xact_lock`) for the entire
publish cycle. A second instance that cannot acquire the lock exits cleanly and logs
`LOCK_HELD_BY_OTHER_INSTANCE` to stdout. This is the normal "lost the race" outcome and does
NOT produce an `AUDIT_ANCHOR_PUBLISH_FAILED` audit row.

---

## Failure response

### Signing key unavailable

- Publisher emits `AUDIT_ANCHOR_PUBLISH_FAILED` with `failureReason: "SIGNING_KEY_MISSING"`.
- Sets `publish_paused_until` on affected tenant rows (sliding window, hard cap at 3× cadence = 72h).
- The outbox worker stops advancing `chain_seq` for paused tenants.
- After 3× cadence with no recovery, on-call is paged via the configured alert channel.
- **Recovery**: restore the signing key in env, restart the publisher. On next cadence the
  publisher clears `publish_paused_until` and resumes publication.

### Destination outage (S3 or GitHub Release)

- Publisher emits `AUDIT_ANCHOR_PUBLISH_FAILED`.
- Retry at next cadence (both destinations must succeed within 1× cadence; secondary-tolerant
  per plan Axis 8).
- S3 Object Lock integrity is unaffected by a GitHub Release outage (artifacts are independent).

### Manifest schema validation failure

- Publisher blocks publication and emits `AUDIT_ANCHOR_PUBLISH_FAILED` with
  `failureReason: "SCHEMA_VALIDATION_FAILED"`.
- This is a programming error, not a transient fault. Do NOT retry automatically.
- Escalate to engineering. Roll back the publisher worker to the prior release.

### Chain-sequence regression detected

- Publisher blocks, emits `AUDIT_ANCHOR_PUBLISH_FAILED`, and pages on-call immediately.
- A regression is either a bug or active tampering. Treat as a security incident.
- Do NOT restart the publisher until the regression source is identified and resolved.

---

## References

- Plan ADR: `docs/archive/review/audit-anchor-external-commitment-plan.md`
- Customer verification guide: `docs/security/audit-anchor-verification.md`
- Pepper rotation runbook (style reference): `docs/archive/review/pepper-rotation-runbook.md`
- Publisher implementation: `src/workers/audit-anchor-publisher.ts`
- Key generation scripts: `scripts/generate-audit-anchor-signing-key.sh`,
  `scripts/generate-audit-anchor-tag-secret.sh`
