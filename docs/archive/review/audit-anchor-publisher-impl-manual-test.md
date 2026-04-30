# Manual Test Plan: audit-anchor-publisher-impl

Target branch: `feature/admin-vault-reset-dual-approval` (Batch 8 — documentation only)
Implementation branch (when ready): `feature/audit-anchor-publisher-impl`
Dev URL: `https://localhost:3001/passwd-sso`
Tier: **R35 Tier-2 (cryptographic-material-handling addition)** — required.

Scope: publisher worker publication cycle, CLI `audit-verify` command, destination layer,
concurrent-publisher serialization, fail-closed behavior, and key rotation overlap.
Adversarial scenarios cover tenant enumeration, signature reuse, kid path traversal,
and chain regression.

---

## Pre-conditions

- Dev server running at `https://localhost:3001/passwd-sso` (`curl /api/health/live` → 200).
- Docker stack up: `db`, `redis`, `jackson`, `mailpit`, `audit-outbox-worker`.
- Migrations applied: `audit_chain_anchors` includes `epoch`, `publish_paused_until`,
  `last_published_at` columns; `system_settings` table exists.
- Prisma client regenerated after schema changes: `npm run db:generate` + dev server restart.
- At least one tenant with `audit_chain_enabled = true` and `audit_logs` rows exists.
- `AUDIT_ANCHOR_SIGNING_KEY`, `AUDIT_ANCHOR_TAG_SECRET`, `DEPLOYMENT_ID`,
  `AUDIT_ANCHOR_PUBLISHER_ENABLED=true`, `AUDIT_ANCHOR_DESTINATION_FS_PATH=<tmp>` are set.
- `AUDIT_ANCHOR_PUBLIC_KEY_ARCHIVE_URL` is set to the FS destination base URL (or local path
  for testing).
- `passwd-sso` CLI is built: `npm run build:cli` (or `cd cli && npm run build`).

### Pre-test DB snapshot

```sql
SELECT tenant_id, chain_seq, epoch, publish_paused_until, last_published_at
FROM audit_chain_anchors
WHERE audit_chain_enabled = true;
```

Capture this baseline before running any test.

---

## Tests

### Scenario 1: Happy path daily publication [Operator-only]

**Pre-conditions:**
- At least one chain-enabled tenant with `audit_logs` rows has `chain_seq >= 1`.
- `publish_paused_until` is NULL for all chain-enabled tenants.

**Steps:**
1. Trigger a publisher cadence run:
   ```bash
   node -e "
     const { runCadence } = require('./dist/workers/audit-anchor-publisher');
     runCadence(new Date()).then(console.log);
   "
   ```
2. Observe stdout for structured `{ kind: 'published', ... }` outcome.
3. Check the FS destination directory for the manifest file:
   ```bash
   ls -lh "$AUDIT_ANCHOR_DESTINATION_FS_PATH/"
   # Expected: <date>.kid-<kid>.jws  (non-zero size)
   ```
4. Check the audit log:
   ```sql
   SELECT created_at, action, metadata
   FROM audit_logs
   WHERE action = 'AUDIT_ANCHOR_PUBLISHED'
   ORDER BY created_at DESC LIMIT 3;
   ```
5. Check `last_published_at` updated:
   ```sql
   SELECT tenant_id, last_published_at
   FROM audit_chain_anchors
   WHERE audit_chain_enabled = true;
   ```

**Expected:**
- Manifest JWS file exists at destination; byte-identical between all configured destinations.
- `AUDIT_ANCHOR_PUBLISHED` audit row present; `metadata` includes `manifestSha256`,
  `destinations[]`, `tenantsCount >= 1`.
- `audit_chain_anchors.last_published_at` updated to within 5 seconds of current time.
- `publish_paused_until` remains NULL.

**Rollback:**
```sql
UPDATE audit_chain_anchors SET last_published_at = NULL WHERE audit_chain_enabled = true;
```
Delete test manifest files from FS destination. If a GitHub Release or S3 stub was created,
delete the test release/object.

---

### Scenario 2: Customer detects tamper [Customer-runnable]

**Pre-conditions:**
- Customer holds yesterday's manifest (scenario 1 produced `yesterday.jws`).
- Simulate operator rewriting 3 audit_logs rows for tenant T:
  ```sql
  UPDATE audit_logs
  SET metadata = '{"tampered": true}'::jsonb
  WHERE tenant_id = '<test-tenant-id>'
    AND chain_seq IN (1, 2, 3);
  ```
  Note: this does NOT update `event_hash` or `chain_prev_hash`, so an internal chain-verify
  would still detect the tamper. The external manifest detects it independently.

**Steps:**
1. Customer runs `audit-verify` with yesterday's manifest (before the rewrite):
   ```bash
   passwd-sso audit-verify \
     --manifest yesterday.jws \
     --my-tenant-id <test-tenant-id> \
     --tag-secret-file kit/tag-secret.hex
   ```
2. Customer exports their own DB rows and replays `event_hash` chain locally,
   finding a mismatch with the `prevHash` committed in the manifest.

**Expected:**
- CLI exits **0** (the manifest itself is signature-valid; signing key was not compromised).
- The manifest's `prevHash` for tenant T does NOT match what the rewritten DB now computes.
- The discrepancy is detectable by the customer's local chain replay — without server cooperation.
- stdout: `PASS — tenantTag=<tag>, chainSeq=<N>, prevHash=<hash>, epoch=1`

**Rollback:**
```sql
-- Restore the tampered rows from the audit_logs backup taken in pre-test snapshot.
-- If no backup: git reset and re-run db:seed for test data.
```

---

### Scenario 3: Signing key unavailable (fail-closed) [Operator-only]

**Pre-conditions:**
- Publisher worker is not currently running a cadence.
- Signing key is about to be removed from env mid-cycle (simulated below).

**Steps:**
1. Temporarily unset `AUDIT_ANCHOR_SIGNING_KEY`:
   ```bash
   AUDIT_ANCHOR_SIGNING_KEY="" node -e "
     const { runCadence } = require('./dist/workers/audit-anchor-publisher');
     runCadence(new Date()).then(console.log);
   "
   ```
2. Observe stdout for `{ kind: 'failed', ... }`.
3. Check audit log:
   ```sql
   SELECT created_at, action, metadata
   FROM audit_logs
   WHERE action = 'AUDIT_ANCHOR_PUBLISH_FAILED'
   ORDER BY created_at DESC LIMIT 3;
   ```
4. Check `publish_paused_until` is set:
   ```sql
   SELECT tenant_id, publish_paused_until
   FROM audit_chain_anchors
   WHERE audit_chain_enabled = true;
   ```
5. Confirm that the outbox worker skips chain advancement for paused tenants:
   ```sql
   -- All chain-enabled tenants should have publish_paused_until > now()
   -- and their audit_outbox rows should remain PENDING.
   SELECT status, COUNT(*) FROM audit_outbox
   WHERE tenant_id = '<test-tenant-id>'
   GROUP BY status;
   ```

**Expected:**
- `runCadence` returns `{ kind: "failed" }`.
- `AUDIT_ANCHOR_PUBLISH_FAILED` audit row with `metadata.failureReason` containing
  `SIGNING_KEY_MISSING` (or equivalent key-unavailable indicator).
- `publish_paused_until` is set to approximately `now() + 1× cadence`.
- Outbox worker logs confirm paused-tenant skip (`queryCounter.chainEnableQueries === 0` for
  paused tenants in the next poll cycle).
- No manifest file written to destination.

**Rollback:**
Restore `AUDIT_ANCHOR_SIGNING_KEY` in env. Restart publisher worker.
```sql
UPDATE audit_chain_anchors SET publish_paused_until = NULL WHERE audit_chain_enabled = true;
```

---

### Scenario 4: Primary destination 503 [Operator-only]

**Pre-conditions:**
- S3 stub (MinIO or fetch interceptor) is configured to return 503.
- GitHub Release stub (if configured) returns 200.

**Steps:**
1. Configure S3 stub to return 503:
   ```bash
   # Set AUDIT_ANCHOR_DESTINATION_S3_BUCKET to point at the 503-stub endpoint.
   ```
2. Trigger `runCadence(new Date())`.
3. Observe outcome.

**Expected:**
Current implementation behavior (document actual result):
- If ANY destination fails, the publisher exits with `{ kind: "failed" }` and sets
  `publish_paused_until`. The `last_published_at` column is NOT updated (the final DB write
  only runs after all destinations succeed).
- `AUDIT_ANCHOR_PUBLISH_FAILED` audit row with `failureReason: "DESTINATION_ERROR"` (or similar).
- GitHub Release stub file (if written) represents a partial upload. On-call reviews the
  `last_published_at` gap at next cadence (post-check emits `MISSING_PRIOR_CADENCE_PUBLICATION`).

Note: if a future release implements secondary-tolerant policy (continue on S3 failure when
GitHub succeeds), this scenario's expected result changes. Update this section accordingly.

**Rollback:**
Restore S3 stub to return 200. Delete any partially-uploaded GitHub Release asset.
```sql
UPDATE audit_chain_anchors SET publish_paused_until = NULL WHERE audit_chain_enabled = true;
```

---

### Scenario 5: Key rotation overlap [Operator-only]

**Pre-conditions:**
- Old key K1 is the current `AUDIT_ANCHOR_SIGNING_KEY`. A prior manifest exists signed by K1.
- New key K2 has been generated.

**Steps:**
1. Set overlap env:
   ```bash
   AUDIT_ANCHOR_SIGNING_KEY=<k2-hex>
   AUDIT_ANCHOR_SIGNING_KEY_OVERLAP=<k1-hex>
   AUDIT_ANCHOR_OVERLAP_END=$(date -u -d '+7 days' +%Y-%m-%dT%H:%M:%SZ)
   ```
2. Trigger `runCadence(new Date())`.
3. Confirm two manifest files exist at destination:
   ```bash
   ls "$AUDIT_ANCHOR_DESTINATION_FS_PATH/"
   # Expected:
   #   <date>.kid-<k1-kid>.jws
   #   <date>.kid-<k2-kid>.jws
   ```
4. Verify K1-signed manifest:
   ```bash
   passwd-sso audit-verify --manifest <date>.kid-<k1-kid>.jws \
     --public-key /secure/path/k1.pub \
     --my-tenant-id <test-tenant-id> \
     --tag-secret-file kit/tag-secret.hex
   # Expected: exit 0, PASS
   ```
5. Verify K2-signed manifest:
   ```bash
   passwd-sso audit-verify --manifest <date>.kid-<k2-kid>.jws \
     --public-key /secure/path/k2.pub \
     --my-tenant-id <test-tenant-id> \
     --tag-secret-file kit/tag-secret.hex
   # Expected: exit 0, PASS
   ```
6. Verify the key-rotation advisory JWS (published via rotation script, signed by K1):
   ```bash
   passwd-sso audit-verify --manifest key-rotation-$(date +%Y%m%d).jws \
     --public-key /secure/path/k1.pub
   # Expected: exit 0, PASS
   ```

**Expected:**
- Both manifest files are byte-identical in their canonical JSON bodies; only the JWS header
  (`kid`) and signature bytes differ.
- Both verify cleanly under their respective public keys.
- Key-rotation advisory itself verifies under K1.

**Rollback:**
Restore env to K1-only. Delete the K2-signed manifest and advisory files from destination.

---

### Scenario 6: Cross-deployment verification (auditor) [Customer-runnable]

**Pre-conditions:**
- External auditor holds the public key URL and manifest URL. NO DB access. NO tag secret.

**Steps:**
1. Auditor fetches manifest and public key (follows the openssl recipe in
   `docs/security/audit-anchor-verification.md`):
   ```bash
   curl -fsSL "$ARCHIVE_URL/<date>.kid-<kid>.jws" -o manifest.jws
   curl -fsSL "$ARCHIVE_URL/public-keys/<kid>.pub" -o anchor.pub
   ```
2. Auditor runs openssl verification (per docs/security/audit-anchor-verification.md §Quick check).
3. Auditor inspects manifest JSON:
   ```bash
   cut -d. -f2 manifest.jws \
     | awk '{ pad=length($0)%4; if(pad) for(i=pad;i<4;i++) printf "="; print }' \
     | tr '_-' '/+' | base64 -d | python3 -m json.tool
   ```

**Expected:**
- Signature verified by openssl (`Signature Verified Successfully`).
- Manifest JSON shows `tenantTag` entries (64-char hex); does NOT expose raw `tenantId` values.
- Auditor CANNOT enumerate which tenants exist or what their names are.
- `deploymentId` (stable UUID) is visible; auditor can use it as a cross-publication stability check.

---

### Scenario 7: DEPLOYMENT_ID mismatch boot [Operator-only]

**Pre-conditions:**
- `system_settings` has `key='audit_anchor_deployment_id'`, `value='<uuid-A>'`.
- Publisher env has `DEPLOYMENT_ID=<uuid-B>` (different value).

**Steps:**
1. Start the publisher worker:
   ```bash
   DEPLOYMENT_ID=<uuid-B> node dist/workers/audit-anchor-publisher.js
   ```
2. Observe stderr / exit code.
3. Check audit log:
   ```sql
   SELECT created_at, action, metadata
   FROM audit_logs
   WHERE action = 'AUDIT_ANCHOR_PUBLISH_FAILED'
   ORDER BY created_at DESC LIMIT 3;
   ```

**Expected:**
- Publisher exits immediately with non-zero exit code.
- stderr contains `DEPLOYMENT_ID_MISMATCH` (or equivalent).
- `AUDIT_ANCHOR_PUBLISH_FAILED` audit row with `failureReason: "DEPLOYMENT_ID_MISMATCH"`.
- No manifest is published.
- `publish_paused_until` is set (fail-closed).

**Rollback:**
```bash
docker compose exec db psql -U passwd_user -d passwd_sso -c \
  "UPDATE system_settings SET value='<uuid-B>' WHERE key='audit_anchor_deployment_id';"
```
Or restore `DEPLOYMENT_ID=<uuid-A>` in env.

---

## Adversarial scenarios (Tier-2 required)

### Adversarial Scenario A: kid path traversal [Customer-runnable]

**Description:** Malicious actor crafts a JWS with `kid: "audit-anchor-../../etc/passwd"` and
asks a victim customer to verify it.

**Pre-conditions:**
- Craft a JWS with a malformed kid in the protected header. The JWS need not have a valid
  signature; the kid validation fires before any network request.

**Steps:**
1. Create the malicious JWS (the signature bytes can be zeroed; the CLI validates kid first):
   ```bash
   # Protected header: {"alg":"EdDSA","kid":"audit-anchor-../../etc/passwd","typ":"passwd-sso.audit-anchor.v1"}
   EVIL_HEADER=$(echo -n '{"alg":"EdDSA","kid":"audit-anchor-../../etc/passwd","typ":"passwd-sso.audit-anchor.v1"}' \
     | base64 | tr '+/' '-_' | tr -d '=')
   echo "$EVIL_HEADER.e30.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" \
     > evil.jws
   ```
2. Run:
   ```bash
   passwd-sso audit-verify --manifest evil.jws \
     --archive-url "$ARCHIVE_URL"
   echo "exit code: $?"
   ```

**Expected:**
- CLI exits **1** (or a defined non-zero code) with `InvalidKidError` message on stderr.
- NO network request is made to `$ARCHIVE_URL` (the kid regex rejects before fetch).
- Verify with a network proxy (e.g., `mitmproxy`) that no outbound request occurs.

---

### Adversarial Scenario B: tenantTag UUID case sensitivity [Customer-runnable]

**Description:** Customer accidentally supplies uppercase tenant UUID.

**Steps:**
```bash
passwd-sso audit-verify \
  --manifest manifest.jws \
  --my-tenant-id 550E8400-E29B-41D4-A716-446655440000 \
  --tag-secret-file kit/tag-secret.hex
echo "exit code: $?"
```

**Expected:**
- CLI exits **14** (`InvalidTenantIdFormatError`).
- stderr: `tenantId must be canonical lower-case UUID (RFC 4122 §3); got 550E8400-...`
- NO automatic case conversion is performed. The error message makes the fix clear.

---

### Adversarial Scenario C: chain regression detection [Customer-runnable]

**Description:** Operator publishes manifest B with `chainSeq = 8` after prior manifest A had
`chainSeq = 10` for the same tenant (same epoch). Customer holds both manifests.

**Pre-conditions:**
- Produce manifest A with `chainSeq = 10` (scenario 1 produced this naturally after enough events).
- Simulate manifest B by directly constructing a lower-seq manifest:
  ```bash
  # Modify manifest body (for testing only — will have invalid signature)
  # Use the integration test fixture: src/__tests__/db-integration/audit-anchor-regression-detection.integration.test.ts
  # This scenario is best verified via the integration test. For manual testing:
  # Supply --prior-manifest pointing to a manifest with higher chainSeq.
  ```

**Steps:**
```bash
passwd-sso audit-verify \
  --manifest B.jws \
  --prior-manifest A.jws \
  --public-key anchor.pub
echo "exit code: $?"
```

**Expected:**
- CLI exits **17** (`ChainSeqRegressionError`).
- stderr: `CHAIN_SEQ_REGRESSION at tenantTag=<tag>: prior=10, current=8`.
- A legitimate epoch increment (e.g., prior epoch=1 seq=10, current epoch=2 seq=3) is NOT
  flagged; FR8 comparison: `(epoch=2, seq=3) > (epoch=1, seq=10)` — accepted.

---

### Adversarial Scenario D: payload tamper after signing [Customer-runnable]

**Description:** Attacker obtains a valid manifest JWS, decodes the payload, modifies one
`chainSeq` value, re-encodes the payload with the tampered bytes, and reassembles the JWS
with the ORIGINAL header and signature.

**Steps:**
1. Decode payload, increment one `chainSeq`:
   ```bash
   ORIG=$(cut -d. -f2 manifest.jws)
   PAYLOAD_JSON=$(echo "$ORIG" \
     | awk '{ pad=length($0)%4; if(pad) for(i=pad;i<4;i++) printf "="; print }' \
     | tr '_-' '/+' | base64 -d)
   # Modify chainSeq value in PAYLOAD_JSON (e.g., sed s/"chainSeq":"5"/"chainSeq":"6"/)
   TAMPERED_B64=$(echo "$MODIFIED_JSON" | base64 | tr '+/' '-_' | tr -d '=')
   HEADER=$(cut -d. -f1 manifest.jws)
   SIG=$(cut -d. -f3 manifest.jws)
   echo "$HEADER.$TAMPERED_B64.$SIG" > tampered.jws
   ```
2. Run:
   ```bash
   passwd-sso audit-verify --manifest tampered.jws --public-key anchor.pub
   echo "exit code: $?"
   ```

**Expected:**
- CLI exits **12** (`InvalidSignatureError`).
- The re-canonicalize-and-compare step in the verifier detects that the canonical bytes of
  the (tampered) body do not match the original payload bytes that were signed. Even if the
  attacker re-canonicalizes their tampered body, the signature over the new signing input
  is invalid.

---

## Session fixation in dashboard kit download (reference only)

Dashboard kit download requires a fresh MFA challenge. Session fixation attacks (attacker
pre-seeds a session before the user authenticates) are governed by the existing session
management controls (Auth.js v5 session rotation on authentication). This scenario is OUT OF
SCOPE for this manual test plan. Reference: `docs/security/audit-anchor-verification.md` §Threat-model boundary.

---

## Rollback (global)

If any scenario leaves the environment in a broken state:

1. Identify which scenario failed from the audit log:
   ```sql
   SELECT created_at, action, metadata FROM audit_logs
   WHERE action IN ('AUDIT_ANCHOR_PUBLISHED', 'AUDIT_ANCHOR_PUBLISH_FAILED',
                    'AUDIT_ANCHOR_PUBLISH_PAUSED', 'AUDIT_ANCHOR_KEY_ROTATED')
   ORDER BY created_at DESC LIMIT 20;
   ```
2. Clear any stuck `publish_paused_until` flags:
   ```sql
   UPDATE audit_chain_anchors SET publish_paused_until = NULL WHERE audit_chain_enabled = true;
   ```
3. Delete test manifest files from FS destination (`$AUDIT_ANCHOR_DESTINATION_FS_PATH`).
4. Restore env vars to the baseline captured in pre-conditions.
5. Restart the publisher worker and audit-outbox worker.
6. Run scenario 1 again to confirm a clean publication cycle before sign-off.

---

## Sign-off

- [ ] Scenarios 1-7 PASS
- [ ] Adversarial Scenarios A-D PASS
- [ ] Session fixation reference noted (out of scope)
- Reviewer: ___
- Date: ___
- Notes:

---

## References

- Plan ADR: `docs/archive/review/audit-anchor-external-commitment-plan.md`
- Customer verification guide: `docs/security/audit-anchor-verification.md`
- Rotation runbook: `docs/operations/audit-anchor-rotation-runbook.md`
- CLI source: `cli/src/commands/audit-verify.ts`
- Style reference: `docs/archive/review/verifier-pepper-dual-version-manual-test.md`
- Integration tests: `src/__tests__/db-integration/audit-anchor-publisher.integration.test.ts`
