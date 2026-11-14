# Runbook: Audit Anchor Key Rotation

**Audience**: operators with deployment env access and the ability to update application secrets.
**Trigger**: annual scheduled rotation, or immediately on suspected signing key compromise.
**Status**: every step below is a command that exists. The publisher signs each manifest
under one key and one tag secret, so a rotation of either is a cutover: there is no overlap
window, no dual signing and no dual tags. The operator commands are five npm scripts
(`audit-anchor-kid`, `audit-anchor-publish-pubkey`, `audit-anchor-rotation-statement`,
`audit-anchor-publish-statement`, `audit-anchor-chain-restart`; all in
`scripts/audit-anchor-keys.ts`) and the two key generators; the publisher itself emits
`AUDIT_ANCHOR_KEY_ROTATED`.

This runbook also holds the publisher's fail-closed states and their resets, the chain
restart, and the `DEPLOYMENT_ID` change, because each of them is reached from a rotation
that went wrong.

---

## Overview

The audit anchor signing key (Ed25519 seed) and tag secret (HMAC-SHA256 key) should be rotated
at least annually. Rotation does NOT invalidate historical artifacts signed under the old key;
customers who have downloaded prior manifests retain the ability to verify those manifests using
the archived old public key. Key rotation is a forward-only operation: **never reuse a
retired key** (see Step 8).

Rotate immediately if:
- The signing key or tag secret is believed to have been exfiltrated.
- The application-server environment was compromised (env dump, leaked deployment config).
- The key-provider backend (KMS / Secrets Manager) reports unauthorized access.

What the publisher does across a rotation, so that the steps make sense:

- The **primary destination** — the first configured: S3, else GitHub Releases, else the
  filesystem — is the source of truth. Each run lists it, reads the latest manifest and
  verifies it. A manifest under the publisher's own `kid` is verified with its own key; one
  under another `kid` is verified with `public-keys/<kid>.pub` **from the same destination**.
- So the old public key must be archived before the key is switched: without it the new key's
  first run cannot verify the manifest it has to chain to and fails closed
  (`CADENCE_FAILED:PUBLISHED_OBJECT_UNVERIFIABLE`).
- The first manifest under the new key names the last manifest under the old one as its
  `previousManifest`; the publisher then writes one `AUDIT_ANCHOR_KEY_ROTATED` row.

---

## Prerequisites

The scripts run from a checkout of this repository (`npm ci` done) on an operator host. They
read the destination variables the publisher reads and write to **every** configured
destination, primary first:

| Destination | Variables on the operator host |
|---|---|
| S3 | `AUDIT_ANCHOR_DESTINATION_S3_BUCKET`, `AUDIT_ANCHOR_DESTINATION_S3_PREFIX`, and AWS credentials (`AWS_PROFILE`, `AWS_REGION`) |
| GitHub Releases | `AUDIT_ANCHOR_DESTINATION_GH_REPO`, and `AUDIT_ANCHOR_DESTINATION_GH_TOKEN` or `GITHUB_TOKEN` |
| Filesystem | `AUDIT_ANCHOR_DESTINATION_FS_PATH` (the same mount the publisher writes) |

Exported variables win over the checkout's `.env` / `.env.local`, which the scripts also load;
check that those files name no destination you do not mean to write.

On the Terraform stack (`infra/terraform`), from that directory:

```bash
export AUDIT_ANCHOR_DESTINATION_S3_BUCKET=$(terraform output -raw audit_anchors_bucket_name)
export AUDIT_ANCHOR_DESTINATION_S3_PREFIX=$(terraform output -raw audit_anchor_s3_prefix)
export AWS_PROFILE=anchor-break-glass AWS_REGION=<region>
B=$AUDIT_ANCHOR_DESTINATION_S3_BUCKET PREFIX=$AUDIT_ANCHOR_DESTINATION_S3_PREFIX
cd ../..
```

`anchor-break-glass` is a CLI profile whose `role_arn` is the break-glass role
(`audit_anchor_break_glass_role_arn`): the only principal the bucket policy lets write
`<prefix>/public-keys/*` and `<prefix>/key-rotation-*`. With the variable empty the policy
refuses those writes to everyone. The stack manages the bucket policy, not that role's own
permissions. The role needs, on the prefix:

- `s3:PutObject` and `s3:PutObjectRetention` on `<bucket>/<prefix>/*` — every write carries
  COMPLIANCE mode, a 2555-day retain-until and SSE-S3, which the bucket policy requires;
- `s3:GetObject` on `<bucket>/<prefix>/*` and `s3:ListBucket` on the bucket for keys under
  `<prefix>/` — every script reads a key before it writes it and again after a write that
  found the key taken, and `audit-anchor-kid` reads the archive. Without them the script
  stops with the S3 error and writes nothing.
- `s3:ListBucketVersions` on the bucket, for the `aws s3api list-object-versions` checks
  below (the scripts do not need it).

Script behaviour common to all five:

- Exit status `0` done, `1` refused or failed, `2` usage error (a missing `--confirm` is one).
- A private key is read only from a file of mode `0600` holding exactly 64 hex characters,
  in either case (what `AUDIT_ANCHOR_SIGNING_KEY` accepts); a public key is 64 lower-case
  hex characters. No seed is printed, logged or accepted as an argument.
- A write prints the `kid`, the public key, the artifact key and the destinations, then
  refuses without `--confirm`: the write is create-only, and on the anchors bucket it cannot
  be undone. An identical object already there is success (`exists (identical)`); a
  different one is exit `1` with nothing written anywhere. A public key already archived
  is compared as a key, not byte for byte — an archive file with or without the trailing
  newline is the same key (`exists (same key)`), and nothing is written over it.

---

## Pre-rotation checklist

Before starting any rotation step, confirm all of the following:

- [ ] `AUDIT_ANCHOR_PUBLISHER_ENABLED=true` in the running deployment's env.
- [ ] The publisher worker is running and healthy (check the `AUDIT_ANCHOR_PUBLISHED` audit log
      for an entry within the last 25 hours; absence indicates the worker is not publishing).
      On AWS the alarm `<name_prefix>-audit-anchor-cadence-absent` is OK.
- [ ] Today's boundary is published — a cadence line with `kind: "published"` for it. Switch
      the key after the day's publish, not while a run is failing.
- [ ] On AWS, `audit_anchor_break_glass_role_arn` names the operator role that runs Steps 4–5,
      you can act as it, and it holds the permissions above.
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

Derive its public key and `kid` (the prefix `audit-anchor-` plus the first 8 bytes of the raw
public key in hex):

```bash
npm run audit-anchor-kid -- --key-file /secure/path/new-key.hex
# publicKey=<64 hex chars>
# kid=audit-anchor-<16 hex chars>
# archived[<destination>]=no        (one line per configured destination)
```

Call them `<new-public-key>` and `<new-kid>` below.

### Step 2: Put the current key in a key file

The rotation statement is signed by the OLD key, so its seed is needed once, in a file of
mode `0600`. On ECS it is the app secret's `AUDIT_ANCHOR_SIGNING_KEY` (run from
`infra/terraform`, with a profile that may read the app secret):

```bash
(umask 077; aws secretsmanager get-secret-value --region <region> \
  --secret-id "$(terraform output -raw app_secrets_arn)" \
  --query SecretString --output text \
  | jq -r '.AUDIT_ANCHOR_SIGNING_KEY' > /secure/path/old-key.hex)
```

```bash
npm run audit-anchor-kid -- --key-file /secure/path/old-key.hex
# kid=<old-kid>; archived[<destination>]=yes when its public key is already archived,
# "different" when the archive holds another key under that name (stop and investigate).
```

`<old-kid>` must be the `key` the publisher's boot line (`audit-anchor-publisher:
cadence=24h`) reports.

### Step 3: Sign the rotation statement

A JWS signed by the OLD key that names the new one: a verifiable bridge for auditors who
hold only the old key.

```bash
npm run audit-anchor-rotation-statement -- \
  --old-key-file /secure/path/old-key.hex \
  --new-public-key <new-public-key> \
  --out rotation.jws
# oldKid=<old-kid>
# newKid=<new-kid>
# newPublicKey=<new-public-key>
```

`--out` is create-only. The payload is
`{"issuedAt":"<ISO-8601>","newKid":"<new-kid>","newPublicKey":"<64 hex>","oldKid":"<old-kid>","op":"rotation"}`
and the header `typ` is `passwd-sso.audit-anchor-statement.v1`, so it cannot be mistaken for a
manifest. Signing and publishing are separate commands so that a publish that reached only
some destinations is retried with the same bytes.

### Step 4: Archive the old AND the new public key

As the break-glass role on AWS ("Prerequisites"). Both, before the key is switched:

```bash
npm run audit-anchor-publish-pubkey -- --key-file /secure/path/old-key.hex --confirm
npm run audit-anchor-publish-pubkey -- --public-key <new-public-key> --confirm
# kid=…  publicKey=…  artifact=public-keys/<kid>.pub  destination=<name>
# <destination>: created            (or: exists (same key))
```

- The **old** key is what lets the publisher, once it runs the new key, verify and chain to
  the last manifest under the old one. Skipping it is the
  `CADENCE_FAILED:PUBLISHED_OBJECT_UNVERIFIABLE` case in the table below.
- The **new** key is what verifiers fetch for tomorrow's manifest. Until it is archived every
  publish under it writes one `AUDIT_ANCHOR_PUBLISH_FAILED` row with
  `OWN_PUBLIC_KEY_NOT_ARCHIVED` — a daily reminder, not a failure.

The archived object is the 64 hex characters and a newline. On the anchors bucket:

```bash
aws s3api head-object --region <region> \
  --bucket "$B" --key "$PREFIX/public-keys/<new-kid>.pub"
# Expected: "ObjectLockMode": "COMPLIANCE", "ContentLength": 65
```

Verify where verifiers fetch it: `curl -fsSL "$ARCHIVE_URL/public-keys/<new-kid>.pub"` returns
200 and 64 hex chars (the bucket blocks public access, so `$ARCHIVE_URL` is whatever you serve
it from).

### Step 5: Publish the rotation statement

```bash
npm run audit-anchor-publish-statement -- --file rotation.jws --confirm
# kid=<old-kid>  op=rotation  publicKey=<old public key>
# artifact=key-rotation-<YYYYMMDD>.rotation.kid-<old-kid>.jws
# <destination>: created
```

The command verifies the statement under the key its header `kid` names — taken from the
archive (Step 4), or from `--public-key <hex>` — before it writes, and refuses a file that
does not verify or is not a statement. The date in the key is the statement's `issuedAt`.
A second, different statement of the same operation, day and signer is refused (exit `1`,
the message names the stored key); the same file published twice succeeds.

```bash
aws s3api get-object-retention --region <region> \
  --bucket "$B" --key "$PREFIX/key-rotation-<YYYYMMDD>.rotation.kid-<old-kid>.jws"
# Expected: "Mode": "COMPLIANCE"
```

### Step 6: Switch the key and restart the publisher

Set the new key in the deployment environment:

```
AUDIT_ANCHOR_SIGNING_KEY=<new-key-hex-64-chars>
```

On ECS the key is the app secret's `AUDIT_ANCHOR_SIGNING_KEY` (read-merge-write as in
`infra/terraform/README.md` "Adding a key to an existing app secret"), picked up when the
publisher task restarts:

```bash
aws ecs update-service --cluster <cluster> --service <name_prefix>-audit-anchor-publisher \
  --force-new-deployment --region <region>
```

The boot line's `key` is now `<new-kid>`. What the restarted publisher does **for the rest
of that day** is not a publish: today's manifest exists under the old key, so every run for
today's boundary reports `skipped_already_published`, warns
`audit-anchor-publisher.published_by_other_identity` (`kidMatches: false`) and writes one
`AUDIT_ANCHOR_PUBLISH_FAILED` row with `PUBLISHED_BY_OTHER_IDENTITY` per boundary per
process start. That is expected on rotation day. A skip is never the healthy line; the
day's healthy line was the old key's publish.

One consequence: if the old key's publish for today stored its object but lost its database
commit, the new key does not adopt it — adoption is for objects the publisher's own key and
`DEPLOYMENT_ID` produced. Tomorrow's publish then reports
`MISSING_PRIOR_CADENCE_PUBLICATION` although the object exists. This is why the checklist
asks for a `published` line before the switch.

Until the new key has published its first manifest, switching back to the old key is
harmless. After it, it is not (Step 8).

### Step 7: Confirm the next run chains and emits the event

At the next boundary (00:05 UTC) the publisher verifies the last old-key manifest with the
archived old public key, publishes `<date>.kid-<new-kid>.jws` with that manifest as
`previousManifest`, and writes `AUDIT_ANCHOR_KEY_ROTATED`
(`oldKid`, `newKid`, `anchoredAt`, `artifactKey`).

```bash
# One key for the day, one version, under the new kid (the key date is the UTC boundary date)
aws s3api list-object-versions --region <region> \
  --bucket "$B" --prefix "$PREFIX/$(date -u +%Y-%m-%d)."
```

The publisher writes its rows under the `__system__` sentinel tenant, so the read runs in
its scope (see `docs/operations/alerts.md` "Finding an unattributable event"):

```sql
BEGIN READ ONLY;
SET LOCAL app.tenant_id = '00000000-0000-4000-8000-000000000002';
SELECT created_at, action, metadata->>'artifactKey', metadata->>'oldKid', metadata->>'newKid',
       metadata->>'manifestSha256', metadata->>'failureReason'
FROM audit_logs
WHERE tenant_id = '00000000-0000-4000-8000-000000000002'
  AND action IN ('AUDIT_ANCHOR_PUBLISHED', 'AUDIT_ANCHOR_KEY_ROTATED', 'AUDIT_ANCHOR_PUBLISH_FAILED')
ORDER BY created_at DESC LIMIT 10;
ROLLBACK;
```

If the run fails instead, read its `reason` against the table below. A failed run is retried
every 15 minutes, at most three times per process; once those retries are spent
(`audit-anchor-publisher.retries_exhausted`) the publisher waits for the next boundary, so
after fixing the cause restart it (the command of Step 6) for a boot run.

### Step 8: Retire the old key

After Step 7 shows a manifest under the new `kid`:

- Confirm the old public key is permanently archived: `npm run audit-anchor-kid -- --key-file
  /secure/path/old-key.hex` prints `archived[<destination>]=yes` for every destination, and
  `curl -fsSL "$ARCHIVE_URL/public-keys/<old-kid>.pub"` returns 200.
- Confirm the S3 bucket has Object Lock enabled (retention mode COMPLIANCE): the file cannot
  be deleted even by the account root. Verify with:
  ```bash
  aws s3api get-object-lock-configuration --bucket "$B" --region <region>
  # Expected: "ObjectLockEnabled": "Enabled", DefaultRetention "Mode": "COMPLIANCE"
  ```
- Destroy every copy of the old seed: `/secure/path/old-key.hex`, and the old value wherever
  the secret manager keeps previous versions.

**Never reuse a retired key.** Once a manifest exists under the new `kid`, a publisher
started with the old key again finds the latest manifest under another `kid` while manifests
named with its own `kid` exist, and fails every run closed with
`CADENCE_FAILED:LATEST_UNDER_RETIRED_KEY`. The reset is to rotate forward to a fresh key
(Steps 1–7), never to bring an old one back. A manifest under a `kid` dated after the
rotation away from it is one verifiers are told not to trust
(`docs/security/audit-anchor-verification.md`).

---

## Tag secret rotation

Tag secret rotation is a customer-facing event and a hard cutover: the publisher derives
every `tenantTag` from the one `AUDIT_ANCHOR_TAG_SECRET` it is given, so from the first
manifest after the change every tenant has a new tag, and every verification kit holder
needs a new kit to find their tenant in it.

1. Generate the new secret: `npm run generate:audit-anchor-tag-secret -- --out /secure/path/new-secret.hex`
2. Notify all tenant administrators of the date, and that the verification kit must be
   downloaded again after it.
3. After the day's publish has committed (a `published` cadence line for today), replace
   `AUDIT_ANCHOR_TAG_SECRET` and restart the publisher. Not earlier: a run that has to adopt
   a manifest built under the old secret matches none of its tags to an anchor row and
   cannot settle that boundary.
4. The next publish reports **every** tenant of the previous manifest once, in one
   `AUDIT_ANCHOR_PUBLISH_FAILED` row with `TENANT_DROPPED_FROM_MANIFEST` and `count` = the
   previous manifest's tenant count: no old tag appears in the new manifest. That row is
   expected on this one publish. The same row on any other day means a tenant's
   `audit_chain_enabled` was cleared.
5. Destroy the old secret material.

The signing key is unaffected, and so is the manifest chain: `previousManifest` links
manifests, not tags. A verifier comparing a tenant's `chainSeq` across the cutover needs the
old kit for the old manifest and the new kit for the new one.

---

## Fail-closed reasons and their resets

A run that cannot tell what is published stops before it writes anything. Every one of these
is a `failed` cadence line and an `audit-anchor-publisher.cadence_failed` line (alarmed, see
`docs/operations/alerts.md`), and one `AUDIT_ANCHOR_PUBLISH_FAILED` row whose
`failureReason` is the token below. `<destination>` is `s3-object-lock`, `github-release` or
`filesystem`. The first matching row decides.

"Terraform bucket" is the anchors bucket of `infra/terraform`, whose policy lets nobody
delete, lets only the publisher's task role write a manifest key, and lets only the
break-glass role write the key archive. "Other stores" are GitHub Releases, the filesystem,
and an S3 bucket without that policy: there the writer of manifests can also delete objects
and archive keys.

| `failureReason` | Trigger | Reset — Terraform bucket | Reset — other stores |
|---|---|---|---|
| `<destination>_READ_FAILED:<code>` (stage `before_upload`) | The primary could not be listed or read. `<code>`: `UPLOAD_TIMEOUT` (the run's 60 s bound on destination I/O), an errno, `HTTP_<status>` from GitHub, the S3 error name for an S3 service error (`AccessDenied` for a denied request), `ARTIFACT_TOO_LARGE` (see the next row), `ARTIFACT_NOT_REGULAR_FILE` (filesystem only: the name of an artifact holds a symlink, a directory or a device — remove it; the publisher only ever creates regular files). | Fix access; nothing stored needs repair. Right after an upgrade it is the missing IAM read grant: apply Terraform (`docs/operations/deployment.md` "Upgrade order"). | Fix the token's access to the repository, or the mount and its permissions. |
| `<destination>_READ_FAILED:ARTIFACT_TOO_LARGE` (stage `before_upload`) | An object the run must read at the primary — the latest manifest or a public key in the archive — is larger than 8 MiB (`AUDIT_ANCHOR_ARTIFACT_MAX_BYTES`). The publisher never writes one that large, so another writer did. Every run fails the same way until it is gone. | Only the publisher's task role can write a manifest key and only the break-glass role the key archive, so treat it as use of that role's credentials. The bucket's policy lets nobody delete it, so the run cannot recover by itself: after the incident review, move the chain to a new location ("Restarting the chain"). | Remove the object; find what wrote it. |
| `CADENCE_FAILED:PUBLISHED_OBJECT_UNVERIFIABLE` | The latest manifest at the primary does not verify. The `audit-anchor-publisher.published_object_unverifiable` line carries `artifactKey` and `detail`: `PUBLIC_KEY_NOT_ARCHIVED` (it is under another `kid` whose `public-keys/<kid>.pub` is not there), `PUBLIC_KEY_INVALID` (that file is not 64 hex chars, or not that `kid`'s key), `SIGNATURE_INVALID`, `DATE_MISMATCH` (its `anchoredAt` is another UTC date than its key), `OBJECT_MISSING` (listed, but the read found nothing). | `PUBLIC_KEY_NOT_ARCHIVED`: archive that key (Step 4) — the usual cause is a rotation that skipped it. Anything else is an object nobody can remove: treat the publisher role's credentials as compromised, then restart the chain. | `PUBLIC_KEY_NOT_ARCHIVED`: archive that key. `PUBLIC_KEY_INVALID`: replace the archived file with the right key. Otherwise remove the corrupt object (restore it from a mirror or a backup if one holds it), else restart the chain. |
| `CADENCE_FAILED:PUBLISHED_OBJECT_AHEAD` | The latest manifest verifies and is dated after the wall clock's current boundary. (One that does not verify is the row above, whatever its date.) | Check the task's clock first (`date -u`): a clock that went back makes the publisher's own latest manifest look ahead. With a correct clock it was signed by a publisher whose clock ran ahead, or by someone holding a signing key — a key incident (rotate). Publishing resumes when the wall clock reaches that date; restart the chain to resume sooner. | Check the clock; remove the object. |
| `CADENCE_FAILED:LAST_PUBLISHED_AHEAD_OF_CLOCK` | The greatest `audit_chain_anchors.last_published_at` belongs to a boundary the wall clock has not reached. No publish writes such a value. | Check the clock; otherwise correct the database value ("Telling which side is wrong"). **Never a chain restart.** | The same. |
| `CADENCE_FAILED:DESTINATION_BEHIND_DATABASE` | The database records a publish (`last_published_at`) for a later boundary date than the latest manifest at the primary, or the primary holds no manifest at all. | See "Telling which side is wrong". Without a delete marker or a bucket-policy change the database is the wrong side: correct it. | The store's own history decides; restore the lost objects where a backup holds them, else restart the chain. |
| `CADENCE_FAILED:LATEST_UNDER_RETIRED_KEY` | The latest manifest is under another `kid`, while a manifest key **named** with the publisher's own `kid` exists: the publisher is running a key that was rotated away from. | Rotate forward to a fresh key (never reuse a retired key). If the key was never reverted, the name was planted: role-credential incident, then restart the chain. | Rotate forward; or, for a planted name, remove that object. |
| `<destination>_UPLOAD_FAILED:<code>` (stage `upload`) | A create at the primary or at a secondary failed or hit the 60 s bound. `<code>` is `ARTIFACT_TOO_LARGE` when the signed manifest itself is larger than 8 MiB (`AUDIT_ANCHOR_ARTIFACT_MAX_BYTES`): the destination refuses it before sending anything. The manifest's tenants are paused until the next boundary. | Fix the destination. The retry finds what the primary already holds and adopts it — no second version. | The same. |
| `<destination>_READ_FAILED:<code>` (stage `upload`) | A secondary already held the boundary's key and could not be read back for the compare (`ARTIFACT_TOO_LARGE`: the object there is larger than 8 MiB). Pause as above. | — (a secondary is never the Terraform bucket: S3 is the primary whenever it is configured) | Fix access to the secondary. |
| `<destination>_MIRROR_DIVERGED` (stage `upload`) | A secondary holds other bytes than the primary at the boundary's key. Pause as above. | — | The primary is authoritative: find out what wrote the secondary's object, remove it, and let the retry copy the primary's bytes. After a chain restart see "Restarting the chain". |
| `CADENCE_FAILED:<code>` (stage `upload`) | A database or other error after the primary held the boundary's object and before every secondary did. No pause. | Fix what `<code>` names. The retry adopts the stored object. | The same. |
| `COMMIT_FAILED_AFTER_UPLOAD:<code>` (stage `after_upload`) | Every destination holds the object; the database commit failed. `<code>` is the `error.code` of the `audit-anchor-publisher.commit_failed_after_upload` line. No pause. | Fix the database. The retry adopts the stored object and settles it. If no retry commits before the next boundary, that boundary's publish chains to the stored object and writes the detection rows for it (`comparedArtifactKey` is its key). | The same. |

Not failures, but never the healthy line either:

- `skipped_already_published` with `audit-anchor-publisher.published_by_other_identity`: the
  boundary's manifest exists and was published under another `kid` or `DEPLOYMENT_ID`.
  Expected for the rest of the day after a key rotation or a `DEPLOYMENT_ID` change. On any
  other day a second publisher writes to this prefix — a clone must have its own.
- `skipped_already_published` with `audit-anchor-publisher.stale_boundary`: the primary
  holds a manifest dated after the run's boundary (and not after the wall clock's).
- `skipped_no_tenants` with `everChainEnabled: true`: no chain-enabled tenant has an anchor
  row, while an anchor row or a manifest shows the chain was once on. With
  `chainEnabledTenantCount: 0` every tenant's chain was turned off (alarmed on its own);
  with a count above 0 the enabled tenants' anchor rows are missing — a tenant gets its row
  with its first chained event, so this lasts only until the outbox worker writes one.

Detection rows. A publish that succeeds can still write `AUDIT_ANCHOR_PUBLISH_FAILED` rows
beside its `AUDIT_ANCHOR_PUBLISHED` row; none fails the run and none is alarmed
(`docs/operations/alerts.md` has the full table):

| `failureReason` | Trigger | What to do |
|---|---|---|
| `TENANT_DROPPED_FROM_MANIFEST` (`count`) | Tenants of the manifest `comparedArtifactKey` chains to are absent from it. | Expected once after a tag-secret rotation. Otherwise find who cleared the tenant's `audit_chain_enabled` or deleted its anchor row. |
| `CHAIN_SEQ_REGRESSION` (`count`) | A tenant's `chainSeq` is below the previous manifest's, in the same epoch. | Security incident ("Chain-sequence regression"). |
| `EPOCH_CHANGED` (`count`) | A tenant's `epoch` differs from the previous manifest's. No code path writes it, and a changed epoch takes the tenant out of the regression check. | Database-write incident: find who changed `audit_chain_anchors.epoch`, and compare the tenant's `chainSeq` across the two manifests by hand. |
| `PREVIOUS_MANIFEST_UNAVAILABLE_FOR_COMPARISON` | A publish could not read back the previous manifest that `comparedArtifactKey` names (the manifest it adopted, or an earlier one no publish settled), or that object is not the one named, or the read-back failed or hit the run's bound (the `previous_manifest_unavailable` line's `detail` is then an error code): the three rows above were not computed for that manifest. | Expected only after a destination error; fix it. Otherwise find out why the previous manifest is missing or changed (on the Terraform bucket it cannot be, without a delete marker or a policy change). Either way compare the two manifests by hand with `audit-verify --prior-manifest`. |
| `UNSETTLED_WALK_TRUNCATED` (`count`) | More unsettled manifests precede this publish than one run compares (7): `count` were compared, `comparedArtifactKey` being the last, and the ones before it were not. | Compare the remaining manifests by hand, each with the one before it (`passwd-sso audit-verify --prior-manifest`), and find why `last_published_at` is behind: more than 7 boundaries stored and never settled, or a value moved back or cleared in the database (a database-write incident). |

The three comparison rows are written whether the run signed the manifest or adopted one an
earlier run stored: an adopt reads the previous manifest back from the primary. A boundary
adopted more than once repeats them, at most three times (the attempt cap). Each row carries
`comparedArtifactKey`, the manifest it is about. That is the published manifest
(`artifactKey`), or an earlier one that was stored and never settled — every run of its
boundary failed after the primary held the object (a secondary failure,
`COMMIT_FAILED_AFTER_UPLOAD`, a stage-`upload` failure, or the attempt cap): the next
publish that commits compares each such manifest, back to the last settled one, with the
manifest it chains to — at most 7 of them, and `UNSETTLED_WALK_TRUNCATED` when more remain.

Where a step waits for the publisher: a failed run is retried every 15 minutes, at most three
times per process and never within the last 30 minutes before the next boundary. When those
retries are spent the publisher waits for the next boundary, so restart it (Step 6's command)
once the cause is fixed. The states above that fail before the attempt is counted do not use
up the three counted runs per boundary; if a restart reports `upload_cap_reached` for a
boundary that must still be published, delete the `audit_anchor_upload_attempts` row
(`docs/operations/alerts.md`).

### Telling which side is wrong

`DESTINATION_BEHIND_DATABASE` says the database and the primary disagree; it does not say
which one changed. **The destination's own evidence decides.** `AUDIT_ANCHOR_PUBLISHED` rows
are database content — the side under suspicion — and corroborate only.

- **Terraform bucket.** An object cannot vanish without leaving a delete marker, and deletes
  are refused to everyone unless the bucket policy was replaced, which fires
  `<name_prefix>-audit-anchor-bucket-config-change`:
  ```bash
  aws s3api list-object-versions --bucket "$B" --prefix "$PREFIX/" --region <region> \
    --query '{Versions: Versions[].[Key, VersionId, LastModified, IsLatest], DeleteMarkers: DeleteMarkers[].[Key, VersionId, LastModified]}'
  ```
  No delete marker and no policy-change event: nothing was lost, the database value is wrong,
  and a chain restart is not an option — it would discard a chain that is intact.
- **GitHub Releases, filesystem.** The store's own history: the repository's audit log and
  release events, the volume's backups and snapshots. If objects were lost and a backup
  holds them, restore the same bytes under the same keys; if not, restart the chain.
- **A new or changed primary** that is empty while the database records publishes is this
  state too, and is a chain restart by definition (below).

`LAST_PUBLISHED_AHEAD_OF_CLOCK` needs no such judgement: a publish writes the wall clock
clamped into its own boundary, so a value past the current boundary was written by something
else, or the clock went back. Correct the clock or the value; never restart the chain.

**Correcting the database value**, as the owner role. `audit_chain_anchors` admits only a
bypassed session — without the `SET LOCAL` lines the statements match no row. Take
`<anchoredAt>` from the latest manifest the primary holds (`<date>T00:05:00.000Z` for the key
`<date>.kid-<kid>.jws`):

```sql
BEGIN;
SET LOCAL app.bypass_rls = 'on';
SET LOCAL app.bypass_tables = 'audit_chain_anchors';
SET LOCAL app.bypass_purpose = 'system_maintenance';
SELECT tenant_id, last_published_at FROM audit_chain_anchors
WHERE last_published_at IS NOT NULL ORDER BY last_published_at DESC;
-- Every value past the latest manifest's own boundary goes back to that boundary.
UPDATE audit_chain_anchors
SET last_published_at = '<anchoredAt>', updated_at = now()
WHERE last_published_at >= '<anchoredAt>'::timestamptz + interval '1 day';
COMMIT;
```

Then restart the publisher. If the primary holds no manifest at all and that is the correct
state (nothing was ever published there), use the clearing statement under "Restarting the
chain" instead.

**Upgrade note.** Releases before this protocol wrote the wall clock, unclamped, to
`last_published_at`. A run that began for one boundary and committed after the next one had
started left a value that maps one boundary late. On the first run after the upgrade that
value reads as a publish the primary does not hold (`DESTINATION_BEHIND_DATABASE`, or
`LAST_PUBLISHED_AHEAD_OF_CLOCK` when it is the current day's). It is a database value no
publish of this release writes, and the statement above corrects it.

---

## Restarting the chain

The reset of last resort for `PUBLISHED_OBJECT_UNVERIFIABLE`, `PUBLISHED_OBJECT_AHEAD`,
`DESTINATION_BEHIND_DATABASE` (objects really lost) and `LATEST_UNDER_RETIRED_KEY` (a planted
name) — and the only way to add or change the primary destination. There is no seeding of a
new location with old manifests: on the Terraform bucket nobody but the publisher's task
role can write a manifest key, and copying history out of a weaker store would lock it in
unverified. The old chain stays where it is; a new one starts at a new location, and a
signed statement there says where the old one ended.

1. **On S3, deal with the publisher role's credentials first** when the trigger is one that
   those credentials alone can produce (a garbage or future-dated manifest key, a planted
   key name). Find how they were used (`docs/operations/alerts.md` "Publisher task role
   passed to another task"), revoke the role's active sessions, and only then continue —
   otherwise the new prefix can be wedged the same way.
2. Stop the publisher (ECS: `aws ecs update-service --cluster <cluster> --service
   <name_prefix>-audit-anchor-publisher --desired-count 0 --region <region>`).
3. **A new location.** On the Terraform stack, a new `audit_anchor_s3_prefix`: the bucket
   policy, the publisher's IAM policy and its task env are all built from it, so one
   `terraform apply` moves all three. The apply also sets the service's desired count back
   from `worker_desired_count`: stop the publisher again before continuing (until step 5 it
   would only fail closed with `DESTINATION_BEHIND_DATABASE`). Elsewhere, a new prefix,
   repository or path — or the new primary destination.
4. **Archive the public keys there again** (Step 4's command, with the destination variables
   pointing at the new location): the current key, and every earlier key if verifiers'
   archive URL will serve from the new location.
5. **Clear `last_published_at`**, as the owner role. The new primary is empty, and any
   recorded publish would fail the first run with `DESTINATION_BEHIND_DATABASE`:
   ```sql
   BEGIN;
   SET LOCAL app.bypass_rls = 'on';
   SET LOCAL app.bypass_tables = 'audit_chain_anchors';
   SET LOCAL app.bypass_purpose = 'system_maintenance';
   UPDATE audit_chain_anchors
   SET last_published_at = NULL, updated_at = now()
   WHERE last_published_at IS NOT NULL;
   -- Expect UPDATE <number of tenants that were ever published>
   COMMIT;
   ```
6. **Sign and publish the chain-restart statement** at the new location. It names the old
   chain's last manifest that verifies, or states that none survives:
   ```bash
   npm run audit-anchor-chain-restart -- \
     --key-file /secure/path/current-key.hex \
     --previous-manifest last-verified.jws \
     --previous-uri <where a verifier can fetch that manifest> \
     --out restart.jws
   # kid=<kid>
   # previousChain=<uri> sha256=<sha256 of that manifest's payload>

   npm run audit-anchor-publish-statement -- --file restart.jws --confirm
   # artifact=key-rotation-<YYYYMMDD>.chain-restart.kid-<kid>.jws
   ```
   The command verifies the previous manifest before it signs and refuses one that does not
   verify. When that manifest is under another key than `--key-file`, add
   `--previous-public-key <path to its .pub file>`. When no manifest of the old chain
   verifies, replace the three `--previous-*` arguments with `--previous-none`.

   This needs the current signing key in a file on the operator's host: use an ephemeral
   host and destroy the file afterwards. In an incident pair the restart with a rotation —
   generate a fresh key (Step 1), sign the statement with it, and give the publisher that
   key in step 8.
7. **Secondaries.** A secondary kept in the configuration still holds the old chain's object
   for the restart day. If the key did not change, the new chain's first manifest has the
   same key name with other bytes, and that day fails with `<destination>_MIRROR_DIVERGED`.
   Either give the secondary a new location too, or take it out of the configuration for
   that day and add it back the next: the backfill then copies what it lacks, and for the
   restart day it keeps the old chain's object, which the backfill does not compare.
8. Start the publisher with the new location (and key). Its first run publishes a manifest
   with `previousManifest: null`; the `AUDIT_ANCHOR_PUBLISHED` row carries `genesis: true`,
   and one `MISSING_PRIOR_CADENCE_PUBLICATION` row accompanies it, as on any first publish.
   **Check that row.** The first `AUDIT_ANCHOR_PUBLISHED` row after a restart must carry
   `genesis: true`. Anything else is an incident: a manifest is not bound to the location
   it is stored at, so an old-chain manifest copied into the new location before this run
   is adopted (its own date) or chained to (an earlier date) like any other, and the new
   chain then continues the old one. Stop the publisher, remove what was copied where the
   store allows it, or start again at another new location.
9. Tell verifiers the new archive location and point them at the restart statement
   (`docs/security/audit-anchor-verification.md` "Verifying a statement").

### Adding or changing a destination

- **The primary** — a new bucket or prefix, or a destination that becomes the first
  configured one (adding S3 to a GitHub-only deployment makes S3 the primary). The new
  primary is empty, the database records publishes: `DESTINATION_BEHIND_DATABASE` on the
  first run. It is a chain restart; follow the steps above, with the old primary's last
  manifest as `--previous-manifest`.
- **A secondary** — no restart. Each publishing run copies to it up to 7 manifests the
  primary holds and it lacks, newest first, so a long history fills over as many days as it
  takes. The backfill is a log-only byte copy: a failed copy, including an older
  object at the secondary that differs from the primary's (`MIRROR_DIVERGED`), logs
  `audit-anchor-publisher.mirror_backfill_failed` and changes no outcome — it raises no
  alarm and no `cadence_failed`. Only the boundary's own manifest diverging at a secondary
  fails the run (`<destination>_MIRROR_DIVERGED`). The key archive and the statements are not copied: run Steps 4–5 with the
  secondary configured.

---

## DEPLOYMENT_ID change recovery (rare)

`DEPLOYMENT_ID` is a stable UUID set once at first deployment and never changed under normal
operations. Every manifest carries it as `deploymentId`; changing it does not break the
chain — the next manifest chains to the previous one whatever its `deploymentId` and the
publisher logs `audit-anchor-publisher.previous_manifest_deployment_changed`. Only attempt
this if the environment has been completely re-provisioned.

The same procedure gives a clone or a restored copy of a deployment its own value (see
`docs/operations/deployment.md` "`DEPLOYMENT_ID`"). A clone also needs its own destination
and a chain restart there.

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
6. **Only when the orphan attachment sweep runs** (`retention_gc_blob_sweep_mode` not `off`;
   `docs/operations/deployment.md` "Orphan attachment sweep on AWS"): the attachments bucket's
   marker still holds the old id, so the sweep refuses every tick with `marker_mismatch`.
   Whether to re-create it depends on who else uses the bucket.

   Inside this Terraform module the attachments bucket belongs to one stack — Terraform creates
   it, S3 bucket names are global, and the worker's `S3_ATTACHMENTS_BUCKET` is set only from that
   resource — **unless** the bucket was imported into another Terraform state, or another
   stack names it explicitly (`attachments_bucket_name`). The question is whether any deployment
   other than this stack writes to it — for example a Docker or restored copy given
   `S3_ATTACHMENTS_BUCKET` and S3 credentials directly. Answer it from positive evidence, not
   from the absence of a permission: CloudTrail S3 data events, or S3 server access logs, for
   the bucket over at least one grace period (`retention_gc_blob_orphan_grace_ms`). Any
   `PutObject` by a principal other than this stack's task roles (`*-ecs-task`,
   `*-ecs-retention-gc-task`) and your own operator principals means another deployment uses
   the bucket. Without that evidence
   — no data-event trail and no access logs for the period — treat the bucket as shared.

   - **No other deployment uses the bucket**: as an operator, delete the marker
     (`aws s3api delete-object --bucket <attachments-bucket> --key .passwd-sso-deployment
     --region <region>`), run `--init-blob-marker` once (deployment.md, "Running the worker's
     one-off commands"; expect `"result":"created"`), then restart the worker so it reads the
     new id — secrets are injected at task start, and the running task keeps the old one and
     refuses with `marker_mismatch` until replaced:
     `aws ecs update-service --cluster <cluster> --service <name_prefix>-retention-gc-worker
     --force-new-deployment --region <region>`.
   - **Another deployment uses it, or the evidence above is unavailable**: never touch the marker, and
     set the sweep `off`. Re-creating the marker would make this deployment the bucket's owner,
     and every object the other deployment uploads would then look orphaned to this sweep.

**The rest of that day skips.** Today's manifest carries the old `deploymentId`, so it is not
this publisher's: every run for today's boundary reports `skipped_already_published` with
`audit-anchor-publisher.published_by_other_identity` (`deploymentMatches: false`) and one
`PUBLISHED_BY_OTHER_IDENTITY` row per boundary per process start. Publishing resumes at the
next boundary. As on rotation day, a publish whose commit was lost just before the change is
never adopted, and the next day's publish reports `MISSING_PRIOR_CADENCE_PUBLICATION`
although the object exists — make the change after a `published` line for the day.

This `system_settings` update is captured by the database-level audit trail (pgaudit,
connection `application_name` logs), not by application-layer `AUDIT_ANCHOR_KEY_ROTATED`
emission. The `AUDIT_ANCHOR_KEY_ROTATED` action is reserved for signing-key rotation events.

---

## Concurrent publisher serialization

Two publisher instances racing (accidental double-start; on ECS the service runs at most
one task and a deploy stops the old one first) are safe by design, in two layers.

- **The lock.** Every run sets `lock_timeout` (10 s) and takes the blocking
  `pg_advisory_xact_lock(hashtext('audit-anchor-publish'))`. Under it the publish transaction
  reads the database and lists the primary again and decides again, so an instance that
  waited behind a publish finds the boundary's manifest and reports
  `skipped_already_published` without a write. A run that waits past the timeout stands down
  with `lock_held` (`LOCK_HELD_BY_OTHER_INSTANCE`), which writes no
  `AUDIT_ANCHOR_PUBLISH_FAILED` row and is retried for the same boundary like a failure.
- **The create-only write.** A manifest is written only if no object holds its key
  (`If-None-Match: *` on S3, `link()` on the filesystem, the asset name on GitHub). A write
  that finds the key taken reads the stored object back: one this publisher's key and
  `DEPLOYMENT_ID` produced is adopted — its bytes are what is mirrored and settled, not the
  bytes this run signed — and anything else is not. So a writer that did not take the lock
  still cannot leave a second version of a day's key through the publisher.

The holder of the lock is not guaranteed to publish — any role that can connect can take the
advisory lock — so on AWS `lock_held` is alarmed
(`<name_prefix>-audit-anchor-publisher-lock-held`); find the holder with the `pg_locks` query
under `audit-anchor-publisher.lock_held` in `docs/operations/alerts.md`. `DEPLOYMENT_ID` does
not serialize instances: it only stops a publisher configured for another deployment from
booting. Two deployments pointed at one prefix (a clone) are told apart by the manifest
itself: whichever runs second for a boundary skips with `published_by_other_identity`, and
its cadence-absent alarm fires within a day.

The two `system_settings` rows earlier releases used to decide these questions,
`audit_anchor_last_published_boundary` and `audit_anchor_previous_manifest`, are inert:
nothing reads or writes them, and whatever they hold changes nothing.

---

## Failure response

### Signing key unavailable

- The publisher's env schema requires `AUDIT_ANCHOR_SIGNING_KEY` whenever it is enabled, so a
  missing or malformed key stops it at boot (`env validation failed`, path and code only). No
  `AUDIT_ANCHOR_PUBLISH_FAILED` row and no pause is written: nothing ran.
- On AWS the alarm `<name_prefix>-audit-anchor-publisher-down` fires after 10 minutes, and
  `<name_prefix>-audit-anchor-cadence-absent` once a day has passed without a publish.
- **Recovery**: restore the key in the app secret and restart the publisher. Its boot run
  publishes the current boundary, chained to the latest manifest the primary holds; a
  boundary missed meanwhile is reported once as `MISSING_PRIOR_CADENCE_PUBLICATION`.

### Destination outage (S3 or GitHub Release)

- **The primary cannot be listed or read**: the run fails before it writes anything,
  `<destination>_READ_FAILED:<code>`, stage `before_upload`. No pause.
- **A create fails** — at the primary, or at a secondary after the primary accepted the
  manifest — or the 60 s bound on the run's destination I/O fires:
  `<destination>_UPLOAD_FAILED:<code>`, stage `upload`. The run pauses the manifest's tenants
  until the next boundary: the outbox worker stops advancing their `chain_seq`. The pause
  does not hold publishing, and it ends at the next boundary whatever happens.
- The scheduler retries the boundary every 15 minutes, at most three times per process and not
  later than 30 minutes before the next one. At most three runs per boundary reach the publish
  transaction, across restarts; the fourth reports `upload_cap_reached` (alarmed) and writes
  one `UPLOAD_ATTEMPT_CAP_REACHED` row. A manifest those runs stored and none settled is
  compared with its previous one by the next boundary's publish (the detection rows'
  `comparedArtifactKey`). A retry that finds the boundary's manifest already
  at the primary adopts it — it writes no second version, copies the same bytes to the
  secondaries, and clears the pause. See `docs/operations/alerts.md` "Audit anchor publisher".
- A secondary that stays down fails each day's run after the primary holds that day's
  manifest. The chain is unaffected (the next day chains to what the primary holds); once the
  secondary is back, the day's run mirrors its own manifest and the backfill copies the
  earlier ones, up to 7 per publishing run. None of those days' manifests was settled, so
  that first publish also writes the comparison rows for them (`comparedArtifactKey`), up
  to 7 manifests back, and `UNSETTLED_WALK_TRUNCATED` when the outage lasted longer.

### Manifest build failure

- A failure to build or sign the manifest, or any database error inside the publish
  transaction before the create, fails the run: `failureReason: "CADENCE_FAILED:<code>"`,
  stage `before_upload`. It costs an attempt and is retried every 15 minutes like any failure,
  so a deterministic one reaches the cap (`upload_cap_reached`) after three runs.
- A `before_upload` failure before the attempt count is written (the database unreachable, the
  tenants read failing, the fail-closed states of the table above) costs no attempt; the
  scheduler's three-retry bound per process is what stops it. An
  `audit_anchor_upload_attempts` value that does not parse is treated as past the cap for
  that boundary (`upload_cap_reached` with `countUnreadable: true`, one
  `UPLOAD_ATTEMPT_COUNT_UNREADABLE` row); the next boundary counts 1 again and publishes.
- Escalate to engineering. Roll back the publisher worker to the prior release if a release
  introduced it — but never to a release from before this protocol
  (`docs/operations/deployment.md` "Upgrade order").

### Chain-sequence regression

- The publisher compares each manifest it publishes with the one that manifest chains to —
  the one in hand when it signed the manifest, the one read back from the primary when it
  adopted a stored one. For a tenant tag present in both, in the same epoch, a lower
  `chainSeq` is a regression: after the publish commits it writes one
  `AUDIT_ANCHOR_PUBLISH_FAILED` row with `CHAIN_SEQ_REGRESSION` and `count`, the number of
  tenants affected. It is detection only — the manifest is published as the anchor rows are.
- A tag whose `epoch` differs between the two manifests is not compared; it is reported as
  `EPOCH_CHANGED` instead. Nothing writes `epoch`, so that row is an incident of its own.
- The verifier's side: `passwd-sso audit-verify --prior-manifest` exits 17
  (`ChainSeqRegressionError`) for a regression, and prints a `WARN: epoch changed …` line on
  stderr — exit status unchanged — for a tenant whose epoch differs.
- A regression is either a bug or active tampering. Treat as a security incident.

---

## References

- Plan ADR: `docs/archive/review/audit-anchor-external-commitment-plan.md`
- Protocol plan: `docs/archive/review/audit-anchor-hardening-plan.md`
- Customer verification guide: `docs/security/audit-anchor-verification.md`
- Threat model: `docs/security/audit-chain-threat-model.md`
- Publisher implementation: `src/workers/audit-anchor-publisher.ts`,
  `src/lib/audit/anchor-published-state.ts`
- Operator scripts: `scripts/audit-anchor-keys.ts`
- Key generation scripts: `scripts/generate-audit-anchor-signing-key.sh`,
  `scripts/generate-audit-anchor-tag-secret.sh`
