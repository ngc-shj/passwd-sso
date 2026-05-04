# Personal Vault Attachment Rotation — Phase B Plan

Tracks Issue [#437](https://github.com/ngc-shj/passwd-sso/issues/437). Phase A (PR
[#438](https://github.com/ngc-shj/passwd-sso/pull/438)) closed the rotation gaps
for Recovery Key, Emergency Access escrow, and WebAuthn PRF wrapping but
deferred personal-entry attachments behind the
`acknowledgeAttachmentDataLoss` interim safeguard. This plan triangulates the
three options posed in #437, selects one, and locks the contracts that the
implementation PR will be measured against.

## Project context

- **Type**: web app (Next.js 16 App Router + Prisma 7 + PostgreSQL 16)
- **Test infrastructure**: unit + integration + E2E + CI/CD (vitest, Playwright,
  GitHub Actions, dedicated `db-integration` suite, see
  `src/__tests__/db-integration/`)
- Affected stack surfaces: Prisma schema, server routes
  (`/api/vault/rotate-key`, `/api/passwords/[id]/attachments/*`), client crypto
  (`src/lib/crypto/`), client rotation flow, Phase A E2E
  (`e2e/tests/settings-key-rotation.spec.ts`), whitepaper docs.

## Objective

Replace Phase A's destructive `acknowledgeAttachmentDataLoss` gate with a
non-destructive rotation path for personal-entry attachments, so that vault
key rotation never threatens user attachment data. After Phase B lands:

1. Rotating the personal vault key never destroys attachment data.
2. Rotation cost remains O(entries + attachments) **wrap operations**, not
   O(attachment bytes) re-uploads.
3. The acknowledgement flag and its API error are removed from the public API
   surface.
4. Whitepaper §6.1.d documents the new model.

## Requirements

### Functional

| # | Requirement |
|---|-------------|
| FR-1 | Personal attachment file bodies are encrypted with a per-attachment Content Encryption Key (CEK). The CEK is wrapped by the user's vault encryption key (`secretKey`). |
| FR-2 | Vault rotation re-wraps each personal attachment's CEK transactionally with the entry/history re-encryption — file bodies are not re-uploaded. |
| FR-3 | Existing mode-0 (legacy direct-vault-key) attachments migrate to mode-2 (CEK indirection) automatically as part of the client-side rotation flow, before the rotation transaction is committed. Each per-attachment migration is its own server commit; the rotation commit only re-wraps CEKs. |
| FR-4 | `acknowledgeAttachmentDataLoss` is removed from the rotation API. The new rotation API succeeds for any user whose attachments are all mode-2. |
| FR-5 | New attachment uploads default to mode-2. The legacy mode-0 upload path is retired (server rejects mode-0 uploads after Phase B lands). |
| FR-6 | Whitepaper §6.1.d is rewritten to describe the CEK indirection model. |

### Non-functional

| # | Requirement |
|---|-------------|
| NFR-1 | Rotation latency for a vault containing N entries + M attachments is dominated by the round-trip of the rotate-key POST, not by N or M. Server transaction time stays under the existing 120s timeout under realistic loads. |
| NFR-2 | The CEK wrap AAD is stable enough to permit independent ciphertext-transplant attacks: it MUST bind `entryId`, `attachmentId`, AND `cekWrapAadVersion` so that future format upgrades can be enforced. |
| NFR-3 | Backward compatibility: mode-0 attachments uploaded under Phase A remain readable until they migrate. Reads of mode-0 attachments use the existing decryption path. |
| NFR-4 | Cross-tenant / cross-user isolation properties are unchanged from Phase A. |
| NFR-5 | Audit-log fields enumerate per-rotation: `cekRewrapsAttempted`, `cekRewrapsSucceeded`, `legacyAttachmentsMigrated`, plus the existing `entriesRotated` / `historyEntriesRotated` set. |

### Out of scope (Phase B+)

- ECDH cross-domain rotation (whitepaper §6.1.e) — separate issue.
- Per-entry ItemKey indirection for personal entries (deeper refactor that
  would mirror Team's TeamPasswordEntry model exactly). Phase B keeps
  per-entry encryption flow unchanged; only attachments get a CEK layer.
- Lazy migration of mode-0 attachments on download (download-triggered
  rewrite). Auto-migration during rotation covers the data-loss removal
  goal; lazy on-download is optional polish that we defer.

## Technical approach

### Option triangulation

| Aspect | Option 1 (per-attachment CEK) | Option 2 (eager re-encrypt) | Option 3 (background migration) |
|--------|-------------------------------|------------------------------|----------------------------------|
| Rotation cost | O(attachments) wraps | O(attachment bytes) | O(entries) initially, attachment cost amortized |
| Schema change | Yes (additive) | None | Possibly (state tracking) |
| Mid-rotation failure recovery | Atomic — single tx | Half-applied state needs recovery design | Background job state can desync |
| Security goal — key rotation actually retires old `secretKey` | Yes | Yes | **No** (background job needs old `secretKey`) |
| Future rotations after first migration | Cheap (CEK rewrap) | Always expensive | Cheap |
| Mirrors team model | Closely (CEK at attachment, mirrors Team `ItemKey` at entry) | No | No |

**Selected: Option 1 + lightweight migration via the rotation client flow.**

Rationale:
- Option 3 is ruled out by NFR-1 + AC-3: it requires the old `secretKey` to
  remain available to a background worker, defeating the rotation security
  goal.
- Option 2 alone has unbounded rotation cost (NFR-1 violation) and a
  half-applied recovery design that we would have to invent. Option 1 makes
  Option 2's cost a one-time migration tail rather than a permanent feature.
- Option 1 follows the architectural shape that already exists for team
  attachments (`Attachment.encryptionMode = 1` for team / `TeamPasswordEntry`
  carries the wrapped ItemKey). Reusing this pattern keeps the mental model
  consistent.

The migration tail for existing mode-0 attachments is handled inside the
**client rotation flow**, not as a server background job. This keeps the
property "no process holds the old `secretKey` after rotation" while
eliminating the data-loss risk: the user already has their old passphrase at
the moment they initiate rotation, so the client can decrypt mode-0
attachments and re-upload them as mode-2 before submitting the rotation POST.

### Schema design

```text
model Attachment {
  // ... existing fields ...
  encryptionMode      Int      @default(0)  @map("encryption_mode")
  // 0 = legacy direct vault key wrap (Phase A)
  // 1 = team ItemKey-wrapped (existing, unchanged)
  // 2 = personal CEK indirection (Phase B target)

  // Existing fields keep their semantics under mode 2:
  //   encryptedData / iv / authTag    — file body encrypted under CEK,
  //                                     stable across rotations
  //   keyVersion                      — DEPRECATED for mode 2 (the
  //                                     authoritative wrap version is
  //                                     `cekKeyVersion`). Kept on the
  //                                     row for mode-0/1 readback.
  //   aadVersion                      — data-AAD format version
  //                                     (always 1 today). Stable.

  // NEW for mode 2:
  cekEncrypted        Bytes?   @map("cek_encrypted")
  cekIv               String?  @db.VarChar(24) @map("cek_iv")
  cekAuthTag          String?  @db.VarChar(32) @map("cek_auth_tag")
  cekKeyVersion       Int?     @map("cek_key_version")       // vault keyVersion at last wrap
  cekWrapAadVersion   Int?     @default(1) @map("cek_wrap_aad_version")
}
```

All new columns are nullable so the migration is purely additive (R24
compliance: split additive vs. strict constraint). A follow-up migration in a
later release MAY flip them to `NOT NULL` after a back-window during which
all rows have `encryptionMode = 2`.

### AAD design

Two distinct AAD scopes, one stable and one rotation-aware:

| AAD | Builder | Inputs | Stable across rotation? |
|-----|---------|--------|--------------------------|
| Data AAD (`"AT"`) | `buildAttachmentAAD` (existing) | `entryId`, `attachmentId` | **Yes** (file body never re-encrypted) |
| CEK wrap AAD (`"AW"`) | `buildAttachmentCekWrapAAD` (NEW) | `entryId`, `attachmentId`, `cekKeyVersion` (string), `cekWrapAadVersion` (string) | **No** — `cekKeyVersion` rotates each rewrap |

Including `cekKeyVersion` in the wrap AAD prevents replay of an older wrap
ciphertext after rotation: an attacker who recovers an old wrap blob cannot
present it to the new key because the AAD will not match. Including
`cekWrapAadVersion` reserves room to evolve the wrap-AAD format in a future
phase without rewriting all existing wraps.

### Rotation flow (revised)

```
client                            server
  │ GET /api/vault/rotate-key/data
  │ ─────────────────────────────►
  │              ◄─────────────── { entries, history,
  │                                 mode2Attachments: [{ id, entryId,
  │                                   cekEncrypted, cekIv, cekAuthTag,
  │                                   cekKeyVersion, cekWrapAadVersion }],
  │                                 mode0Attachments: [{ id, entryId }, ...] }
  │
  │ ── For each mode-0 attachment ─────────────────────────┐
  │    GET  /api/passwords/[entryId]/attachments/[id]      │
  │    decrypt with OLD secretKey                          │ legacy migration
  │    generate fresh CEK; encrypt body under CEK          │ (one-time per
  │    wrap CEK with OLD secretKey + new wrap AAD          │  legacy attachment;
  │    PUT  /api/passwords/[entryId]/attachments/[id]/migrate │ separate commit
  │           { newEncryptedData (b64), newIv, newAuthTag, │  per attachment)
  │             cekEncrypted, cekIv, cekAuthTag,           │
  │             cekKeyVersion=oldVersion, cekWrapAadVersion=1 } │
  │ ────────────────────────────────────────────────────────┘
  │
  │ ── Rewrap all mode-2 CEKs with NEW secretKey (in-memory) ─
  │
  │ POST /api/vault/rotate-key
  │ ─────────────────────────────► { /* DELTA vs Phase A schema at
  │                                     src/app/api/vault/rotate-key/route.ts:36-70
  │                                     DROPS:    acknowledgeAttachmentDataLoss
  │                                     ADDS:     attachmentCekRewraps[],
  │                                               legacyAttachmentsMigratedThisCycle
  │                                     UNCHANGED: currentAuthHash,
  │                                                encryptedSecretKey,
  │                                                secretKeyIv,
  │                                                secretKeyAuthTag,
  │                                                accountSalt,
  │                                                newAuthHash,
  │                                                newVerifierHash,
  │                                                verificationArtifact,
  │                                                entries[],
  │                                                historyEntries[],
  │                                                encryptedEcdhPrivateKey,
  │                                                ecdhPrivateKeyIv,
  │                                                ecdhPrivateKeyAuthTag */ }
  │              ◄─────────────── { success, keyVersion, rotationEffects }
```

The `UNCHANGED` block is explicit because dropping ECDH private key rewrap
fields would break emergency-access ECDH decrypt after rotation — the
sketch must not be read as a wholesale request rewrite (F14).

Atomicity:
- Each legacy migration is its own DB transaction. If the user closes the
  browser mid-flow, attachments end in either mode-0 (untouched) or mode-2
  (already migrated under the OLD vault key wrap — perfectly readable). No
  half-state is possible per attachment.
- The rotation transaction (POST `/api/vault/rotate-key`) is unchanged in
  shape: advisory lock → entry/history re-encryption → user vault wrap
  update → CEK rewrap → audit. If the rotation fails, every attachment is
  still in a valid mode-2 state under the **old** vault key, which the user
  can still decrypt.

### Why not roll attachment uploads into the rotation transaction?

We considered streaming new ciphertexts inside the rotation POST so that the
mode-0 → mode-2 transition is atomic with rotation. Rejected because:

- The rotation POST is currently a small JSON payload protected by the
  120s transaction timeout. Adding multi-MB attachment bodies blows past
  that and forces multipart streaming.
- Splitting the migration into per-attachment server commits is strictly
  better for resume semantics: a partially-migrated user who hits the next
  rotation just pays for the remaining mode-0 entries.

### Server route changes

| Route | Change |
|-------|--------|
| `POST /api/passwords/[id]/attachments` | Accept `cekEncrypted`, `cekIv`, `cekAuthTag`, `cekKeyVersion`, `cekWrapAadVersion`; reject if absent (mode-2 required for new uploads). Store with `encryptionMode = 2`. |
| `GET /api/passwords/[id]/attachments/[attachmentId]` | Return new CEK fields alongside existing data fields. |
| `PUT /api/passwords/[id]/attachments/[attachmentId]/migrate` (NEW) | Accept replacement `encryptedData`/`iv`/`authTag` plus CEK fields; only succeeds when source row is `encryptionMode = 0`; updates row to `encryptionMode = 2` in a single transaction; emits audit log; sequenced behind the same per-user advisory lock used by rotation to prevent racing rotation against migration. |
| `GET /api/vault/rotate-key/data` | Add `mode2Attachments` (CEK manifest) + `mode0Attachments` (each `{ id, entryId }`) to response. Drop `attachmentsAffected` (replaced by the two new lists). D1: original spec said `mode0AttachmentIds: string[]` — corrected so the client can build the migrate URL + data AAD. |
| `POST /api/vault/rotate-key` | Drop `acknowledgeAttachmentDataLoss` field (request schema). Add `attachmentCekRewraps` array. Reject the rotation if any mode-0 attachments still exist (defensive guard — `LEGACY_ATTACHMENTS_RESIDUAL` error; should never fire if client flow is followed). |
| `/api/v1/*` (REST API v1, Bearer-key public surface) | Audit `src/lib/openapi-spec.ts` for attachment exposure: the OpenAPI spec at `/api/v1/openapi.json` is the public contract. (a) If v1 currently exposes attachment metadata or download, extend the response schema with the new fields (`encryptionMode`, `cekEncrypted`, `cekIv`, `cekAuthTag`, `cekKeyVersion`, `cekWrapAadVersion`) and bump the `info.version` of the spec. (b) If v1 does NOT currently expose attachments, add an explicit out-of-scope note in the plan recording that `grep -rn attachment src/app/api/v1` returned 0 attachment-touching routes. F10. |

The migration endpoint, the rotation data fetch, and the rotation POST all
acquire `pg_advisory_xact_lock(hashtext(${userId}::text))` so a rogue
migration attempt cannot interleave with rotation. (See [route.ts:175](../../src/app/api/vault/rotate-key/route.ts#L175) for the lock pattern.)

### Audit log changes

Add to `metadata` of `AUDIT_ACTION.VAULT_KEY_ROTATION`:
- `legacyAttachmentsMigrated`: int — count of mode-0 → mode-2 transitions
  observed inside this rotation cycle (NOTE: the actual migrations happened
  via separate audit events; this is the rolled-up count for the rotation
  audit summary).
- `cekRewrapsAttempted`, `cekRewrapsSucceeded`, `cekRewrapsFailed`: int —
  per-attachment outcome counts.
- Drop `attachmentDataLossAcknowledged`, `affectedAttachmentIds`,
  `affectedAttachmentIdsOverflow` from the metadata schema in tandem with
  removing the acknowledgement gate.

Add new audit action:
- `AUDIT_ACTION.ATTACHMENT_LEGACY_MIGRATION` — emitted by
  `PUT .../migrate`. Group: `PERSONAL.ATTACHMENT`. Targets: the attachment
  row by id.

### Phase A artifact removal

When Phase B ships:
1. Delete `AttachmentAckRequiredError` and the 422 / `ATTACHMENT_DATA_LOSS_NOT_ACKNOWLEDGED`
   API-error code.
2. Delete the rotation-dialog data-loss banner UI (`src/components/vault/rotate-key-dialog.tsx`
   currently surfaces it) AND its i18n strings in `messages/en/Vault.json`,
   `messages/ja/Vault.json`. Replace with a "migrating N legacy attachments"
   progress UI.
3. Drop the `acknowledgeAttachmentDataLoss` Phase A E2E case in
   `e2e/tests/settings-key-rotation.spec.ts`; replace with a Phase B case
   that exercises the full mode-0 → mode-2 migration plus rotation.
4. Drop the `attachmentDataLossNotAcknowledged` `messages/{en,ja}/ApiErrors.json`
   entries.

## Contracts

Each contract carries a stable ID. IDs are not reused; renumbering invalidates
back-references in subsequent rounds.

### C0 — Shared constant relocation

- **Subject**: relocate `ATTACHMENT_MANIFEST_CAP` from
  `src/app/api/vault/rotate-key/route.ts:74` (where it is already defined as
  a named module-scope constant on Phase A `main`) to
  `src/lib/validations/common.ts`. Add `VAULT_ROTATE_ATTACHMENT_CEK_MAX` to
  the same file.
- **Signature**:
  ```ts
  // src/lib/validations/common.ts
  export const ATTACHMENT_MANIFEST_CAP = 1000;          // relocated from rotate-key/route.ts:74
  export const VAULT_ROTATE_ATTACHMENT_CEK_MAX = 5000;  // new in Phase B
  ```
  Then `rotate-key/route.ts`, `rotate-key/data/route.ts`, and the new
  integration tests import these names instead of redeclaring them.
- **Invariants**:
  - I0.1: `ATTACHMENT_MANIFEST_CAP` is referenced by import only in
    `rotate-key/route.ts`, `rotate-key/data/route.ts`, the new migrate
    route, and the new integration test. The literal `1000` (or the
    underscore-decorated form `1_000`) MUST NOT appear inline near
    attachment manifest code anywhere in `src/` after this PR.
  - I0.2: `VAULT_ROTATE_ATTACHMENT_CEK_MAX` is the canonical cap; both the
    request validator (Zod `.max()`) and the server-side post-validation
    enforcement reference the same constant.
- **Forbidden patterns**:
  - `pattern: const ATTACHMENT_MANIFEST_CAP\s*=` outside
    `validations/common.ts` — reason: SSoT for the cap.
  - `pattern: =\s*1[_]?000\b` in `src/app/api/vault/` or
    `src/app/api/passwords/.../attachments/` (excluding `validations/common.ts`)
    — reason: defends against alias-named redefinitions like `const FOO = 1000`.
- **Acceptance**:
  - `grep -rn "ATTACHMENT_MANIFEST_CAP" src/` shows the const-defining line
    + each import site, no inline `= 1000` redefinition.
  - CI grep `grep -rnE "=\s*1[_]?000\b" src/app/api/vault src/app/api/passwords | grep -vE "ATTACHMENT_MANIFEST_CAP|VAULT_ROTATE"` returns empty.

### C1 — Schema additions (Prisma)

- **Subject**: `prisma/schema.prisma` — `Attachment` model gains five nullable
  columns supporting mode-2 CEK indirection.
- **Signature**: see "Schema design" above. Five new fields, all nullable for
  the additive migration. Migration name follows the
  `YYYYMMDDhhmmss_add_attachment_cek_indirection` pattern.
- **Invariants**:
  - I1.1: When `encryptionMode = 2`, `cekEncrypted`, `cekIv`, `cekAuthTag`,
    `cekKeyVersion`, `cekWrapAadVersion` are all NON-NULL (enforced by
    application + a deferred CHECK constraint introduced in the next
    rotation-cycle migration after the back-window).
  - I1.2: When `encryptionMode = 0` or `1`, all five new columns are NULL.
  - I1.3: No existing column types or names change.
- **Forbidden patterns**:
  - `pattern: encryption_mode\s+Int\s+@default\((1|2)\)` — reason: default
    must remain 0 to keep migration purely additive.
  - `pattern: ALTER TABLE attachments .* DROP COLUMN` (in the new migration
    SQL) — reason: phase B is additive only; column drops would break
    rollback.
- **Acceptance**:
  - `npx prisma migrate dev` against a vault containing mode-0 + mode-1
    rows succeeds with all rows preserved and the five new columns NULL.
  - `npx tsc --noEmit` passes after Prisma client regen.

### C2 — `buildAttachmentCekWrapAAD` helper

- **Subject**: `src/lib/crypto/crypto-aad.ts` exports a new builder. The
  builder reuses the existing private `buildAADBytes(scope, expectedFieldCount,
  fields)` helper at [crypto-aad.ts:33–92](../../src/lib/crypto/crypto-aad.ts#L33);
  it does NOT introduce new validation logic. Field-count mismatch and
  per-field length-cap checks are inherited from `buildAADBytes`. The
  file-header comment block at [crypto-aad.ts:11–15](../../src/lib/crypto/crypto-aad.ts#L11)
  AND the scope-constants block at [lines 21–24](../../src/lib/crypto/crypto-aad.ts#L21)
  MUST be updated to list the new scope:
  ```
  "AW" — Attachment CEK Wrap (entryId, attachmentId, cekKeyVersion, cekWrapAadVersion)
  ```
  with `const SCOPE_ATTACHMENT_WRAP = "AW";` added next to the other scope
  constants.
- **Signature**:
  ```ts
  export function buildAttachmentCekWrapAAD(
    entryId: string,
    attachmentId: string,
    cekKeyVersion: number,
    cekWrapAadVersion: number,
  ): Uint8Array
  ```
  Internally calls `buildAADBytes("AW", 4, [entryId, attachmentId, String(cekKeyVersion), String(cekWrapAadVersion)])`.
- **Invariants**:
  - I2.1: AAD scope `"AW"` (Attachment Wrap) is reserved exclusively for
    this builder. No other code may emit scope `"AW"` AAD bytes.
  - I2.2: `cekKeyVersion` and `cekWrapAadVersion` are stringified before
    encoding (consistent with `buildTeamEntryAAD` and `buildItemKeyWrapAAD`
    precedent at [crypto-aad.ts:124, 141](../../src/lib/crypto/crypto-aad.ts#L124)).
  - I2.3: The existing `buildAttachmentAAD("AT", ...)` is unchanged in both
    signature and emitted bytes.
  - I2.4: All input validation (scope length, field count, per-field byte
    cap of 65535) is delegated to `buildAADBytes`. Do NOT duplicate these
    checks inside `buildAttachmentCekWrapAAD`.
  - I2.5: Export a sibling constant `MIN_ACCEPTED_CEK_WRAP_AAD_VERSION = 1`
    from `crypto-aad.ts`. Client unwrap helpers MUST gate the row's stored
    `cekWrapAadVersion` against this minimum (`>= MIN_ACCEPTED_…`) BEFORE
    invoking AES-GCM. Bump the constant at each future format upgrade
    after a back-window. Rationale: an active server-side attacker with
    DB write access could flip a v2 row's stored `cek_wrap_aad_version`
    field to 1, pushing a v2-strict client into v1-acceptance behavior;
    the version-floor check rejects this regardless of whether AES-GCM
    happens to verify (which it would not under normal circumstances, but
    the floor is a defense-in-depth gate even when v1 and v2 inputs
    coincidentally produce the same AAD bytes for an attacker-chosen
    field set).
- **Forbidden patterns**:
  - `pattern: SCOPE_ATTACHMENT_WRAP\s*=\s*"(?!AW")` — reason: the wrap scope
    constant must be exactly `"AW"`.
  - `pattern: buildAttachmentAAD\([^)]*cekKeyVersion` — reason: prevents
    accidentally folding wrap-version into the data-AAD (data AAD must stay
    stable across rotations).
- **Acceptance**:
  - Unit test: `buildAttachmentCekWrapAAD(e, a, 5, 1)` produces a buffer
    starting with bytes `0x41, 0x57, 0x01, 0x04` (`"AW"`, version=1, 4 fields).
  - Unit test: differing `cekKeyVersion` produces differing AAD bytes.

### C3 — Attachment upload schema (`POST /api/passwords/[id]/attachments`)

- **Subject**: `src/app/api/passwords/[id]/attachments/route.ts` — request
  validator extended with mode-2 fields, mode-0 uploads rejected.
- **Signature**: form fields added: `cekEncrypted` (base64, decoded length
  validated), `cekIv` (`/^[0-9a-f]{24}$/`), `cekAuthTag` (`/^[0-9a-f]{32}$/`),
  `cekKeyVersion` (parsed int ≥ 1), `cekWrapAadVersion` (parsed int = 1
  today). Server sets `encryptionMode = 2` on every successful create.
- **Invariants**:
  - I3.1: Server **rejects** uploads missing any CEK field with HTTP 400 +
    `INVALID_REQUEST`.
  - I3.2: Existing `iv`, `authTag` regex constraints remain unchanged; they
    now describe the CEK-data-level encryption (file body under CEK), not
    direct vault-key encryption.
  - I3.3: `keyVersion` request field is still accepted (for backwards-compat
    request shape) but is ignored on writes — server unconditionally sets
    `encryptionMode = 2` and writes mode-2 columns. (Audit: log one warning
    if a non-null `keyVersion` arrives.)
- **Forbidden patterns**:
  - `pattern: encryptionMode:\s*0\b` (in the upload route) — reason: the
    upload route may not produce mode-0 rows.
- **Acceptance**:
  - Integration test: POST with full mode-2 fields → 201 + row has
    `encryption_mode = 2` + non-null CEK columns.
  - Integration test: POST omitting `cekEncrypted` → 400.
  - Integration test (I3.3 enforcement): POST with `keyVersion: 999` →
    201 + row's `key_version` column is the server-set default (NOT 999)
    + a warning log line `"upload received non-null keyVersion; ignoring"`
    is captured by a test logger spy.

### C4 — Attachment download schema

- **Subject**: `src/app/api/passwords/[id]/attachments/[attachmentId]/route.ts`
  GET — response shape extended.
- **Signature**: response gains `cekEncrypted` (base64), `cekIv`, `cekAuthTag`,
  `cekKeyVersion`, `cekWrapAadVersion`, `encryptionMode`. Existing fields
  unchanged.
- **Invariants**:
  - I4.1: For `encryption_mode = 0` rows, the new CEK fields are emitted as
    `null`. The response always carries `encryptionMode` so the client can
    branch.
  - I4.2: No change to authn / authz checks.
- **Forbidden patterns**:
  - `pattern: cekEncrypted:\s*attachment\.encryptedData` — reason: prevent
    accidental aliasing of the data blob into the CEK field.
- **Acceptance**:
  - Integration test: GET on mode-2 row returns all CEK fields populated.
  - Integration test: GET on mode-0 row returns CEK fields as `null` and
    `encryptionMode: 0`.

### C5 — Legacy migration endpoint

- **Subject**: NEW `PUT /api/passwords/[id]/attachments/[attachmentId]/migrate`.
  As preparation for §C12 testability, the migrate inner logic is extracted
  into a pure function
  `applyAttachmentMigration(tx, { userId, tenantId, entryId, attachmentId, payload }):
   Promise<{ encryptionMode: 2 }>`
  exported from `src/lib/vault/rotate-key-server.ts` (sibling of
  `applyVaultRotation` per §C7 extraction). The route handler becomes a
  thin wrapper for `auth() / migrateLimiter / advisory lock /
  withUserTenantRls / json error mapping`. Integration tests target
  `applyAttachmentMigration` directly with a real Prisma transaction
  (T16).
- **Signature**:
  ```
  Request:  { oldEncryptedDataHash (hex SHA-256 over the existing stored bytes),
              encryptedData (base64), iv, authTag,
              cekEncrypted (base64), cekIv, cekAuthTag,
              cekKeyVersion, cekWrapAadVersion }
  Response: 200 { success: true, attachmentId, encryptionMode: 2 }
            400 INVALID_REQUEST                  malformed body / cekKeyVersion mismatch
            401 UNAUTHORIZED                     no session (Bearer is rejected)
            404 ATTACHMENT_NOT_FOUND             not personal-scope, or wrong tenancy, or absent
            409 LEGACY_MIGRATION_NOT_APPLICABLE  row is already mode-2 or mode-1
            409 LEGACY_BODY_HASH_MISMATCH        stored body hash differs from supplied hash
            429 RATE_LIMITED                     migrate-specific limiter trips
  ```
  Rate limiter: introduce a NEW per-user limiter for migration in
  `src/lib/security/rate-limiters.ts`:
  ```ts
  export const migrateLimiter = createRateLimiter({
    windowMs: 15 * MS_PER_MINUTE,
    max: VAULT_ROTATE_ATTACHMENT_CEK_MAX + 1000, // 5000 work + 1000 retry
    keyPrefix: "rl:attachment_migrate:",         // distinct from upload + rotate
  });
  ```
  - Do NOT reuse `attachmentUploadLimiter` (30/min — F2).
  - Cap is `VAULT_ROTATE_ATTACHMENT_CEK_MAX + 1000` to leave retry headroom
    so a transient network blip on a single migrate does not 429-block the
    rest of the rotation cycle (T18).
  - Migrate route imports the named export from
    `@/lib/security/rate-limiters` — do NOT instantiate inline.
  - Test helpers (T15): the existing repo does NOT have `e2e/helpers/redis.ts`.
    Each rate-limiter exposes a `clear(key)` API used inline by other route
    handlers (e.g., `recovery-key/recover/route.ts:83` calls
    `recoveryLimiter.clear(...)`). Phase B introduces a NEW test helper
    `clearMigrateLimitForUser(userId)` in
    `src/__tests__/helpers/rate-limiters.ts` that imports `migrateLimiter`
    and calls `migrateLimiter.clear(\`rl:attachment_migrate:${userId}\`)`.
    This is the same pattern other tests use; do NOT introduce a separate
    `e2e/helpers/redis.ts` file. (For the Playwright E2E layer, follow the
    existing `resetRotationRateLimit` precedent in
    `e2e/helpers/` — verify exact path during implementation since the
    helper module structure differs between unit and E2E.)
- **Invariants**:
  - I5.1: The handler acquires `pg_advisory_xact_lock(hashtext(userId::text))`
    before SELECT-then-UPDATE. This serializes migration vs. rotation per-user.
  - I5.2: Scoping query MUST use
    `where: { id: attachmentId, passwordEntry: { userId, tenantId },
              passwordEntryId: { not: null }, teamPasswordEntryId: null }`.
    The `passwordEntryId IS NOT NULL AND teamPasswordEntryId IS NULL`
    predicate ensures team-scope attachments (mode-1) cannot be reached
    via the personal migrate route even if the attacker forges an ID.
    Cross-user / cross-tenant / wrong-scope requests return 404 to avoid
    enumeration.
  - I5.3: The pre-migration row's `encryption_mode` MUST be 0; the handler
    returns 409 (`LEGACY_MIGRATION_NOT_APPLICABLE`) for mode-2 or mode-1.
    Idempotency NOT guaranteed on the success path — re-issuing migrate
    against a mode-2 row is an explicit error.
  - I5.4: The handler computes `sha256(rawBytes)` over the **raw byte
    representation** of `currentRow.encryptedData` (Prisma `Bytes`
    column → `Buffer`) inside the advisory-locked transaction, and
    compares it against the request's `oldEncryptedDataHash` (lowercase
    hex). Mismatch → 409 (`LEGACY_BODY_HASH_MISMATCH`). The download
    response in §C4 returns `encryptedData` as base64; client code
    decodes to raw bytes BEFORE hashing, so client and server hash the
    same byte sequence (S13 — single canonicalization point). Rationale:
    closes the chosen-ciphertext body-replacement primitive that a
    stolen-session attacker could otherwise execute by submitting a
    self-consistent CEK + arbitrary `encryptedData` (S1). The hash binds
    the request to the specific stored bytes the client claims to have
    decrypted.
  - I5.5: After hash check passes, the replacement `encryptedData` blob
    writes to the same blob object id (overwrite); the old ciphertext is
    not retained.
  - I5.6: Server enforces `cekKeyVersion === user.keyVersion` AT MIGRATE
    TIME. Mismatch → 400 `INVALID_REQUEST`. Rationale: a session attacker
    could otherwise PUT migrate with a chosen `cekKeyVersion` (e.g.,
    `999_999`) that persists into the row and survives subsequent
    rotations as a tracking cookie / forensic-attribution attack (S5).
  - I5.7: Authentication uses `auth()` only (session cookie required).
    Bearer / extension / SA / MCP tokens MUST be rejected with 401.
    Rationale: legacy migration requires the user to hold the OLD
    `secretKey` in memory, which only the browser-unlocked session has
    after the user enters their passphrase. SA/MCP/extension Bearers
    cannot decrypt mode-0 attachments and have no business calling
    /migrate (F4 / S12). Confirmed against the proxy classification:
    `/api/passwords/...` is in `EXTENSION_TOKEN_ROUTES` (proxy-level
    Bearer-bypass), so the route handler MUST defend.
  - I5.8: Per-attachment write is `prisma.attachment.updateMany({ where:
    { id, passwordEntry: { userId, tenantId }, encryptionMode: 0,
      passwordEntryId: { not: null }, teamPasswordEntryId: null },
    data: {...} })` plus an explicit
    `if (result.count !== 1) throw notFound()` guard. **Use `updateMany`,
    NOT `update`** — Prisma `update` requires a unique-key `where` and
    rejects the relation/encryptionMode predicates here at runtime
    (F1). The `teamPasswordEntryId: null` predicate must mirror I5.2's
    SELECT scope so the SELECT/UPDATE pair share an identical scope
    contract (S14).
  - I5.9: A successful migration emits
    `AUDIT_ACTION.ATTACHMENT_LEGACY_MIGRATION` with metadata `{ entryId,
    attachmentId, fromKeyVersion: row.keyVersion, toKeyVersion:
    cekKeyVersion }`.
- **Forbidden patterns**:
  - `pattern: prisma\.attachment\.update\b` (single-row form) in the migrate
    route or rotation route — reason: must use `updateMany` per I5.8 / I7.6.
  - `pattern: prisma\.attachment\.(update|updateMany).*encryptionMode:\s*0`
    in the `data` argument — reason: cannot regress to mode-0.
  - `pattern: where:\s*\{\s*id:\s*attachmentId\s*\}` without
    `passwordEntry: { userId }` AND `passwordEntryId: { not: null }`
    scoping in the same `where` — reason: scoping invariant.
  - `pattern: authOrToken\(` in the migrate route file — reason: I5.7,
    Bearer/SA/MCP tokens must be rejected.
- **Acceptance**:
  - Integration test: migrate a mode-0 row with correct
    `oldEncryptedDataHash` → 200 + row is mode-2 + audit event present.
  - Integration test: migrate a mode-0 row with mismatched hash → 409
    `LEGACY_BODY_HASH_MISMATCH` + row unchanged.
  - Integration test: migrate a mode-2 row → 409
    `LEGACY_MIGRATION_NOT_APPLICABLE`.
  - Integration test: migrate against a team-attachment ID (mode-1) using
    a session that has access to the underlying team → 404 (NOT 200,
    NOT 409). Verifies T12: route does not allow team-scope attachments
    through the personal migrate path.
  - Integration test: cross-user migrate attempt → 404.
  - Integration test: concurrent migrate + rotate → one wins, the other
    sees a coherent state (advisory lock).
  - Integration test (Bearer-rejection): supply only an extension /
    `sa_` / `mcp_` Bearer (no session cookie) → 401. Rationale: I5.7.
  - Integration test: PUT with `cekKeyVersion = user.keyVersion + 1` →
    400 `INVALID_REQUEST` + row unchanged.
  - Error responses for `LEGACY_MIGRATION_NOT_APPLICABLE` and
    `LEGACY_BODY_HASH_MISMATCH` carry NO additional payload (no
    "expected" / "observed" hashes / counts). Rationale: prevent
    information disclosure to a session attacker (S11).

### C6 — Rotation data fetch (`GET /api/vault/rotate-key/data`)

- **Subject**: `src/app/api/vault/rotate-key/data/route.ts` — response shape
  extended.
- **Signature**: response adds:
  ```
  mode2Attachments: Array<{
    id, entryId, cekEncrypted (base64), cekIv, cekAuthTag,
    cekKeyVersion, cekWrapAadVersion
  }>,
  mode0Attachments: Array<{ id, entryId }>   // capped at ATTACHMENT_MANIFEST_CAP (1000)
  ```
  **D1 (2026-05-04)**: the original spec said `mode0AttachmentIds: string[]`
  but the client requires `entryId` to call
  `/api/passwords/{entryId}/attachments/{id}` AND to build the data AAD
  `buildAttachmentAAD(entryId, attachmentId)`. The shape is therefore
  `Array<{ id, entryId }>` and the overflow boolean is renamed to
  `mode0AttachmentsOverflow`.
- **Invariants**:
  - I6.1: `attachmentsAffected` field is REMOVED from the response.
  - I6.2: Both arrays are scoped by `passwordEntry: { userId }`.
  - I6.3: When `mode0Attachments.length === ATTACHMENT_MANIFEST_CAP`, the
    response also carries `mode0AttachmentsOverflow: true` so the client
    can paginate (loop GET → migrate → GET) until empty.
- **Forbidden patterns**:
  - `pattern: attachmentsAffected:\s*` (in the response object) — reason:
    Phase A field removed.
  - `pattern: mode0AttachmentIds\s*:` — reason: replaced by `mode0Attachments`
    per D1; bare `id[]` shape is insufficient for client-side migration.
- **Acceptance**:
  - Integration test: vault with 3 mode-0 + 2 mode-2 attachments → response
    has `mode0Attachments.length === 3` and `mode2Attachments.length === 2`,
    each `mode0Attachments` element exposes `id` AND `entryId`.
  - Integration test: 1500 mode-0 attachments → first GET returns 1000 entries
    + `mode0AttachmentsOverflow: true`.

### C7 — Rotation POST (`POST /api/vault/rotate-key`)

- **Subject**: `src/app/api/vault/rotate-key/route.ts` — request schema +
  transaction extended. As preparation for §C12 testability, the rotation
  inner logic is extracted into a pure function `applyVaultRotation(tx,
  userId, payload): Promise<RotationEffects>` exported from
  `src/lib/vault/rotate-key-server.ts`. The route handler becomes a thin
  wrapper for `auth() / migrateLimiter / advisory lock /
  withUserTenantRls / json error mapping`. Integration tests target
  `applyVaultRotation` directly with a real Prisma transaction.
- **Signature**:
  - Request shape (delta vs Phase A schema at
    [src/app/api/vault/rotate-key/route.ts:36–70](../../src/app/api/vault/rotate-key/route.ts#L36)):
    - **DROPS**: `acknowledgeAttachmentDataLoss`.
    - **ADDS**: `attachmentCekRewraps: Array<{ id, cekEncrypted (base64),
      cekIv, cekAuthTag, cekKeyVersion, cekWrapAadVersion }>`, capped at
      `VAULT_ROTATE_ATTACHMENT_CEK_MAX = 5000`.
    - **ADDS**: `legacyAttachmentsMigratedThisCycle: number` (client-asserted
      reporting count of migrate-PUT calls the client made between the
      GET and the POST; documented as reporting-only — does NOT gate
      rotation success).
    - **UNCHANGED**: `currentAuthHash`, `encryptedSecretKey`, `secretKeyIv`,
      `secretKeyAuthTag`, `accountSalt`, `newAuthHash`, `newVerifierHash`,
      `verificationArtifact`, `entries`, `historyEntries`,
      `encryptedEcdhPrivateKey`, `ecdhPrivateKeyIv`,
      `ecdhPrivateKeyAuthTag`. Implementation MUST preserve every Phase
      A field (notably the ECDH private key rewrap fields — without them,
      emergency-access ECDH decrypt breaks after rotation).
  - Inside the rotation transaction, additional steps before the User
    update:
    1. **Defensive guard A** — count mode-0 rows scoped by
       `passwordEntry: { userId }`. If `> 0`, throw
       `LegacyAttachmentsResidualError` → HTTP 409
       `LEGACY_ATTACHMENTS_RESIDUAL`. Response body carries no count.
    2. **Defensive guard B** (loosened from strict equality, F6) — fetch
       the set of mode-2 attachment IDs scoped by
       `passwordEntry: { userId }`. Verify (a) every id in
       `attachmentCekRewraps` exists in this set, AND (b) no mode-0
       attachments exist (already enforced by guard A). Extra mode-2
       rows that arrived after the client's data fetch (e.g., concurrent
       upload) are ALLOWED; the rotation proceeds for the subset listed
       in the manifest, and the new mode-2 rows remain wrapped under the
       OLD secretKey for the user to rewrap on the next rotation cycle.
       This eliminates the spurious-mismatch livelock for users with
       concurrent activity. Mismatch (manifest references a non-existent
       or non-mode-2 id) → 409 `ATTACHMENT_CEK_MANIFEST_MISMATCH` with no
       count payload.
    3. **Per-row consistency check at wrap time** (S4) — for each id in
       the manifest, fetch `cek_key_version` of the current row. If the
       row's `cek_key_version !== users.key_version` (the OLD vault key
       version, read inside the same transaction BEFORE the User row is
       updated to the new version in step 7 of the existing rotation
       flow — F22 temporal clarity), throw
       `LegacyAttachmentInconsistentVersionError` → HTTP 409
       `ATTACHMENT_INCONSISTENT_VERSION` with no payload. This catches
       DB-level tampering between rotations. Idempotent on retry: a
       previously-successful rotation leaves rows at
       `cek_key_version = newKeyVersion`, which after the next rotation
       attempt's User-update step would also be the new value; the check
       compares against the CURRENT row value at step-3 time, so retry
       semantics are preserved.
    4. Per-row update (Prisma) — see I7.6.
    5. **Post-write defensive check** (S8) — after all per-row updates,
       count rows where
       `passwordEntry: { userId } AND encryption_mode = 2 AND cek_key_version != newKeyVersion`.
       If `> 0`, throw `RotationPostConditionError` (the rotation
       transaction rolls back). This is a belt-and-suspenders check
       against any row update silently being skipped.
- **Invariants**:
  - I7.1: The advisory-lock + transaction wrapper is preserved
    (`pg_advisory_xact_lock(hashtext(userId::text))`).
  - I7.2: Per-attachment update uses `passwordEntry: { userId, tenantId }`
    scoping. Tenant binding is essential because RLS is the primary
    cross-tenant guard.
  - I7.3: After a successful POST, every Attachment row scoped by
    `passwordEntry: { userId } AND encryption_mode = 2` has
    `cek_key_version === newKeyVersion`. Mode-0 rows are forbidden by
    guard A; mode-1 (team-attachment) rows are out of scope of this
    invariant entirely. The rotation completes only if (a) every per-row
    `updateMany` returned `count === 1`, AND (b) the post-write defensive
    check returns 0.
  - I7.4: Audit metadata includes `cekRewrapsAttempted`,
    `cekRewrapsSucceeded`, `cekRewrapsFailed`,
    `legacyAttachmentsMigratedClientReported` (echoed verbatim from the
    client-supplied `legacyAttachmentsMigratedThisCycle` request field;
    explicit `ClientReported` suffix flags this as untrusted data — a
    stolen-session attacker submitting `0` to mask their own
    attacker-driven migrate calls is a known threat per S15; defensive
    guards A/B/post-write enforce data integrity, this field is
    reporting-only and does NOT gate rotation success), `mode0Residual`
    (always 0 on success — guard A enforces this; field carried for
    forensic visibility).
  - I7.5: The metadata fields `attachmentDataLossAcknowledged` and the
    OLD-style `affectedAttachmentIds`/`affectedAttachmentIdsOverflow`
    are REMOVED. They are REPLACED by `cekRewrappedAttachmentIds`
    (capped at `ATTACHMENT_MANIFEST_CAP = 1000`) and
    `cekRewrappedAttachmentIdsOverflow: boolean` (S6) so that forensic
    investigation can reconstruct which rows were expected to rewrap if
    a single attachment fails post-rotation decryption later.
  - I7.6: Per-attachment write is
    `prisma.attachment.updateMany({ where: { id, passwordEntry: { userId, tenantId }, encryptionMode: 2 }, data: {...} })`
    plus `if (result.count !== 1) throw AttachmentCekManifestMismatchError()`.
    Use `updateMany`, NOT `update` (F1) — Prisma `update` rejects
    relation/encryptionMode predicates in `where` at runtime.
  - I7.7: Error responses for `LEGACY_ATTACHMENTS_RESIDUAL`,
    `ATTACHMENT_CEK_MANIFEST_MISMATCH`, `ATTACHMENT_INCONSISTENT_VERSION`
    carry NO additional payload (no expected/observed counts). UI
    messages are generic. Rationale: prevent information disclosure to
    a session attacker (S11).
- **Forbidden patterns**:
  - `pattern: acknowledgeAttachmentDataLoss` — reason: Phase A flag removed.
  - `pattern: ATTACHMENT_DATA_LOSS_NOT_ACKNOWLEDGED` — reason: retired.
  - `pattern: AttachmentAckRequiredError` — reason: deleted.
  - `pattern: prisma\.attachment\.update\(` (single-row) inside
    `rotate-key/route.ts` or `rotate-key-server.ts` — reason: I7.6 mandates `updateMany`.
- **Acceptance**:
  - Integration test (T12.1): rotate a vault containing only mode-2
    attachments → 200 + every Attachment row scoped by
    `passwordEntry: { userId } AND encryption_mode = 2` has
    `cek_key_version === newKeyVersion`. (Mode-0/1 rows out of scope per
    I7.3.)
  - Integration test (T12.3): rotate when a mode-0 row still exists →
    409 `LEGACY_ATTACHMENTS_RESIDUAL`. No `VAULT_KEY_ROTATION` audit row
    is emitted (rejection happens before audit emit, T13).
  - Integration test (T12.4): rotate where the manifest references a
    non-existent id → 409 `ATTACHMENT_CEK_MANIFEST_MISMATCH`.
  - Integration test (S4 coverage): tamper a row's `cek_key_version` to
    `user.keyVersion + 1` between data fetch and POST → 409
    `ATTACHMENT_INCONSISTENT_VERSION`.
  - Integration test (concurrent-upload preserves rotation): a mode-2
    row arrives between data fetch and POST → rotation succeeds for the
    listed manifest, the new row remains wrapped under OLD secretKey
    pending the next rotation. Verifies F6 mitigation.

### C8a — Client-side attachment-section refactor

- **Subject**: `src/components/passwords/entry/attachment-section.tsx`
  ([file](../../src/components/passwords/entry/attachment-section.tsx), 355
  lines) — the only personal-attachment client surface today. It currently
  has no `encryptionMode` awareness and expects every attachment row to be
  mode-0 / direct vault-key encryption.
- **Signature**: branch on `encryptionMode` after fetching attachment data:
  - `encryptionMode === 0`: existing decrypt path (unwrap with `secretKey`,
    AAD = `buildAttachmentAAD(entryId, attachmentId)`). Surface a one-line
    UI hint "Legacy attachment — will migrate on next vault rotation"; do
    NOT trigger a download-time migration in Phase B (deferred to a Phase
    B+ enhancement to keep this PR scoped).
  - `encryptionMode === 2`: NEW path — unwrap CEK from
    `(cekEncrypted, cekIv, cekAuthTag)` using `secretKey` + wrap AAD
    `buildAttachmentCekWrapAAD(entryId, attachmentId, cekKeyVersion,
    cekWrapAadVersion)`; then unwrap body using CEK + data AAD.
  - Upload path: client always generates a fresh CEK, encrypts body under
    CEK, wraps CEK with current `secretKey` + current `keyVersion`,
    submits as mode-2 (per C3).
- **Invariants**:
  - I8a.1: For mode-0 reads, no fall-through that silently proceeds with
    undefined CEK fields — those branches are guarded by the
    `encryptionMode` switch.
  - I8a.2: Upload uses the `keyVersion` returned by `getKeyVersion()`
    (vault-context.tsx:131) at the moment of CEK wrap. The server's
    upload response carries `keyVersion: <persisted>`; if the client
    sent value differs from the persisted value, the client SHOULD
    re-upload (rare race — only happens when rotation commits between
    client `getKeyVersion()` read and server upload TX). If a rotation
    has invalidated the session (existing post-rotation token revocation
    at rotate-key/route.ts:412), the upload will already 401. Add a
    contract sub-acceptance: the upload route response includes
    `keyVersion: <persisted>`. (Reworded from F8 — the previous
    "refetch session vault state" formulation referred to a non-existent
    surface.)
  - I8a.3: For mode-2 unwrap, the client gates the row's stored
    `cekWrapAadVersion` against
    `MIN_ACCEPTED_CEK_WRAP_AAD_VERSION` (exported from C2 / `crypto-aad.ts`)
    BEFORE invoking AES-GCM unwrap. Below-floor values throw with a
    distinct error code so the user sees "this attachment was wrapped
    with an outdated AAD format that this client no longer accepts —
    contact support" rather than a generic decrypt failure (S3).
- **Forbidden patterns**:
  - `pattern: encryptionMode\s*===\s*1` (in personal attachment client) —
    reason: mode 1 is team-only; personal client must not branch on it.
- **Acceptance**:
  - NEW test scaffolding `src/components/passwords/entry/attachment-section.test.tsx`
    uses real `@/lib/crypto/crypto-client` (NO module-level mock), real
    Web Crypto subtle key fixture, and real `@/lib/crypto/crypto-aad`
    (no mock). Mocks are limited to: (a) `useVault` returning a fixed
    `{ encryptionKey }`, (b) next-intl translations, (c) the
    `fetch`/SWR layer for attachment data. Decrypt assertions compare
    plaintext bytes byte-by-byte against the expected fixture, NOT
    against spy-call shapes (T8 — defends against RT1 mock-reality
    divergence on AAD argument order).
  - Vitest component test: render `attachment-section` with a mode-0 row,
    assert decrypt-and-display yields expected plaintext.
  - Vitest component test: render with a mode-2 row, assert decrypt
    yields expected plaintext (no spy-only assertions).
  - Vitest component test: render with a mode-2 row whose
    `cekWrapAadVersion = 0` (below floor) → throws the
    "outdated AAD format" error per I8a.3.
  - Vitest component test: upload flow constructs a mode-2 form payload
    with all CEK fields populated; assert form-data shape includes the
    new fields.

### C8 — Client-side rotation flow

- **Subject**: `src/components/vault/rotate-key-dialog.tsx` (and the
  underlying `src/lib/vault/rotate-key-client.ts` if extracted) — client
  rotation flow performs in-line legacy migration.
- **Signature**: pseudo-flow:
  ```
  1. data = await GET /api/vault/rotate-key/data
  2. while (data.mode0Attachments.length > 0):
       for each { id, entryId } in data.mode0Attachments:
         (att) = await GET /api/passwords/{entryId}/attachments/{id}; decrypt with old secretKey
         oldEncryptedDataHash = sha256(rawBytes of stored encryptedData)  // hex
         cek = randomAESKey(256)
         ct  = encrypt(att.body, cek, AAD = buildAttachmentAAD(entryId, id))
         wrap = wrap(cek, oldSecretKey, AAD =
                buildAttachmentCekWrapAAD(entryId, id, oldKeyVersion, 1))
         await PUT /api/passwords/{entryId}/attachments/{id}/migrate
                { oldEncryptedDataHash, ct, ...wrap, cekKeyVersion: oldKeyVersion, cekWrapAadVersion: 1 }
       data = await GET /api/vault/rotate-key/data    // pagination loop
  3. for each m in data.mode2Attachments:
       cek = unwrap(m.cek*, oldSecretKey, AAD =
                    buildAttachmentCekWrapAAD(m.entryId, m.id,
                                              m.cekKeyVersion, m.cekWrapAadVersion))
       newWrap = wrap(cek, newSecretKey, AAD =
                      buildAttachmentCekWrapAAD(m.entryId, m.id,
                                                newKeyVersion, 1))
       attachmentCekRewraps.push({ id: m.id, ...newWrap,
                                   cekKeyVersion: newKeyVersion,
                                   cekWrapAadVersion: 1 })
  4. POST /api/vault/rotate-key { entries, history, attachmentCekRewraps,
                                  ... existing fields }
  ```
- **Invariants**:
  - I8.1: The CEK is generated client-side via `crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"])` —
    extractable=true so the client can wrap it. The CEK never reaches the
    server unwrapped. Wrap idiom: use
    `crypto.subtle.exportKey("raw", cek) → AES-GCM encrypt with secretKey
    + wrap AAD`, mirroring the team ItemKey wrap idiom in existing
    `src/lib/crypto/` helpers. Do NOT use `crypto.subtle.wrapKey` (F17 —
    ensures consistency with the existing wrap site so future readers see
    one idiom only).
  - I8.2: After a successful rotation, the client zeroizes any
    `Uint8Array` / `Buffer` that holds the **exported raw bytes** of a
    CEK or the OLD `secretKey` (`.fill(0)`), then drops references to
    the corresponding `CryptoKey` objects so they become gc-eligible.
    `CryptoKey` internal buffers are NOT directly zeroizable from JS —
    the WebCrypto spec hides the underlying material. Best-effort: this
    matches the existing zeroization pattern used for entry blobs (F23
    — clarifies that I8.1's CEK is a `CryptoKey`, not a TypedArray, so
    the `.fill(0)` mechanism applies only to its exported raw form).
  - I8.3: User-facing progress: a "migrating N legacy attachments…"
    indicator inside the dialog. Spec value: text + numeric counter, no
    bandwidth telemetry needed.
  - I8.4: On per-attachment migration failure (network drop, blob upload
    error), the rotation flow halts BEFORE the rotation POST. The user is
    shown an error and instructed to retry — they are not left in a
    half-rotated state because the rotation POST has not yet been issued.
- **Forbidden patterns**:
  - `pattern: secretKey.*toString\(['"]hex['"]\)` (in the rotation client)
    — reason: secret key material must not be hex-stringified for any
    reason; that risks leaking via React props / dev tools.
- **Acceptance**:
  - E2E test (`e2e/tests/settings-key-rotation.spec.ts` extension): vault
    pre-seeded with 1 mode-0 attachment + 1 mode-2 attachment → rotation →
    both end as mode-2 with `cek_key_version === newKeyVersion`; original
    file body still decrypts to the same plaintext.
  - E2E test: migration mid-flow network drop → no rotation POST issued,
    user sees actionable error.

### C9 — Phase A artifact removal

- **Subject**: code, error catalogs, i18n, E2E, **VaultProvider context API**.
- **Signature**: deletions/replacements:
  - DELETE `AttachmentAckRequiredError` class and the 422 catch in
    `src/app/api/vault/rotate-key/route.ts`.
  - DELETE `API_ERROR.ATTACHMENT_DATA_LOSS_NOT_ACKNOWLEDGED` from
    `src/lib/http/api-error-codes.ts`.
  - DELETE `messages/en/ApiErrors.json` and `messages/ja/ApiErrors.json`
    keys for the deleted error.
  - DELETE Phase A "data-loss warning" UI in
    `src/components/vault/rotate-key-dialog.tsx` (lines 43, 93, 96, 99,
    199, 204, 223 reference `attachmentsAffected` — all must be removed
    or replaced with the C8 progress UI).
  - **UPDATE `src/lib/vault/vault-context.tsx`** (F5 — was missing from
    Phase A artifact list):
    - Remove `acknowledgeAttachmentDataLoss?: boolean` from the
      `rotateKey` options type at line 123–127.
    - Remove `attachmentsAffected: number` from the `RotationEffects`
      interface at line 91–100. Add the new effect fields:
      `cekRewrapsAttempted`, `cekRewrapsSucceeded`, `cekRewrapsFailed`,
      `legacyAttachmentsMigrated`.
    - Replace the inline rotation flow body (line 818–1011) with the C8
      mode-0 → migrate → mode-2 rewrap loop. (May be moved to a
      sibling `src/lib/vault/rotate-key-client.ts` for testability.)
  - REPLACE the Phase A E2E case "rotation rejects without
    acknowledgement" with a Phase B case "rotation auto-migrates legacy
    attachments" (see also §C9b for unit-test updates).
- **Invariants**:
  - I9.1: After the diff is merged, the grep
    `grep -rn "acknowledgeAttachmentDataLoss\|ATTACHMENT_DATA_LOSS_NOT_ACKNOWLEDGED\|AttachmentAckRequiredError\|RotationEffects.*attachmentsAffected\|attachmentsAffected:\s*number"`
    returns nothing under `src/`, `e2e/`, `messages/`, `cli/src/`,
    `extension/src/`. (Allowed in `docs/archive/review/` only.)
    F13 — `cli/` and `extension/` workspaces are explicit grep targets.
  - I9.2: API error catalog adds new error codes
    `LEGACY_ATTACHMENTS_RESIDUAL`, `LEGACY_MIGRATION_NOT_APPLICABLE`,
    `LEGACY_BODY_HASH_MISMATCH`, `ATTACHMENT_CEK_MANIFEST_MISMATCH`,
    `ATTACHMENT_INCONSISTENT_VERSION`, each with en + ja i18n entries.
- **Forbidden patterns** — covered by C7 / C9 invariants.
- **Acceptance**:
  - `npm run lint` + `npx next build` clean.
  - The grep at I9.1 returns 0 under all five listed paths.

### C9b — Route-level unit-test updates (Phase A test removal)

- **Subject**: enumerate the route-level unit-test files that mock the
  Phase A response shape; they go stale silently if not updated (RT1).
- **Files in scope**:
  - `src/app/api/vault/rotate-key/route.test.ts` — currently 4 references
    to `attachmentsAffected` / `acknowledgeAttachmentDataLoss`. Drop the
    "rejects without acknowledge" test cases. Add: "drops
    `acknowledgeAttachmentDataLoss` from request schema", "rejects when
    manifest mismatches mode-2 count" → 409, "rejects when mode-0
    residue exists" → 409, "rejects when row's `cek_key_version`
    desyncs" → 409 `ATTACHMENT_INCONSISTENT_VERSION`.
  - `src/app/api/vault/rotate-key/data/route.test.ts` — currently 4
    references to `attachmentsAffected` in mock returns. Drop those
    mocks. Add: "returns `mode2Attachments` array", "returns
    `mode0Attachments` array of `{ id, entryId }` (capped at `ATTACHMENT_MANIFEST_CAP`)",
    "returns `mode0AttachmentsOverflow: true` when 1500 mode-0 rows
    exist".
  - **NOTE on `src/components/vault/rotate-key-dialog.tsx`**: the dialog
    component file itself is covered by §C9 (Phase A artifact removal);
    it is NOT a test file and does not appear in §C9b's scope. If a
    colocated `rotate-key-dialog.test.tsx` exists at PR time, update its
    assertions to remove `attachmentsAffected` references and replace
    with progress-text assertions. If absent (current state on `main`),
    the dialog UI changes are covered exclusively by E2E (§C8 and §C13
    M-scenarios) and no test-file action is required here. F21 — the
    earlier per-line citation is removed from this contract because the
    actual line set on `main` (39, 43, 60, 71, 93, 99, 199, 204, 223)
    differed from the cited list and §C9 I9.1 grep already enforces zero
    residue without needing a per-line list (T19).
- **Invariants**:
  - I9b.1: Each affected test file's `attachmentsAffected` and
    `acknowledgeAttachmentDataLoss` references are removed or updated.
    Verified by I9.1 grep.
  - I9b.2: New test cases enumerate (a) 409 paths for residue / mismatch
    / inconsistent-version, (b) success path with non-empty
    `attachmentCekRewraps`, (c) absence of `acknowledgeAttachmentDataLoss`
    in the request schema.
- **Acceptance**:
  - `npx vitest run src/app/api/vault/rotate-key` passes.
  - The grep `grep -rn "attachmentsAffected\|acknowledgeAttachmentDataLoss" src/__tests__ src/app`
    returns 0.

### C10 — Audit action additions

- **Subject**: `src/lib/constants/audit/audit.ts` + i18n + audit-group maps.
- **Signature**:
  - ADD `AUDIT_ACTION.ATTACHMENT_LEGACY_MIGRATION` with action value
    `"ATTACHMENT_LEGACY_MIGRATION"` (UPPER_SNAKE matching the key —
    consistent with all existing values like
    `ATTACHMENT_UPLOAD: "ATTACHMENT_UPLOAD"` at audit.ts:34. F3/S9 — the
    earlier `"attachment.legacy_migration"` form would break SIEM regex
    `/^ATTACHMENT_/` and the audit-i18n-coverage test).
  - Target on emit: `AUDIT_TARGET_TYPE.ATTACHMENT` (existing constant at
    `src/lib/constants/audit/audit-target.ts:2`); `targetId =
    attachment.id`. Do NOT introduce a new target type (F16 clarity).
  - REGISTER in `PERSONAL.ATTACHMENT` audit-action group.
  - ADD i18n labels in `messages/en/AuditLog.json`,
    `messages/ja/AuditLog.json` keyed off `"ATTACHMENT_LEGACY_MIGRATION"`.
  - `VAULT_KEY_ROTATION` metadata schema gains the new fields (see I7.4 /
    I7.5):
    - `cekRewrapsAttempted`, `cekRewrapsSucceeded`, `cekRewrapsFailed`
      (counts);
    - `legacyAttachmentsMigrated` (count, client-asserted);
    - `mode0Residual` (count, always 0 on success);
    - `cekRewrappedAttachmentIds` (capped list per ATTACHMENT_MANIFEST_CAP),
      `cekRewrappedAttachmentIdsOverflow` (boolean) — replaces Phase A's
      `affectedAttachmentIds` for forensic continuity (S6).
- **Invariants**:
  - I10.1: The new action appears in EVERY audit-action group definition,
    i18n map (en + ja), and UI label map. Verified by §C10b group-coverage
    test (which is itself a Phase B deliverable, NOT a pre-existing test).
  - I10.2: An exhaustive `switch (action)` block, if any exists, includes
    the new value (R12 / R20 conformance — verified by grep for
    `AUDIT_ACTION.ATTACHMENT_LEGACY_MIGRATION`).
- **Forbidden patterns**:
  - `pattern: ATTACHMENT_LEGACY_MIGRATION` (must appear in EACH of: const
    definition, group map, en label, ja label, group-coverage test).
- **Acceptance**:
  - The group-coverage test from §C10b passes locally and in CI.
  - The audit-i18n-coverage test (`src/__tests__/audit-i18n-coverage.test.ts`)
    — which compares `AUDIT_ACTION_VALUES` to en/ja i18n keys — passes.

### C10b — NEW audit-action group-coverage test

- **Subject**: NEW `src/__tests__/audit-action-group-coverage.test.ts`. T2
  flagged that the test invoked by §C10 I10.1 does NOT exist on `main`.
- **Signature**: pseudo-test:
  ```ts
  import {
    AUDIT_ACTION_VALUES,
    PERSONAL_AUDIT_ACTION_GROUPS,
    TEAM_AUDIT_ACTION_GROUPS,
    TENANT_AUDIT_ACTION_GROUPS,
  } from "@/lib/constants";

  describe("AUDIT_ACTION group coverage", () => {
    it("every AUDIT_ACTION_VALUES entry is registered in at least one group", () => {
      const inAnyGroup = new Set([
        ...Object.values(PERSONAL_AUDIT_ACTION_GROUPS).flat(),
        ...Object.values(TEAM_AUDIT_ACTION_GROUPS).flat(),
        ...Object.values(TENANT_AUDIT_ACTION_GROUPS).flat(),
      ]);
      const missing = AUDIT_ACTION_VALUES.filter((a) => !inAnyGroup.has(a));
      expect(missing).toEqual([]);
    });
  });
  ```
  Adapt to actual exported names — verify the const definitions in
  `src/lib/constants/audit/audit.ts`.
- **Invariants**:
  - I10b.1: The test fails if a new `AUDIT_ACTION` is added to the
    const-list but not registered in any group. Verifies that R12 group
    coverage is enforced by CI from this PR onward.
  - I10b.2: The test does NOT enforce membership in a SPECIFIC group;
    only that each value appears in at least one. Group choice is the
    contributor's responsibility (and reviewed in PR).
- **Acceptance**:
  - When `ATTACHMENT_LEGACY_MIGRATION` is added to `AUDIT_ACTION_VALUES`
    but NOT to `PERSONAL.ATTACHMENT`, the test fails locally. After
    `PERSONAL.ATTACHMENT` is updated, it passes.
  - `npx vitest run src/__tests__/audit-action-group-coverage.test.ts`
    passes against `main`'s existing audit actions.

### C11 — Whitepaper §6.1.d update

- **Subject**: `docs/security/cryptography-whitepaper.md` §6.1.d.
- **Signature**: rewrite the section. Title becomes
  "Personal attachments under CEK indirection". Body:
  1. Each attachment has a randomly generated 256-bit AES-GCM CEK.
  2. The file body is encrypted with the CEK + data AAD `"AT"` (entryId,
     attachmentId).
  3. The CEK is wrapped with the user's vault `secretKey` + wrap AAD `"AW"`
     (entryId, attachmentId, cekKeyVersion, cekWrapAadVersion).
  4. Vault rotation rewraps each CEK with the new `secretKey`; file bodies
     are not re-encrypted.
  5. Pre-Phase-B attachments (`encryptionMode = 0`) migrate to mode-2 the
     first time their owner runs vault rotation: the client decrypts with
     the old `secretKey`, generates a CEK, wraps it, and PUTs the result via
     `/migrate`. After migration, the attachment behaves identically to a
     freshly uploaded mode-2 attachment.
- **Invariants**:
  - I11.1: §6.1.e (ECDH cross-domain) is unchanged in this PR.
  - I11.2: §6.1.c "Cleared at rotation" is REWORDED (NOT deleted) to
    reflect Phase B's CEK indirection model. The literal
    "(except attachment file bodies)" caveat is removed, but the spirit
    of the caveat — file bodies are NOT re-encrypted at rotation — is
    preserved with a more precise statement: "Previous secretKey is
    removed from the trust boundary. File bodies remain encrypted under
    their stable, freshly-rewrapped CEK (the body is not re-encrypted;
    only the CEK wrap is). An attacker who recovered the old `secretKey`
    AND a pre-rotation snapshot of `cekEncrypted` rows would still
    recover plaintext from the snapshot; rotation freshness is bound to
    backup hygiene." (S10 — straight deletion would mislead readers into
    thinking "everything is freshly encrypted post-rotation", which is
    not the case.)
  - I11.3: §6.1.d body explicitly documents the snapshot-window risk
    (S2): "Mode-2 wraps written by the legacy-migration flow under the
    OLD secretKey persist in DB and backup tape until the corresponding
    rotation POST commits and rewraps them under the NEW secretKey. An
    operator who aborts mid-migration leaves these wraps in the OLD-key
    trust posture; the next rotation cycle clears them. Backup tape
    retains the OLD-key wrap forever — rotation freshness is bound to
    backup hygiene."
- **Forbidden patterns** (in the new §6.1.d body):
  - `pattern: acknowledgeAttachmentDataLoss` — reason: Phase A residue.
  - `pattern: orphan rows` — reason: stale Phase A vocabulary.
- **Acceptance**:
  - Section reads coherently with §6.1.b (rotation) + §6.1.c (cleared at
    rotation) + §6.1.e (ECDH).

### C12 — Integration test

- **Subject**: NEW `src/__tests__/db-integration/vault-rotate-key-attachments.integration.test.ts`.
  Tests target the extracted pure function `applyVaultRotation(tx, userId,
  payload)` from §C7 (and its sibling `applyAttachmentMigration(tx, …)`
  helper for the migrate path). The route handler itself is verified by
  unit tests in §C9b. Rationale: the existing
  `vault-rotate-key-gaps.integration.test.ts` deliberately tests
  subroutines because the full POST handler runs through proxy / session
  / RLS context wiring that is not available in the integration runner
  (T4 — RT2 testability).
- **Test fixture prerequisite (T1)**: `e2e/helpers/password-entry.ts:113-159`
  `seedAttachment(...)` currently emits random bytes for
  `encryptedData/iv/authTag` ("content does not need to be decryptable
  for #433"). Phase B requires real AES-GCM ciphertext for round-trip
  acceptance. Update the helper signature to:
  ```ts
  function seedAttachment({
    plaintext: Buffer,
    encryptionKey: CryptoKey,   // user vault secretKey for mode-0
    encryptionMode: 0 | 2,
    cekKeyVersion?: number,     // required for mode-2
    cekWrapAadVersion?: number, // required for mode-2
  })
  ```
  produces actual AES-GCM ciphertext.
  **CRITICAL — production AAD path required (T21)**: the helper MUST
  import `buildAttachmentAAD` and `buildAttachmentCekWrapAAD` from the
  PRODUCTION `@/lib/crypto/crypto-aad` module — NOT define a local copy
  or stub. Otherwise the round-trip test (helper-encrypts →
  helper-decrypts) self-validates and silently passes even if the
  helper's AAD construction drifts from the production builder. The
  Vitest unit test for the helper round-trips plaintext using the
  helper to encrypt and the **production** `crypto-aad` + AES-GCM
  unwrap to decrypt; if the production builder's argument order differs
  from the helper's, the test fails — which is the desired behavior.
  - Mode-0: body encrypted directly under `encryptionKey` with AAD
    `buildAttachmentAAD(entryId, attachmentId)`.
  - Mode-2: body encrypted under a fresh CEK with the same data AAD;
    CEK wrapped under `encryptionKey` with
    `buildAttachmentCekWrapAAD(entryId, attachmentId, cekKeyVersion,
    cekWrapAadVersion)`.
- **Signature**: cover, in real Postgres + Prisma:
  - T12.1: rotation against a vault containing only mode-2 attachments
    (happy path; assert `cek_key_version` updates, audit metadata).
  - T12.2: rotation against a vault containing 5 mode-0 + 5 mode-2
    attachments → after running the client-flow's server-visible
    operations (5 migrations via `applyAttachmentMigration` + 1 rotation
    via `applyVaultRotation`) every row is mode-2 and `cek_key_version`
    matches new vault keyVersion. Plaintext round-trip: decrypt each
    body with the new vault key + CEK indirection; assert plaintext
    matches the original `seedAttachment` input.
  - T12.3: residual mode-0 row at rotation → 409
    `LEGACY_ATTACHMENTS_RESIDUAL`. Audit assertion: NO `VAULT_KEY_ROTATION`
    audit row exists (rejection happens before audit emit, T13).
  - T12.4: manifest references a non-existent id → 409
    `ATTACHMENT_CEK_MANIFEST_MISMATCH`.
  - T12.4b: row's `cek_key_version` desyncs from `user.keyVersion` → 409
    `ATTACHMENT_INCONSISTENT_VERSION` (S4 coverage).
  - T12.4c: a NEW mode-2 row arrives between data-fetch and POST (extra
    row, manifest-listed rows still match) → rotation succeeds for
    listed manifest, the new row remains mode-2 wrapped under OLD
    `secretKey` (F6 coverage).
  - T12.5: cross-user migrate attempt → 404 (RLS / scope guard).
  - T12.5b: migrate against a team-attachment id (mode-1) using a session
    that has access to the underlying team → 404 (T12 coverage).
  - T12.5c: migrate with mismatched `oldEncryptedDataHash` → 409
    `LEGACY_BODY_HASH_MISMATCH` (S1 coverage).
  - T12.5d: migrate with `cekKeyVersion = user.keyVersion + 1` → 400
    `INVALID_REQUEST` (S5 coverage).
  - T12.6: concurrent migrate + rotate. Test design splits into two
    deterministic cases plus one contested loop:
    - T12.6a (deterministic, rotation-first): use `instanceA`, `instanceB`
      (two distinct PrismaClient instances per I12.3). Sequence:
      `instanceA` `BEGIN; SELECT pg_advisory_xact_lock(hashtext($userId))`;
      poll via `instanceC` `SELECT * FROM pg_locks WHERE locktype='advisory' AND objid=hashtext($userId)`
      until `granted=true`; THEN `instanceB` issues migrate on the same
      user; verify via `instanceC` that `instanceB`'s lock acquisition
      enters `granted=false` state; THEN `instanceA` commits; THEN
      `instanceB` unblocks. Assert: migrate sees the rotation-committed
      state (T9 — proper synchronization barrier).
    - T12.6b (deterministic, migrate-first): symmetric with migrate
      committing first, rotation second; rotation either sees the
      now-mode-2 row in its data fetch OR errors with
      `ATTACHMENT_CEK_MANIFEST_MISMATCH` if the migrate completed AFTER
      rotation's data fetch but before its POST (acceptable — client
      retries).
    - T12.6c (contested loop, RT4-compliant): run 50 iterations using
      `instanceA` + `instanceB` of `Promise.all([rotate(), migrate()])`.
      Record outcomes. Pre-loop health check: fires a single `instanceA`
      rotate and `instanceB` migrate truly in parallel; assert at least
      ONE of: (a) instanceC observes the contention via `pg_locks` row
      with `granted = true` for instanceA's pid AND a queued waiter, OR
      (b) instanceB's query latency exceeds 50ms. On health-check
      failure use `expect.fail("genuine contention not reachable; race
      test cannot validate concurrency")` — NOT `ctx.skip()` (T20
      vacuous-pass guard: skipped tests in CI dashboards look identical
      to passing tests; only `expect.fail` produces a red signal that
      surfaces a regression in the test infrastructure itself). After
      health check, run 50 main iterations and assert ALL three of:
      `rotationWonCount > 0`, `migrateWonCount > 0`,
      `doubleSuccessCount === 0`.
  - T12.7: forensic audit metadata — `cekRewrapsAttempted === cekRewrapsSucceeded === N`,
    `cekRewrapsFailed === 0`,
    `legacyAttachmentsMigratedClientReported === M`,
    `mode0Residual === 0`. Each numeric assertion uses the
    field-presence-then-equality pattern (T24) to surface "field
    missing" as a distinct failure from "field has wrong value":
    ```ts
    expect("mode0Residual" in metadata).toBe(true);
    expect(metadata.mode0Residual).toBe(0);
    ```
    Same pattern for `cekRewrapsAttempted`, `cekRewrapsSucceeded`,
    `cekRewrapsFailed`, and `legacyAttachmentsMigratedClientReported`.
    Plus: `cekRewrappedAttachmentIds.length === N`,
    `cekRewrappedAttachmentIdsOverflow === false` (S6 coverage).
- **Invariants**:
  - I12.1: Tests run against a real Postgres (`test:integration` target),
    not mocked Prisma, so the advisory lock is exercised.
  - I12.2: Test cleanup truncates `attachments`, `audit_logs`,
    `audit_outbox` and other affected tables but NEVER `users` /
    `tenants` / `sessions` / `mcp_*` / `webauthn_credentials` /
    `recovery_*` / `emergency_access_*` (R31 security-state-table
    category).
  - I12.3 (T5 — RT4 cardinality requires genuine concurrency): T12.6c
    and any test relying on advisory-lock contention MUST allocate two
    distinct PrismaClient instances (each with its own pg.Pool) via
    `createPrismaForRole('app')` (NOT superuser — T22). A single
    PrismaClient with `pool.max=3` does not produce genuine concurrent
    transactions because the pool serializes connection acquisition.
    Plus a third instance `instanceC` (for the lock-contention probe
    described in I12.4) — the `app` role suffices for that probe too,
    since `pg_locks` is readable to all roles.
    **Role choice rationale**: `applyVaultRotation` and
    `applyAttachmentMigration` are tested under the production DB role
    (`passwd_app`, NOSUPERUSER, NOBYPASSRLS) so that RLS predicates are
    actually enforced. A `'superuser'` PrismaClient bypasses RLS entirely
    (`BYPASSRLS` capability) and would silently mask RLS-scoping bugs
    that production would catch. Tests acquire the role wrapper via
    `withUserTenantRls(userId, async () => appPrisma.$transaction(async tx => applyVaultRotation(tx, ...)))`.
  - I12.4 (T9 — deterministic interleaving requires explicit sync
    barrier): T12.6a and T12.6b use a HYBRID barrier for robustness:
    1. instanceA `BEGIN; pg_advisory_xact_lock(hashtext($userId))`.
    2. Poll for contention evidence via TWO complementary signals (T17 —
       `pg_locks` polling primitive has no precedent in this repo, so
       defense-in-depth is required):
       (a) instanceC reads `pg_locks` filtered to
       `locktype = 'advisory' AND granted = true AND pid = (instanceA's pid)`,
       OR (b) instanceB's competing query latency > 50ms (a robust
       contention signal — `pg_advisory_lock` enqueue under no
       contention is sub-millisecond). The test fails only when BOTH
       signals are negative; either signal positive proves contention
       reachable.
    3. instanceB issues its contesting query.
    4. instanceA commits.
    5. instanceB unblocks; assert outcome.
    The `pg_locks` SQL must be:
    `SELECT granted FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objsubid = 1 AND pid = $1`
    (single-arg `pg_advisory_xact_lock(int4)` produces `objsubid = 1`;
    the `objid` field carries the hashtext_int32 result and is what the
    test would compare if multiple users were in flight, but filtering
    by the specific lock-holder pid is more reliable).
  - I12.5 (T10 — R25 process-boundary persist/hydrate): for T12.1, T12.2,
    T12.7, the rotation post-condition is verified by reading the rows
    via a SECOND PrismaClient instance constructed AFTER the rotation
    transaction commits (close + reopen the writing instance OR
    construct an entirely separate instance). Read assertions compare:
    (a) `cek_encrypted` Bytes column byte-by-byte against the expected
        wrap blob;
    (b) `cek_iv` and `cek_auth_tag` VARCHAR columns are equal as exact
        lowercase-hex strings to what the client sent (T23 — defends
        against case-folding / padding bugs);
    (c) `cek_key_version` and `cek_wrap_aad_version` integer columns
        match the manifest values.
- **Forbidden patterns**:
  - `pattern: vi\.mock\(['"]@?prisma` (in this test) — reason:
    integration test must hit a real DB (Mandatory Checks, RT1).
  - `pattern: new\s+PrismaClient\(\s*\)` (anonymous instantiation, no
    args, NOT assigned to a named const) — reason: every PrismaClient
    instance in this test must be a named const declared at module or
    `describe`-scope so the instance count is auditable. I12.3 + I12.5
    + the post-commit read-back may legitimately allocate up to four
    named instances (e.g., `appPrismaA`, `appPrismaB`, `appPrismaC`,
    `appPrismaReadback`). The previous "more than twice" rule (F19)
    contradicted I12.3 + I12.5 and is replaced by the named-const
    requirement.
- **Acceptance**:
  - All T12.x cases pass under `npm run test:integration`.
  - The test file's own setup (T12.6c health check) verifies advisory
    lock contention is reachable BEFORE the main 50-iteration loop runs;
    the loop's RT4 assertions are valid only when the health check
    confirms genuine contention.

### C13 — Manual test plan (R35 Tier-2 deliverable)

- **Subject**: NEW `docs/archive/review/vault-attachment-rotation-phase-b-manual-test.md`,
  authored alongside the implementation PR. R35 Tier-2 (cryptographic-material
  changes — key rotation + envelope-key chain) makes this Critical-if-missing.
- **Required sections** (matching companion artifact for #433 at
  `docs/archive/review/433-key-rotation-gaps-manual-test.md`):
  - **Pre-conditions**: fixture data, environment state, prerequisite migrations.
    Operator MUST substitute placeholder identifiers (`<test-user-email>`,
    `<reviewer-handle>`) with their own (RS4 — never commit real PII).
  - **Steps**: exact commands or UI actions; reference project start command
    (`npm run dev` with `npm run docker:up` for DB).
  - **Expected result**: concrete (status code, log line, DB row state, UI
    element visibility) — not "works correctly".
  - **Rollback**: how to revert; explicit "destructive — operator-only" markers.
  - **Adversarial scenarios** (Tier-2): cross-tenant migrate attempt,
    body-hash-mismatch attack, stolen `cekKeyVersion` replay, manifest
    desync, signature-skip probe.
- **Required scenarios** (closed list — implementation PR cannot merge with
  fewer):
  - **M1**: fresh install + upload mode-2 attachment + download → plaintext
    matches.
  - **M2**: upgrade Phase A → B without rotation; download a mode-0
    attachment → plaintext matches via legacy decrypt path. Verifies NFR-3.
  - **M3**: upgrade Phase A → B + rotate; download both originally-mode-2
    and migrated-mode-0 attachments → plaintext matches via mode-2
    decrypt path under new vault key.
  - **M4**: abort mid-rotation per §S3 — close browser after 8 of 12
    migrations commit; reopen later; resume rotation; final state has all
    12 mode-2 under new vault key.
  - **M5**: attacker has DB write access (simulated by direct SQL); flips
    a row's `cek_encrypted` back to its pre-rotation blob value while
    leaving `cek_key_version` at the post-rotation value. Operator runs
    a normal client-side download → unwrap fails AES-GCM verification
    because the wrap AAD includes the now-current `cekKeyVersion` while
    the wrap was produced under the prior version — the AAD bytes
    differ, so verification rejects. Operator-visible result: download
    error with the "outdated AAD format" code from §C8a I8a.3 OR an
    AES-GCM error (S17 — replaces the earlier "submit a request with
    the stale wrap" wording, which was vague about endpoint).
  - **M6**: concurrent migrate + rotate per §S5 — open two tabs with
    the same authenticated session. Tab A initiates rotation. Tab B
    clicks "view attachment" on a mode-0 entry, which triggers (in a
    Phase B+ enhancement) an on-demand migrate. Advisory lock
    serializes. Verify no half-applied state on either side. (Phase B
    only ships the rotation-driven migrate; on-demand migrate is a
    Phase B+ stretch goal — if not implemented in this PR, M6 is
    rephrased as "tab B uploads a new attachment while tab A's
    rotation is in progress" to exercise the same lock surface.)
  - **M7**: server reject of mode-0 upload after Phase B server lands —
    POST a mode-0 upload (without CEK fields) → 400 (verifies C3 I3.1
    invariant).
  - **M8**: forged `attachmentId` in `/migrate` request. Test three
    sub-variants per S18 / T12.5 / T12.5b:
    (a) id belongs to another user → 404, no enumeration leak;
    (b) id belongs to another tenant (same user impossible by tenancy
        model, so use a separate test tenant) → 404;
    (c) id belongs to a TEAM-scoped attachment, AND the test session is
        a member of that team with team-attachment access → still 404
        from the personal migrate route (the team-scope predicate
        `teamPasswordEntryId: null` rejects the row regardless of team
        membership). This sub-variant is the strongest test of the
        scope-predicate guard.
  - **M9**: malformed CEK fields (truncated `cekEncrypted`, wrong-length
    `cekIv`, non-hex `cekAuthTag`) → 400 + row unchanged.
  - **M10**: stolen-session body-replacement attempt — submit `/migrate`
    with valid CEK fields but mismatched `oldEncryptedDataHash` → 409
    `LEGACY_BODY_HASH_MISMATCH`; original ciphertext intact (S1 defense).
  - **M11**: (post-rotation forensic) audit log entry for the rotation
    contains `cekRewrappedAttachmentIds` list capped at 1000 + overflow
    boolean (S6 forensic continuity).
- **Acceptance**:
  - File exists at named path and contains all 11 scenarios with
    Pre-conditions / Steps / Expected result / Rollback (and Adversarial
    where applicable).
  - PR cannot merge without this file (CI grep can enforce: file presence).
  - File contains NO real personal-identifying data (RS4 — operator
    placeholders only).

## Go/No-Go Gate

| ID   | Subject                                                                                | Status |
|------|----------------------------------------------------------------------------------------|--------|
| C0   | Shared constant relocation                                                             | locked |
| C1   | Schema additions (Prisma)                                                              | locked |
| C2   | `buildAttachmentCekWrapAAD` helper + AAD scope `"AW"` + `MIN_ACCEPTED_…` constant      | locked |
| C3   | Attachment upload schema (mode-2 only; ignored-on-writes assertion for `keyVersion`)   | locked |
| C4   | Attachment download schema (CEK fields, `encryptionMode`)                              | locked |
| C5   | Legacy migration endpoint (`PUT /migrate`, body-hash binding, session-only auth, `applyAttachmentMigration` extraction) | locked |
| C6   | Rotation data fetch (mode2Attachments + mode0Attachments[{id,entryId}] + overflow)     | locked |
| C7   | Rotation POST (`applyVaultRotation` extraction, defensive guards A/B + step-3 + step-5, `cekRewrappedAttachmentIds` audit) | locked |
| C8a  | Client-side attachment-section refactor (mode-0/2 branching, AAD-version floor gate)   | locked |
| C8   | Client-side rotation flow (auto-migrate mode-0 then rewrap mode-2)                     | locked |
| C9   | Phase A artifact removal (incl. vault-context.tsx, cli/, extension/ in grep scope)     | locked |
| C9b  | Route-level unit-test updates (rotate-key/route.test.ts, data/route.test.ts)           | locked |
| C10  | Audit action additions (`ATTACHMENT_LEGACY_MIGRATION` UPPER_SNAKE)                     | locked |
| C10b | Audit-action group-coverage test (NEW)                                                 | locked |
| C11  | Whitepaper §6.1.d + §6.1.c update (caveat reworded, snapshot caveat documented)        | locked |
| C12  | Integration test (`applyVaultRotation` direct invocation, hybrid sync barrier, RLS-honoring app-role) | locked |
| C13  | Manual test plan (R35 Tier-2 deliverable) — 11 enumerated scenarios                    | locked |

All contracts are `locked` after two review rounds. The 18 contracts above
are the stable cross-reference surface for Phase 2 implementation and
Phase 3 review. Contract IDs are stable and will be cited (not paraphrased)
in subsequent rounds, deviation logs, manual-test references, and review
comments.

## Testing strategy

| Layer | Coverage |
|-------|----------|
| Unit (vitest) | C2 AAD builder; C3/C4/C5/C6/C7 schema-validator branches; client crypto wrap/unwrap helpers. |
| Integration (`npm run test:integration`, real Postgres) | C12 cases (T12.1–T12.7), advisory-lock race, RLS scope. |
| E2E (Playwright `e2e/tests/settings-key-rotation.spec.ts`) | Browser-driven full rotation including legacy migration; verifies the user-facing progress UI; verifies plaintext recovery after rotation. |
| Migration (`npm run db:migrate`) | Run against a dev DB containing pre-seeded mode-0 rows; assert post-migration row counts and column nullability. |
| Manual test plan (R35 Tier-2) | `docs/archive/review/vault-attachment-rotation-phase-b-manual-test.md` covers fresh-install, upgrade-from-Phase-A, attachment download cross-version, and adversarial cases (concurrent migrate+rotate, malformed CEK fields, forged attachmentId in migrate request). |

## Considerations & constraints

### Risks

| Risk | Mitigation |
|------|------------|
| User has thousands of mode-0 attachments → migration step is slow | `mode0Attachments` is paginated (cap 1000 per fetch). The rotation dialog reports progress (count + bytes) and is resumable: a user who cancels and restarts simply continues from the remaining mode-0 set. |
| Migration drives blob-store cost (overwrite per legacy attachment) | Migration only happens once per attachment per user lifetime. Cost is bounded by total existing user attachment bytes, paid one time. |
| Schema migration window: between `npx prisma migrate dev` and code deploy, queries reading the new columns from old code → null reads | New columns are nullable; old code does not reference them. (R24 split — additive only in this phase; the future strict-NOT-NULL flip is a separate migration.) |
| The advisory-lock interleaving makes migrate vs. rotate races possible to misroute | C5 and C7 both acquire `pg_advisory_xact_lock(hashtext(userId::text))`. C12 T12.6 covers the race in integration tests with the RT4 vacuous-pass guard. |
| Forgotten audit-group registration causes silent gaps in tenant audit log filters (R12) | C10 invariants enumerate every site that must register the new action; the audit-group coverage test fails CI if any site is missed. |
| Client memory pressure when rotating a vault with 5000 mode-2 attachments | The client streams the CEK rewraps batch-by-batch (batches of 100, mirroring the existing entry-batching pattern at `route.ts:266`). |
| `ATTACHMENT_LEGACY_MIGRATION` + rotation interleaving by an attacker who has stolen a session token | Both endpoints are session-protected; the advisory lock prevents privilege races; the migrate endpoint requires a valid CEK wrap AND a matching `oldEncryptedDataHash` (S1 defense — denies a session attacker who has not actually pulled the existing body the ability to overwrite it). |
| Aborted-migration extended snapshot-compromise window (S2) | Mode-2 wraps written by the legacy-migration flow under the OLD `secretKey` persist in DB and backup tape until the corresponding rotation POST commits and rewraps them under the NEW `secretKey`. An attacker who has (a) a pre-Phase-B backup snapshot, (b) a post-aborted-migration backup snapshot, AND (c) the OLD `secretKey` (recovered via any consumer of it before clearing) can decrypt the migrated bodies. Mitigation: §6.1.d documents the caveat; the rotation dialog SHOULD opportunistically commit a CEK-only rewrap when an aborted-migration state is detected on relogin (TODO Phase B+); operational mitigation is backup tape rotation policy aligned with vault rotation policy. |
| AAD wrap-version downgrade (S3) | Client gates `cekWrapAadVersion` against `MIN_ACCEPTED_CEK_WRAP_AAD_VERSION` (C2 I2.5). An attacker who flips a row's stored version to below the floor is rejected at unwrap. |
| `cek_key_version` desync (S4) | Server reconciles `cek_key_version === user.keyVersion` AT WRAP TIME (C7 step 3). DB-tampering between rotations triggers `ATTACHMENT_INCONSISTENT_VERSION` rather than a silent decrypt failure later. |
| `cekKeyVersion` injection in migrate (S5) | Server enforces `cekKeyVersion === user.keyVersion` in C5 I5.6. Session attacker cannot inject a chosen version. |
| Forensic regression on rotation audit (S6) | `cekRewrappedAttachmentIds` (capped at `ATTACHMENT_MANIFEST_CAP`) + `cekRewrappedAttachmentIdsOverflow` retained in audit metadata for SIEM/IR replay. |

### Constraints

- The blob store interface is unchanged: `blobStore.deleteObject` /
  `blobStore.putObject` continue to be used as today. We do not introduce
  versioned blobs at the storage layer.
- Prisma 7 driver-adapter pattern is preserved.
- Phase B does NOT touch the team attachment path. Team attachments remain
  on the `encryptionMode = 1` (TeamPasswordEntry-level ItemKey) flow.
- No change to ECDH identity rotation (whitepaper §6.1.e).

## User operation scenarios

### S1 — User with only mode-2 attachments rotates the vault key

1. User opens Settings → Security → Rotate Master Passphrase.
2. Dialog asks for old + new passphrase. User submits.
3. Client GETs `/api/vault/rotate-key/data` → `mode0Attachments` is empty.
4. Client unwraps each CEK with old `secretKey`, rewraps with new `secretKey`.
5. Client POSTs `/api/vault/rotate-key` with the rewrap manifest.
6. UI shows success; entries, history, and attachments are all under the new
   `secretKey`. Rotation completes in seconds.

### S2 — User with mixed mode-0 + mode-2 attachments rotates

1. As S1 steps 1–2.
2. Client GETs `/api/vault/rotate-key/data` → `mode0Attachments` has 12 entries (each `{ id, entryId }`).
3. UI shows progress: "Migrating 12 legacy attachments…".
4. For each id: client downloads via existing GET, decrypts with old key,
   generates CEK, encrypts body, wraps CEK with old key, PUTs `/migrate`.
5. After all 12 succeed, client GETs the rotation data again — which now
   returns `mode2Attachments.length === 12 + originalMode2Count`.
6. Client rewraps every CEK with the new `secretKey`.
7. Client POSTs `/api/vault/rotate-key`. Server validates manifest count,
   updates rows, commits.
8. UI reports success. Audit log records `legacyAttachmentsMigrated: 12`.

### S3 — User aborts rotation mid-migration

1. User starts rotation. Migration of 8 of 12 attachments completes.
2. User closes the browser.
3. State on disk: 8 attachments are mode-2 (under OLD `secretKey`), 4 are
   mode-0. The vault `secretKey` is unchanged. **PRF wrapping is NOT
   cleared** (clearing happens only inside the rotation transaction,
   which has not committed). **Recovery key wrapping is NOT cleared**
   (same reason). **EmergencyAccess grants are NOT marked STALE** (same
   reason). All consumer wrappings of the OLD `secretKey` remain
   functional.
4. User reopens app, can still decrypt all attachments with their existing
   passphrase: the 8 mode-2 attachments unwrap their CEK with the same
   `secretKey` that the original mode-0 entries used. PRF unlock from a
   passkey continues to work because the PRF wrap still maps to the
   OLD `secretKey`.
5. On next rotation, the client picks up only the 4 remaining mode-0
   rows. The 8 already-mode-2 attachments are listed under
   `mode2Attachments` in the data fetch and rewrapped under the new
   `secretKey` during the rotation transaction. (F18 — clarification:
   the abort case leaves PRF/Recovery/EmergencyAccess wrappings
   functional with OLD `secretKey`, which still unwraps mode-2 CEKs
   because they share the same key.)
6. **Snapshot caveat (S2)**: backup tape captured between step 1 and
   step 4 retains 8 mode-2 wraps under OLD `secretKey`. An attacker who
   later acquires (a) the backup tape AND (b) the OLD `secretKey` (via
   any consumer of it that pre-dates Phase B's clearing — note that
   under Phase B's `applyVaultRotation` flow these consumer wrappings
   are still cleared atomically, but only AFTER the user completes the
   rotation POST) recovers the 8 mode-2 attachment bodies even after
   the user's eventual rotation. Backup hygiene matters; Phase B
   rotation is no stronger than the backup tape rotation policy. This
   caveat is recorded in whitepaper §6.1.d per I11.3.

### S4 — Attacker holds an old wrap blob from before rotation

1. Attacker exfiltrates `cek_encrypted` for an attachment when
   `cek_key_version = 5`.
2. User rotates to `keyVersion = 6`. Attachment is rewrapped; the row now
   has the new wrap.
3. Attacker gains access to the user's new `secretKey` somehow (out of
   scope of this rotation, but consider the threat).
4. Attacker tries to decrypt with the OLD wrap blob: the wrap AAD is
   `(entryId, attachmentId, cekKeyVersion=5, cekWrapAadVersion=1)`. The new
   `secretKey` is being applied with AAD `(entryId, attachmentId, 6, 1)`.
   AES-GCM verification fails. The old blob is useless.

### S5 — Concurrent rotation + migration (race)

1. User A initiates rotation in browser tab #1.
2. User A also clicks "View attachment" in tab #2, which would trigger a
   future on-demand lazy migration.
3. Tab #1 begins the rotation flow; tab #2's lazy migration request hits
   the migrate endpoint at the same moment.
4. The advisory lock serializes: tab #2's PUT acquires the lock first,
   migrates the row, releases. Tab #1's GET sees the now-mode-2 row in the
   second-pass `mode0Attachments`. (Or vice versa — tab #1 acquires
   first, migration commits, then tab #2's PUT sees mode-2 and returns 409
   `LEGACY_MIGRATION_NOT_APPLICABLE`. Tab #2 falls back to the standard
   download path.)
5. No half-applied state results.

---

End of plan. Contracts are pending until plan review concludes; once locked,
implementation proceeds against the contract IDs C1–C12.

## Implementation Checklist (Step 2-1, generated 2026-05-04)

### Files to MODIFY (Phase A artifact removal — covered by C9)

- `src/app/api/vault/rotate-key/route.ts` — drop `acknowledgeAttachmentDataLoss`, `AttachmentAckRequiredError`, `attachmentsAffected`, inline `ATTACHMENT_MANIFEST_CAP` (relocate to `validations/common.ts`)
- `src/app/api/vault/rotate-key/data/route.ts` — drop `attachmentsAffected`, add `mode2Attachments` + `mode0Attachments` (each `{ id, entryId }`) + `mode0AttachmentsOverflow` boolean (D1)
- `src/app/api/vault/rotate-key/route.test.ts` — drop ack-required cases; add manifest-mismatch / mode-0-residual / inconsistent-version cases (C9b)
- `src/app/api/vault/rotate-key/data/route.test.ts` — drop `attachmentsAffected` mocks; add new fields (C9b)
- `src/app/api/passwords/[id]/attachments/route.ts` — accept mode-2 CEK fields, reject missing (C3); store `encryptionMode = 2`
- `src/app/api/passwords/[id]/attachments/[attachmentId]/route.ts` — extend GET response with CEK fields + `encryptionMode` (C4)
- `src/lib/vault/vault-context.tsx` — drop ack-required option/branch; replace rotation flow body (C8/C9); update `RotationEffects`
- `src/components/vault/rotate-key-dialog.tsx` — drop data-loss banner; add progress UI (C8/C9)
- `src/components/passwords/entry/attachment-section.tsx` — branch on `encryptionMode` for upload/download (C8a)
- `src/lib/http/api-error-codes.ts` — drop `ATTACHMENT_DATA_LOSS_NOT_ACKNOWLEDGED`; add `LEGACY_ATTACHMENTS_RESIDUAL`, `LEGACY_MIGRATION_NOT_APPLICABLE`, `LEGACY_BODY_HASH_MISMATCH`, `ATTACHMENT_CEK_MANIFEST_MISMATCH`, `ATTACHMENT_INCONSISTENT_VERSION`
- `src/lib/validations/common.ts` — add `ATTACHMENT_MANIFEST_CAP` + `VAULT_ROTATE_ATTACHMENT_CEK_MAX` (C0)
- `src/lib/crypto/crypto-aad.ts` — add `SCOPE_ATTACHMENT_WRAP = "AW"`, `buildAttachmentCekWrapAAD`, `MIN_ACCEPTED_CEK_WRAP_AAD_VERSION` (C2); update header comment listing scopes
- `src/lib/security/rate-limiters.ts` — add `migrateLimiter` (C5)
- `src/lib/constants/audit/audit.ts` — add `ATTACHMENT_LEGACY_MIGRATION` action; register in `PERSONAL.ATTACHMENT` group (lines 437, 518)
- `messages/en/AuditLog.json`, `messages/ja/AuditLog.json` — add `ATTACHMENT_LEGACY_MIGRATION` label (C10)
- `messages/en/ApiErrors.json`, `messages/ja/ApiErrors.json` — drop `attachmentDataLossNotAcknowledged`; add 5 new error keys (C9 I9.2)
- `messages/en/Vault.json`, `messages/ja/Vault.json` — drop `rotateKeyAttachmentDataLossWarning` family; add migration progress strings
- `prisma/schema.prisma` — `Attachment` model gains 5 nullable columns (C1)
- `e2e/tests/settings-key-rotation.spec.ts` — drop Phase A ack case; add Phase B mode-0 → mode-2 + rotation case (C9)
- `docs/security/cryptography-whitepaper.md` — rewrite §6.1.d, reword §6.1.c (C11)

### Files to CREATE

- `prisma/migrations/<new-timestamp>_add_attachment_cek_indirection/migration.sql` (C1)
- `src/lib/vault/rotate-key-server.ts` — `applyVaultRotation` + `applyAttachmentMigration` extraction (C5/C7)
- `src/app/api/passwords/[id]/attachments/[attachmentId]/migrate/route.ts` — `PUT /migrate` (C5)
- `src/__tests__/helpers/rate-limiters.ts` — `clearMigrateLimitForUser` helper (C5 test infra)
- `src/__tests__/audit-action-group-coverage.test.ts` — group-coverage test (C10b)
- `src/__tests__/db-integration/vault-rotate-key-attachments.integration.test.ts` — T12 cases (C12)
- `docs/archive/review/vault-attachment-rotation-phase-b-manual-test.md` — R35 Tier-2 deliverable (C13)

### Shared utilities to REUSE (no reimplementation)

- `buildAADBytes` (`crypto-aad.ts:33`) — `buildAttachmentCekWrapAAD` MUST delegate to this; do NOT copy validation logic (C2 I2.4)
- `createRateLimiter` (`security/rate-limit.ts`) — for `migrateLimiter`
- `withUserTenantRls` (`tenant-context.ts`) — every DB query path
- `pg_advisory_xact_lock(hashtext($userId::text))` — same lock id as existing `route.ts:175`
- `getAttachmentBlobStore()` + `AttachmentBlobStore` interface — unchanged (constraint)
- `prisma.attachment.updateMany` (NOT `update`) — relation/encryptionMode predicates only work in `updateMany` (I5.8 / I7.6)
- `personalAuditBase` (`@/lib/audit/audit`) — for `ATTACHMENT_LEGACY_MIGRATION` emit
- `createPrismaForRole("app")` (`db-integration/helpers.ts`) — RLS-honoring instances for T12
- Existing patterns: `recoveryLimiter.clear(...)` at `recovery-key/recover/route.ts:83` mirrors test-helper pattern
- `seedAttachment` (`e2e/helpers/password-entry.ts:113`) — extend with real AES-GCM, NOT a parallel helper (T1/T21)
- `buildAttachmentAAD` import — production AAD path mandatory in helpers (T21)

### Patterns / invariants to follow consistently

- `updateMany` + `if (count !== 1) throw` guard at every per-row attachment write (I5.8 / I7.6)
- `passwordEntry: { userId, tenantId }` scoping on every personal attachment query (I5.2 / I7.2)
- `passwordEntryId: { not: null }, teamPasswordEntryId: null` on personal-scope queries (I5.2)
- Scope/encryptionMode predicate parity between SELECT and UPDATE (S14)
- 409/400 error responses carry NO additional payload (S11 — no expected/observed counts)
- `expect("field" in metadata).toBe(true)` then `expect(metadata.field).toBe(...)` for audit metadata (T24)
- Only `auth()` (no `authOrToken`) on `/migrate` route (I5.7)

### CI gates that fire on this diff

- `.github/workflows/ci.yml` — lint, build, test, version-check (every diff)
- `.github/workflows/ci-integration.yml` — `npm run test:integration` (db-integration)
- `.github/workflows/codeql.yml` — JS/TS analysis (every diff)
- `.github/workflows/refactor-phase-verify.yml` — schema/route refactor gates if matched
- Pre-PR verification: `scripts/pre-pr.sh` (per `feedback_run_pre_pr_before_push.md`)

### Phase A artifact grep (must return 0 after Phase B lands — I9.1)

```
grep -rn "acknowledgeAttachmentDataLoss\|ATTACHMENT_DATA_LOSS_NOT_ACKNOWLEDGED\|AttachmentAckRequiredError\|RotationEffects.*attachmentsAffected\|attachmentsAffected:\s*number" \
  src/ e2e/ messages/ cli/src/ extension/src/
```

### R35 Tier-2 mechanical fire

Diff matches `prisma/migrations/*` + `*-compose.yml`-adjacent? No deployment artifacts touched, BUT C1 introduces a schema migration that affects encryption-material chain — qualifies as **R35 Tier-2 (cryptographic-material change)** → `vault-attachment-rotation-phase-b-manual-test.md` is **mandatory** (covered by C13).
