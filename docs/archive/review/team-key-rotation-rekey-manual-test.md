# Manual Test Plan: team-key-rotation-rekey

Tier-2 (crypto / key management). Run on the dev stack (`npm run docker:up`, app on its usual
port) with two browsers signed in as different team admins, plus a MinIO-backed run
(`BLOB_BACKEND=s3`) for the attachment steps.

## Pre-conditions

- A team with an OWNER (A), an ADMIN (B) and a MEMBER (M), all with distributed keys.
- Entries: one LOGIN created before this branch (v1, `item_key_id` backfilled), one legacy v0
  entry if available (else seed one), one entry with ≥ 3 history rows, one entry with a legacy
  mode-1 attachment and one with a new upload.
- Worker `audit-outbox-worker` running so audit rows reach the team audit-log page.

## Steps

1. M leaves the tenant (or is removed from the team). A rotates the team key on the Key Rotation
   page.
   - Expected: rotation succeeds; the report lists no carried entries; the "Finish re-key (N)"
     control shows N = all entries.
2. A runs Finish re-key.
   - Expected: progress reaches 0 pending; the v0 entry is upgraded first, the legacy attachment
     is migrated, every entry opens, every history row opens, both attachments download and open.
     The team audit log shows one `TEAM_ENTRY_REKEY` per entry and `TEAM_ATTACHMENT_MIGRATE` for
     the legacy attachment.
3. B opens an entry for edit before step 2 finishes and saves after A re-keyed it.
   - Expected: the save is refused with a "reopen and retry" message; after reopening, the save
     succeeds.
4. Restore a history row of a re-keyed entry.
   - Expected: restore succeeds; the list view still shows the entry's title and username
     (overview re-encrypted under the restored key); the entry is not pending.
5. Upload a new attachment to a re-keyed entry; download it in the other browser.
   - Expected: both succeed.
6. Close A's tab during a second pass (after another rotation); B runs Finish re-key.
   - Expected: B completes the remaining entries; pending reaches 0.

## Adversarial scenarios

- A1: Using M's pre-departure key material (an exported team key or an ItemKey captured from
  M's browser before step 1), attempt to decrypt an entry's blob, a history row and an attachment
  fetched after step 2. Expected: every decryption fails (AES-GCM authentication error).
- A2: Replay a captured pre-rotation re-key POST body (step-up satisfied) against an entry after
  step 2. Expected: 409 (`REKEY_NOT_PENDING` or `REKEY_SNAPSHOT_MISMATCH`), rows unchanged.
- A3: As M (re-added as MEMBER, no TEAM_UPDATE), call the re-key list/POST and attachment migrate
  routes directly. Expected: 403/404, nothing changes.
- A4: With an external backend, edit an attachment row's stored ref to point at another
  attachment's object (DB access), then download and migrate it. Expected: 409 `BLOB_REF_INVALID`,
  no object is read or deleted.
- A5: Send an `undecryptable` carry for an entry the actor does not hold a key for. Expected:
  409 `TEAM_ROTATE_CARRY_INVALID`.
- A6: Send a re-key POST whose new wrap reuses the entry's current wrap IV. Expected: 400
  `ITEM_KEY_IV_REUSED`.

## Rollback

The schema change is additive (new nullable / defaulted columns, one CHECK, new enum values).
To roll back the application, deploy the previous image: old code ignores the new columns, but
entries re-keyed by this version stay readable only if the old client handles ItemKey versions
above 1 (it does — it reads `itemKeyVersion` from the row) and mode-2 team attachments are NOT
readable by the old web client. Roll back only before any mode-2 team upload or migrate, or
accept that those attachments are unreadable until roll-forward. The DB columns do not need to be
dropped.
