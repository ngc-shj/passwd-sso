# Audit Anchor Verification

This document explains how customers and external auditors can independently verify the integrity
of their audit log chain using the externally-committed anchor manifests. The design is specified
in `docs/archive/review/audit-anchor-external-commitment-plan.md` (ADR). The manifest mechanism
ensures that any server-side rewrite of historical `audit_logs` rows is detectable without
server cooperation: a holder of the public key and the published manifest can detect tampering
even if both the database and the internal chain-verify endpoint report no anomalies.

---

## What you need to verify

| Item | Where to find it |
|---|---|
| Public key URL | Your operator provides `<ARCHIVE_URL>/public-keys/<kid>.pub`. The `kid` appears in the JWS header. |
| Manifest file | Published daily at `<ARCHIVE_URL>/<date>.kid-<kid>.jws` (primary S3 + GitHub Release mirror). |
| Your tenant ID | Settings → General → Tenant Information. Format: lower-case UUID, e.g. `550e8400-e29b-41d4-a716-446655440000`. |
| Tag secret | Obtained from the dashboard verification kit (Settings → Security → Download Audit-Anchor Kit). Kit download requires a fresh login + MFA challenge. **Never share the tag secret or print it in documentation.** |

---

## Quick check via openssl

This recipe verifies the cryptographic signature without installing the `passwd-sso` CLI.
It confirms that the manifest was signed by the operator's private key; it does NOT replay
your individual chain events.

```bash
# 1. Fetch the manifest (replace <ARCHIVE_URL> and <date>.kid-<kid> with actual values)
curl -fsSL "$ARCHIVE_URL/<date>.kid-<kid>.jws" -o manifest.jws

# 2. Extract the kid from the JWS protected header
KID=$(cut -d. -f1 manifest.jws \
  | awk '{ pad=length($0)%4; if(pad) for(i=pad;i<4;i++) printf "="; print }' \
  | tr '_-' '/+' \
  | base64 -d \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['kid'])")
echo "kid: $KID"

# 3. Fetch the matching public key
curl -fsSL "$ARCHIVE_URL/public-keys/$KID.pub" -o anchor.pub
# anchor.pub is a 64-char hex string (32-byte Ed25519 raw public key)

# 4. Convert the raw hex public key to DER (SubjectPublicKeyInfo, RFC 8410)
printf '%s' "$(cat anchor.pub)" \
  | xxd -r -p \
  | (printf '\x30\x2a\x30\x05\x06\x03\x2b\x65\x70\x03\x21\x00'; cat) \
  > anchor.der
openssl pkey -inform DER -pubin -in anchor.der -out anchor.pem

# 5. Reassemble signing input (header.payload) and extract signature
HEADER_PAYLOAD="$(cut -d. -f1,2 manifest.jws)"
SIG_B64=$(cut -d. -f3 manifest.jws \
  | awk '{ pad=length($0)%4; if(pad) for(i=pad;i<4;i++) printf "="; print }' \
  | tr '_-' '/+')
printf '%s' "$SIG_B64" | base64 -d > sig.bin

# 6. Verify with openssl (or use: passwd-sso audit-verify --manifest manifest.jws)
printf '%s' "$HEADER_PAYLOAD" \
  | openssl pkeyutl -verify -pubin -inkey anchor.pem -sigfile sig.bin \
      -pkeyopt digest:  # Ed25519 uses no pre-hash; leave blank
# Expected: "Signature Verified Successfully"
```

For most use cases, the `passwd-sso audit-verify` CLI (below) is simpler and handles
base64url padding, key fetching, and chain regression checks automatically.

---

## Full verification via CLI

Install the CLI: `npm install -g passwd-sso-cli` (or download the binary from the release page).

```bash
passwd-sso audit-verify \
  --manifest <path-or-url-to-manifest.jws> \
  --my-tenant-id <your-lower-case-uuid> \
  --tag-secret-file <path-to-kit/tag-secret.hex>
```

The CLI fetches the public key from `AUDIT_ANCHOR_PUBLIC_KEY_ARCHIVE_URL` (set in your
environment or provided via `--archive-url`). Optionally compare against a prior manifest
to detect chain-sequence regression:

```bash
passwd-sso audit-verify \
  --manifest today.jws \
  --prior-manifest yesterday.jws \
  --my-tenant-id <uuid> \
  --tag-secret-file kit/tag-secret.hex
```

### Exit codes

| Code | Name | Meaning |
|---|---|---|
| 0 | PASS | Signature valid; tenant present in manifest (if `--my-tenant-id` supplied); no regression (if `--prior-manifest` supplied). |
| 10 | InvalidAlgorithmError | JWS `alg` is not `EdDSA`; possible forgery attempt or wrong file format. |
| 11 | InvalidTypError | JWS `typ` does not match `passwd-sso.audit-anchor.v1`; wrong artifact type. |
| 12 | InvalidSignatureError | Signature verification failed; manifest may have been tampered with after signing. |
| 13 | ManifestSchemaValidationError | Manifest JSON does not match expected schema. |
| 14 | InvalidTenantIdFormatError | `--my-tenant-id` is not canonical lower-case UUID (RFC 4122 §3). No automatic case conversion is performed. |
| 15 | TenantNotInManifestError | Your tenant's derived tag is not present in the manifest. The tenant may not have had `audit_chain_enabled` at snapshot time. |
| 16 | ChainBreakError | The current manifest's `previousManifest.sha256` does not match the sha256 of the supplied `--prior-manifest`. Manifests are not from the same chain or one has been replaced. |
| 17 | ChainSeqRegressionError | A tenant's `chainSeq` decreased between prior and current manifest within the same epoch. This is a tamper signal. |
| 1 | Unexpected error | All other errors (I/O, parse failure, etc.). See stderr for details. |

**Note on exit code 14**: the CLI does NOT silently lowercase a provided UUID. If you copy
a tenant ID with uppercase letters, the command exits 14. Use canonical lower-case.

---

## Tag secret distribution

The tag secret is a 32-byte random HMAC-SHA256 key shared with tenant administrators at your
deployment. It is used to derive a `tenantTag` from your tenant ID so the public manifest does
not expose raw tenant identifiers to third parties.

To obtain the secret:

1. Sign in to the dashboard as a tenant administrator.
2. Navigate to Settings → Security → Download Audit-Anchor Verification Kit.
3. Complete a fresh MFA challenge.
4. Download the kit (zip). The kit contains:
   - `tag-secret.hex` — your deployment's tag secret (mode 0600; never share publicly).
   - `public-key-url.txt` — the public key archive URL for this deployment.
   - `verify.sh` — a shell script wrapping the openssl recipe above.

Store `tag-secret.hex` with the same care as other authentication credentials. If you believe
the secret is compromised, contact your operator immediately. Rotation requires a 30-day overlap
during which manifests publish both old and new tags.

---

## What is NOT covered

- **Unchained system events**: chain advancement covers only events with `chain_seq IS NOT NULL`.
  System-internal events (dead-letter reprocessing, chain-reaper, retention-purge, and
  `AUDIT_ANCHOR_PUBLISH_FAILED` operator alerts) appear in `audit_logs` as unchained rows
  and are not included in any published manifest. These events must be audited separately
  via the tenant or operator audit log views.

- **Events after the manifest snapshot**: your downloaded manifest authoritatively covers events
  up through `chain_seq = N` (the `chainSeq` value in your tenant's entry). Events after `N`
  are pending and not yet committed to any published anchor. See "Pause-window protection
  boundary" below.

---

## v1 trust-zone caveat

v1 protection is software-only. An operator who holds BOTH database write access AND the
application-server environment (which contains the signing key) can forge manifests. The
signature proves the manifest was issued by a party with access to the signing key; in v1
that key lives in the same trust zone as the application.

v2 (KMS-managed signing) closes this boundary by storing the signing key in a hardware-backed
KMS where signature operations are audited and the private key is non-exportable. KMS migration
is on the roadmap with a target delivery within 6 months, before the first SOC 2 audit, or upon
first contract obligation, whichever is earliest.

---

## Pause-window protection boundary

The audit anchor publisher runs daily. Events committed to `audit_logs` with
`chain_seq ≤ last_published_chain_seq` are protected by the most-recent published manifest.
Events with `chain_seq > last_published_chain_seq` (including rows pending in `audit_outbox`
during a publisher pause) are NOT yet covered by any manifest.

The publisher is fail-closed: if the signing key is unavailable, it blocks chain advancement
for affected tenants and pauses for up to 3× the cadence (72 hours). After that window, on-call
is paged. During a pause, new events continue to be recorded in `audit_logs` but their
chain-seq values are not yet committed to any manifest, widening the unprotected window.

If you require assurance of recently-created events, check `anchoredAt` in the manifest to
confirm the snapshot covers your time window.

---

## Threat-model boundary for the tag secret

The tag secret prevents anonymous third-party enumeration of tenant identities from the
public manifest. It is NOT designed to protect against:

- **Dashboard session hijack**: an attacker who can authenticate to the dashboard as a tenant
  administrator can download the verification kit. Session management controls govern this
  threat, not the tag secret. Enable MFA and enforce session expiry per your security policy.
- **Insider collusion**: any party holding both the deployment's tag secret and a tenant's UUID
  can derive that tenant's tag. Distribution is therefore restricted to authenticated tenant
  administrators of the same deployment.

Insider abuse via stolen admin sessions is governed by session-management controls (session
rotation, MFA, audit log review), not by the tag secret mechanism.

---

## References

- Plan ADR: `docs/archive/review/audit-anchor-external-commitment-plan.md`
- Rotation runbook: `docs/operations/audit-anchor-rotation-runbook.md`
- CLI source: `cli/src/commands/audit-verify.ts`
- Manifest library: `src/lib/audit/anchor-manifest.ts`
