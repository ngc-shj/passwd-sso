# Coding Deviation Log: itemkey-attachment-migration

Created: 2026-03-09

## Deviations from Plan

### DEV-1: getItemEncryptionKey fetches entry data from API instead of accepting props

- **Plan description**: `getItemEncryptionKey` accepts ItemKey metadata as parameter (not re-fetched from API) — parent component already has this from entry fetch
- **Actual implementation**: `getItemEncryptionKey(teamId, entryId)` fetches entry data from the existing `GET /api/teams/[teamId]/passwords/[id]` endpoint to obtain ItemKey metadata, then unwraps and caches
- **Reason**: Threading ItemKey metadata through 10+ form components (TeamLoginForm, TeamSecureNoteForm, TeamCreditCardForm, etc.) and PasswordDetailInline would require modifying TeamEntryFormEditData, TeamAttachmentSectionProps, and all parent components. The API fetch approach is self-contained — no prop drilling needed. The overhead is mitigated by caching (5-minute TTL).
- **Impact scope**: `src/lib/team-vault-core.tsx` — the function signature differs from plan. No impact on other files.

### DEV-2: Removed teamKeyVersion client-side validation

- **Plan description**: Keep teamKeyVersion check for encryptionMode=1 — validates the client is using the current TeamKey to unwrap ItemKey
- **Actual implementation**: Removed `teamKeyVersion` from FormData and server-side client-provided version check. Instead, the server uses the entry's own `teamKeyVersion` for the `keyVersion` field in the Attachment record.
- **Reason**: Under encryptionMode=1, the client encrypts with ItemKey (not TeamKey directly). The client doesn't have easy access to `teamKeyVersion` after the `getTeamKeyInfo()` call was replaced. The entry's `teamKeyVersion` is the authoritative source and is already validated when the entry was created/updated.
- **Impact scope**: `src/app/api/teams/[teamId]/passwords/[id]/attachments/route.ts`, `src/components/team/team-attachment-section.tsx` (no longer sends teamKeyVersion)
