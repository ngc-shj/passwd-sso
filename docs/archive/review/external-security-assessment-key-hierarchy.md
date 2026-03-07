# External Security Assessment — Future Key Hierarchy Design

Based on: [external-security-assessment.md](external-security-assessment.md)
Source: ChatGPT follow-up review on attachment key architecture

---

## Goals

1. Reduce attachment re-encryption cost during key rotation
2. Clarify revoke boundaries
3. Prevent key management breakdown across entries, history, and attachments

---

## Recommended Future Key Hierarchy

```text
User Passphrase
  |
  v
KDF (PBKDF2, Argon2id migration via kdfType metadata)
  |
  v
User Root / Wrapping Key
  |
  v
User Secret Key (account-specific)
  |
  v
TeamMemberKeyEnvelope (ECDH-P256)
  |
  v
TeamKey vN                          <-- shared trust boundary
  |
  v
ItemKey (per entry)                 <-- entry-level confidentiality boundary
  |--- Entry Data (AES-256-GCM)
  |--- Entry History Snapshot
  |
  v
AttachmentKey (per attachment)      <-- blob-level operational boundary
  |
  v
Attachment Blob (AES-256-GCM)
```

### Current vs Future

| Layer | Current | Future |
|---|---|---|
| Entry data | TeamKey -> encrypt | TeamKey -> wrap ItemKey -> encrypt |
| Attachment | TeamKey -> encrypt | TeamKey -> wrap ItemKey -> wrap AttachmentKey -> encrypt |
| History | TeamKey -> encrypt (version tracked) | ItemKey -> encrypt |
| Rotation cost | Re-encrypt all entries + attachments | Rewrap ItemKey envelopes only |

---

## Key Roles

### TeamKey vN — Shared Trust Boundary

- Wraps ItemKey (never encrypts data directly)
- Controls team membership boundary
- Rotation = rewrap all ItemKey envelopes
- Revoke = rotate to vN+1, exclude removed member

### ItemKey — Entry-Level Confidentiality Boundary

- One per TeamPasswordEntry
- Encrypts entry data, overview, and history snapshots
- Wraps AttachmentKey
- Survives TeamKey rotation (only envelope changes)

### AttachmentKey — Blob-Level Operational Boundary

- One per attachment
- Encrypts attachment binary
- Separated from ItemKey for:
  - Large file streaming encryption
  - Per-attachment corruption isolation
  - Independent re-processing capability

---

## Version Tracking Requirements

### Team level
- `teamKeyVersion` (existing)

### Item level (new)
- `itemKeyVersion` or `itemKeyWrappedByTeamKeyVersion`

### Attachment level (new)
- `attachmentKeyVersion`
- `attachmentWrappedByItemKeyVersion`

### KDF level (new — roadmap item #1)
- `kdfType`
- `kdfIterations`
- `kdfMemory`, `kdfParallelism`

---

## AAD Structure Recommendations

### Entry Data AAD

```text
type      = "entry"
teamId    = <team-id>
entryId   = <entry-id>
teamKeyVersion
itemKeyVersion
schemaVersion
```

### History AAD

```text
type      = "history"
teamId    = <team-id>
entryId   = <entry-id>
historyId = <history-id>
itemKeyVersion
snapshotVersion
schemaVersion
```

### Attachment AAD

```text
type      = "attachment"
teamId    = <team-id>
entryId   = <entry-id>
attachmentId = <attachment-id>
itemKeyVersion
attachmentKeyVersion
schemaVersion
```

---

## Improved Operation Flows

### Rotation Flow (Future)

```text
1. TeamKey vN -> TeamKey vN+1
2. Rewrap all ItemKey envelopes with new TeamKey
3. Issue new TeamMemberKeyEnvelope for active members
4. Exclude revoked members
5. Kill all sessions/tokens for revoked members
6. Background verify: check for unprocessed items
```

Key difference: **entry data and attachment blobs are NOT re-encrypted**.

### Revoke Flow (Future)

```text
1. Remove TeamMemberKeyEnvelope for target user
2. Rotate TeamKey to vN+1
3. Rewrap all ItemKey envelopes
4. Kill target user's sessions + extension tokens + API keys
5. Audit log: revoke + rotation event
```

Forward secrecy guaranteed. Backward secrecy impossible (E2E limitation).

### History Restore Flow (Future)

```text
1. Decrypt old snapshot with ItemKey (same key, version tracked)
2. Save as current entry (no re-encryption needed if ItemKey unchanged)
3. If ItemKey rotated: decrypt with old, re-encrypt with current
4. Audit log: restore event
```

Simpler than current flow because ItemKey outlives TeamKey rotation.

---

## Migration Strategy

### Phase 1 — Metadata Only (no crypto changes)

Add metadata columns to prepare for ItemKey:
- `TeamPasswordEntry`: add `encryptedItemKey`, `itemKeyIv`, `itemKeyAuthTag`,
  `itemKeyVersion`, `itemKeyWrappedByTeamKeyVersion`
- `TeamAttachment`: add `attachmentKeyVersion`, `encryptionMode`, `wrappedByItemKeyVersion`
- Existing data: `encryptionMode = "legacy"` (teamKey-direct)

### Phase 2 — New Data Uses New Hierarchy

- New team entries generate ItemKey, wrapped by TeamKey
- New attachments generate AttachmentKey, wrapped by ItemKey
- Existing entries continue with legacy mode
- Client detects `encryptionMode` and uses appropriate decryption path

### Phase 3 — Background Migration

- On access: decrypt legacy, re-encrypt with ItemKey, update record
- Background job: migrate remaining legacy entries
- After migration complete: remove legacy code path

---

## Prisma Schema Changes (Draft)

```prisma
model TeamPasswordEntry {
  // ... existing fields ...

  // ItemKey envelope (Phase 1+)
  encryptedItemKey              String?  @map("encrypted_item_key") @db.Text
  itemKeyIv                     String?  @map("item_key_iv") @db.VarChar(24)
  itemKeyAuthTag                String?  @map("item_key_auth_tag") @db.VarChar(32)
  itemKeyVersion                Int      @default(0) @map("item_key_version")
  itemKeyWrappedByTeamKeyVersion Int     @default(0) @map("item_key_wrapped_by_team_key_version")
  encryptionMode                String   @default("legacy") @map("encryption_mode") @db.VarChar(16)
  // encryptionMode: "legacy" = teamKey-direct, "itemkey" = ItemKey hierarchy
}

model TeamAttachment {
  // ... existing fields ...

  // AttachmentKey envelope (Phase 2+)
  encryptedAttachmentKey        String?  @map("encrypted_attachment_key") @db.Text
  attachmentKeyIv               String?  @map("attachment_key_iv") @db.VarChar(24)
  attachmentKeyAuthTag          String?  @map("attachment_key_auth_tag") @db.VarChar(32)
  attachmentKeyVersion          Int      @default(0) @map("attachment_key_version")
  wrappedByItemKeyVersion       Int      @default(0) @map("wrapped_by_item_key_version")
  encryptionMode                String   @default("legacy") @map("encryption_mode") @db.VarChar(16)
}
```

---

## Relationship to Roadmap

| Roadmap Item | Relationship |
|---|---|
| #1 C: KDF metadata | Independent, do first |
| #2 G: Domain separation ledger | Must be updated with new key types |
| #3 F: Key retention policy | Must cover ItemKey + AttachmentKey lifecycle |
| #4 B: Revoke + session kill | Simplified by this architecture (rewrap only) |
| #8 A: Attachment key hierarchy | **This document IS the design for item #8** |
| #10 D: Argon2id | Independent, user-level only |
