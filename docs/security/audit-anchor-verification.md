# Audit Anchor Verification

## Overview

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
| Public key URL | Your operator provides `<ARCHIVE_URL>/public-keys/<kid>.pub`. The `kid` appears in the JWS header and in the manifest's file name. |
| Manifest file | Published daily at `<ARCHIVE_URL>/<date>.kid-<kid>.jws`; `<date>` is the UTC date of the manifest's `anchoredAt`. Where the operator mirrors to GitHub Releases, see "GitHub-only verifiers" below. |
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
  | awk '{ pad=length($0)%4; if(pad) for(i=pad;i<4;i++) $0=$0"="; print }' \
  | tr '_-' '/+' \
  | base64 -d \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['kid'])")
echo "kid: $KID"

# 3. Fetch the matching public key
curl -fsSL "$ARCHIVE_URL/public-keys/$KID.pub" -o anchor.pub
# anchor.pub is a 64-char hex string (32-byte Ed25519 raw public key)

# 3a. The kid must name this key: "audit-anchor-" + its first 8 bytes in hex
[ "audit-anchor-$(head -c 16 anchor.pub)" = "$KID" ] || echo "kid does not name this key — stop"

# 4. Convert the raw hex public key to DER (SubjectPublicKeyInfo, RFC 8410)
printf '%s' "$(cat anchor.pub)" \
  | xxd -r -p \
  | (printf '\x30\x2a\x30\x05\x06\x03\x2b\x65\x70\x03\x21\x00'; cat) \
  > anchor.der
openssl pkey -inform DER -pubin -in anchor.der -out anchor.pem

# 5. Reassemble signing input (header.payload) and extract signature
HEADER_PAYLOAD="$(cut -d. -f1,2 manifest.jws)"
SIG_B64=$(cut -d. -f3 manifest.jws \
  | awk '{ pad=length($0)%4; if(pad) for(i=pad;i<4;i++) $0=$0"="; print }' \
  | tr '_-' '/+')
printf '%s' "$SIG_B64" | base64 -d > sig.bin

# 6. Verify with openssl (or use: passwd-sso audit-verify --manifest manifest.jws).
#    Ed25519 signs the message itself, not a digest: -rawin, with the input as a file
#    (openssl needs its size for this one-shot operation).
printf '%s' "$HEADER_PAYLOAD" > signing-input.bin
openssl pkeyutl -verify -pubin -inkey anchor.pem -rawin -in signing-input.bin -sigfile sig.bin
# Expected: "Signature Verified Successfully"
```

Base64url padding is appended (`$0=$0"="`), never prepended: a leading `=` makes `base64 -d`
refuse the input.

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
environment or provided via `--archive-url`) as `<archive-url>/<kid>.pub`, or reads it from
the file given with `--public-key <path>`.

The tenant check and the prior-manifest check are separate runs: with `--my-tenant-id` the
command reports your tenant's entry and stops, without looking at `--prior-manifest`. To
check the chain link and chain-sequence regression against a prior manifest (a local file):

```bash
passwd-sso audit-verify \
  --manifest today.jws \
  --prior-manifest yesterday.jws
```

### What the CLI enforces

- **`kid` binding.** A signature is accepted only under the key the JWS header's `kid`
  names. The `kid` is `audit-anchor-` followed by the first 8 bytes of the raw public key in
  hex, so the CLI derives it from the key it was given — file or archive — and compares
  before it checks the signature. A mismatch is exit 19 (`KidMismatchError`), whatever the
  signature. See "What the `kid` does and does not prove" below.
- **Strict public keys.** A public key, from a file or from the archive, is exactly 64
  lower-case hex characters once surrounding whitespace is trimmed. Anything else — 63 or 65
  characters, upper case, a stray character — is refused (`InvalidPublicKeyError`, exit 1)
  rather than read as far as it parses.
- **`https` only.** A manifest URL and the archive URL must be `https://`. `http://` is
  accepted only when the host is exactly `localhost`, `127.0.0.1` or `[::1]`; any other
  URL is refused before anything is fetched (`InsecureUrlError`, exit 1). Redirects are not
  followed: an answer other than 200 is an error.
- **The prior manifest's key**, in this order: the prior manifest has the same `kid` as the
  current one → the current key; else `--prior-public-key <path>`; else the archive, but
  only when the current key also came from the archive (a key you handed over with
  `--public-key` says nothing about what the archive serves); else the command stops and
  names `--prior-public-key` (`PriorPublicKeyRequiredError`, exit 1). Across a key rotation:

  ```bash
  passwd-sso audit-verify \
    --manifest first-under-new-key.jws --public-key new.pub \
    --prior-manifest last-under-old-key.jws --prior-public-key old.pub
  ```

### GitHub-only verifiers

A deployment that publishes to GitHub Releases stores each manifest as an asset of the
release tagged `audit-anchor-<date>`, the public keys as assets `<kid>.pub` of the release
`audit-anchor-public-keys`, and statements in the release `audit-anchor-key-rotation`.
GitHub answers an asset download with a redirect, which the CLI refuses, so the archive URL
cannot point at a release. Download the files and pass them:

```bash
gh release download "audit-anchor-<date>" --repo <owner>/<repo> --pattern '*.jws'
gh release download audit-anchor-public-keys --repo <owner>/<repo> --pattern '<kid>.pub'
# or: curl -fsSL -o '<kid>.pub' \
#   "https://github.com/<owner>/<repo>/releases/download/audit-anchor-public-keys/<kid>.pub"

passwd-sso audit-verify --manifest '<date>.kid-<kid>.jws' --public-key '<kid>.pub'
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
| 17 | ChainSeqRegressionError | A tenant's `chainSeq` decreased between prior and current manifest within the same epoch. This is a tamper signal. A tenant whose `epoch` differs between the two is not compared: the CLI prints `WARN: epoch changed for tenantTag=…` on stderr and the exit status is unchanged. Nothing in the product changes a tenant's epoch, so ask the operator about that warning (their side records it as `EPOCH_CHANGED`). |
| 18 | InvalidTagSecretLengthError | The tag secret is not 32 bytes (64 hex chars). |
| 19 | KidMismatchError | The JWS header's `kid` does not name the public key the signature was checked under: the wrong key file, a misfiled archive entry, or a manifest relabelled with another `kid`. The signature is not evaluated. |
| 1 | Unexpected error | All other errors: I/O, a fetch that did not answer 200 (a redirect is not followed), took longer than 30 seconds or returned more than 8 MiB, a `kid` of the wrong shape, a public key that is not 64 lower-case hex characters, a URL that is not `https`, a prior manifest under another key with no `--prior-public-key`. See stderr for details. |

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
the secret is compromised, contact your operator immediately. Rotation is a cutover: from the
first manifest after it, every `tenantTag` is derived from the new secret, and you need a new
kit to find your tenant. There is no period in which a manifest carries both tags; keep the
old kit to check manifests published before the rotation.

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

The audit anchor publisher runs once a day, at the cadence boundary (00:05 UTC), and the
manifest's `anchoredAt` is that boundary. Events committed to `audit_logs` with
`chain_seq ≤` your tenant's `chainSeq` in the most recent published manifest are protected
by it. Later events are NOT yet covered by any manifest.

When an upload fails, the publisher pauses chain advancement for the manifest's tenants
until the **next cadence boundary** at most — no longer the 72 hours (3× cadence) this
section used to state. During the pause new events wait in `audit_outbox` and are chained
into `audit_logs` once it ends, so a pause never lets the chain run ahead of a manifest. The
pause no longer holds publishing: the publisher retries the same boundary every 15 minutes,
at most three times per process and not later than 30 minutes before the next boundary (at
most three attempts per boundary reach the upload, across restarts), and a
successful publish clears the pause. When every attempt fails, the pause still ends at the
next boundary, the chain advances, and those events are covered only by the next manifest
that publishes.

A publisher that cannot start — a missing signing key stops it at boot — writes no pause at
all: the chain keeps advancing and nothing is anchored until it is restored. Either way the
gap is visible to you: consecutive manifests whose `anchoredAt` values are more than one day
apart, and to the operator as `MISSING_PRIOR_CADENCE_PUBLICATION` on the next publish.

If you require assurance of recently-created events, check `anchoredAt` in the manifest to
confirm the snapshot covers your time window.

---

## What the `kid` does and does not prove

The `kid` in a manifest's header and file name is a 64-bit identifier of the signing key —
the first 8 bytes of the public key — not a commitment to it. Binding it (CLI exit 19, step
3a of the openssl recipe) stops a manifest from being checked under the wrong key: a stale
key file, a key archived under another key's name, a manifest relabelled to point at a key
that happens to verify something else.

It adds nothing against a party who serves you **both** the manifest and the key. Such a
party serves a matching pair, and 64 bits is the length of an identifier, not of a hash
commitment. What makes a key the operator's is how you obtained it: pin the public key
(all 64 hex characters, not the `kid`) through a channel independent of the archive the
first time, and from then on accept a new key only across a rotation you can follow (below).

---

## Key rotation

A rotation is a cutover: the last manifest under the old key is followed by the first under
the new key, whose `previousManifest` names that last one. Nothing is signed
under both. To follow it:

1. Verify the first new-key manifest against the last old-key one with `--prior-manifest`
   and `--prior-public-key` (above). Exit 0 says the new chain continues the old one —
   **unless the command printed a `WARN` on stderr**. Exit 0 does not prove continuity
   when the current manifest names no previous one: the CLI then prints
   `WARN: current manifest claims genesis (no previousManifest) but --prior-manifest was
   supplied; chain link cannot be verified` and still passes, because both signatures
   verify and there is no link to check. It means the new-key manifest starts a chain of
   its own: either a chain restart, which the operator publishes a `chain-restart`
   statement for (below), or a manifest that does not continue the one you hold. Treat
   a rotation whose first new-key manifest gives this warning as not continuous until a
   restart statement accounts for it.
2. Read the operator's rotation statement (below), which the **old** key signed and which
   names the new public key in full.

**A manifest under a `kid` dated after the rotation away from it is untrusted.** Once a
manifest under the new `kid` exists, the old key is retired: the publisher refuses to run
under it, and no legitimate manifest is signed with it again. A manifest under the old `kid`
whose date is later than the first new-key manifest was made by someone holding a retired
key. Report it; never prefer it, even though its signature verifies.

### Verifying a statement

Operators publish two kinds of signed statement next to the manifests, as
`<ARCHIVE_URL>/key-rotation-<YYYYMMDD>.<op>.kid-<signer-kid>.jws`:

- `rotation` — signed by the old key:
  `{"issuedAt": …, "newKid": …, "newPublicKey": "<64 hex>", "oldKid": …, "op": "rotation"}`;
- `chain-restart` — signed by the key the new chain starts under:
  `{"issuedAt": …, "op": "chain-restart", "previousChain": {"sha256": …, "uri": …} | null}`.
  `previousChain` names the last manifest of the chain that was abandoned (its payload
  SHA-256, computed as under "Object versions"), or is `null` when none of it survives.

A statement is a JWS like a manifest, with the header `typ`
`passwd-sso.audit-anchor-statement.v1`. `passwd-sso audit-verify` does not verify
statements (it exits 11 on that `typ`); use the openssl recipe under "Quick check via
openssl" with the statement in place of `manifest.jws`, and check the `typ` where the recipe
reads the `kid`:

```bash
curl -fsSL "$ARCHIVE_URL/key-rotation-<YYYYMMDD>.rotation.kid-<old-kid>.jws" -o manifest.jws

# Step 2 of the recipe, also asserting the statement typ
KID=$(cut -d. -f1 manifest.jws \
  | awk '{ pad=length($0)%4; if(pad) for(i=pad;i<4;i++) $0=$0"="; print }' \
  | tr '_-' '/+' \
  | base64 -d \
  | python3 -c "import sys,json; h=json.load(sys.stdin); assert h['typ']=='passwd-sso.audit-anchor-statement.v1', h['typ']; print(h['kid'])")

# Steps 3 to 6 unchanged, with the OLD key you already trust as anchor.pub. Then the payload:
cut -d. -f2 manifest.jws \
  | awk '{ pad=length($0)%4; if(pad) for(i=pad;i<4;i++) $0=$0"="; print }' \
  | tr '_-' '/+' \
  | base64 -d
```

Use the old public key you already hold, not one fetched for the occasion: the statement is
only as good as your trust in the key that signed it. `newPublicKey` in the payload is then
the key to pin for the manifests that follow.

**What a rotation statement shows.** Continuity, and only when the old key was not
compromised. It is signed by the old key, so whoever holds that key can issue one naming a
key of their choosing. After a rotation made because the old key leaked, the statement
proves nothing; take the new key from the operator through a channel that does not rest on
the old one.

---

## Object versions

**One version per key.** The publisher writes a manifest only when no object holds its key,
and a retry — after a failed database commit, a crash, a restart — finds the stored object
and adopts it instead of writing again. A manifest key therefore has exactly one version,
and so do the archived public keys and the statements.

More than one version of a key is a write outside the protocol. On the anchors bucket it is
detectable by an operator running `list-object-versions`; nothing runs it automatically, and
a plain download returns only the latest version:

```bash
# Operator: every version and delete marker under the prefix
aws s3api list-object-versions --bucket <bucket> --prefix "<prefix>/" --region <region> \
  --query '{Versions: Versions[].[Key, VersionId, LastModified, IsLatest], DeleteMarkers: DeleteMarkers[].[Key, VersionId, LastModified]}'
aws s3api get-object --bucket <bucket> --key "<prefix>/<date>.kid-<kid>.jws" \
  --version-id <version-id> --region <region> manifest.jws
```

A manifest's `previousManifest.sha256` is the SHA-256 of the previous manifest's canonical
JSON — the JWS payload, base64url-decoded — not of the object's bytes or its ETag; this is
what `passwd-sso audit-verify --prior-manifest` compares. By hand:

```bash
cut -d. -f2 manifest.jws \
  | tr '_-' '/+' \
  | awk '{ pad=length($0)%4; if(pad) for(i=pad;i<4;i++) $0=$0"="; print }' \
  | base64 -d | sha256sum
```

Its `previousManifest.uri` is `<destination>://<date>.kid-<kid>.jws` — `s3-object-lock://…`
for the anchors bucket, `github-release://…`, `filesystem://…` — the key without any prefix.

The rules, per key:

- **The authoritative version** of a key is the one whose SHA-256 the next published
  manifest's `previousManifest.sha256` names. For the newest key, which no manifest names
  yet, it is the only version.
- **A second version** is a tamper signal, whichever one the chain names. Report it. The one
  exception is a key written before the deployment was upgraded to this protocol: the
  earlier publisher re-sent the same key when a commit was lost, so such a key may carry
  several versions created before its next boundary (its date + 1 day, 00:05 UTC). Ask your
  operator for the upgrade date; for those keys the authoritative-version rule above
  decides, and a version created after the key's next boundary is still a tamper signal.
- **Every key is named by the next manifest.** The publisher chains to the latest manifest
  the destination holds, whether or not its own database recorded that publish. A manifest
  key no later manifest names is expected in two cases only: two keys on one date (the
  operator has an `AUDIT_ANCHOR_PUBLISH_FAILED` row with `MULTIPLE_MANIFESTS_FOR_DATE` for
  it), and the last key of a chain that was restarted, which the chain-restart statement
  names. A key written before the upgrade may also be unreferenced when the publish after it
  reported `MISSING_PRIOR_CADENCE_PUBLICATION`.
- **Consecutive manifests more than one day apart** mean a boundary was never published.
- **A delete marker on an anchor key** is a tamper signal. The bucket policy refuses deletes to
  everyone, so one means the policy was replaced.

**Residual.** The one-version rule is kept by the publisher, not by the bucket: the policy
lets the publisher's task role PUT a manifest key without the create-only condition, so
anyone holding that role's credentials can add a version. Without the signing key that
version does not verify — a verifier who downloads it gets a failure, and when it is the
newest key the publisher itself stops, since it reads that key before every publish — but
the versions stay, and only the listing above shows them. Enforcing the condition in the bucket policy is tracked
as a follow-up (SC1 of `docs/archive/review/audit-anchor-hardening-plan.md`). On GitHub
Releases and on a filesystem there are no versions to list: a writer there can replace or
remove an object, and the chain of `previousManifest` hashes is what shows it.

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
