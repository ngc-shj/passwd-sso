# Coding Deviation Log: ios-entry-detail-type-specific-fields

## D1 — Non-login type sections render only populated fields (skip empty)

**Plan reference**: Requirements → "Empty/absent fields render the existing muted 'Not set' placeholder (consistent with current LOGIN behavior)."

**Deviation**: For the 7 non-login type-specific sections, a field row is rendered ONLY when the field has a value (`optionalFieldRow` / `optionalSecretRow` skip empty/nil). LOGIN is unchanged — it still shows its fixed username/password/url/notes/TOTP rows with "Not set" for empties.

**Rationale**: IDENTITY has 20 fields and most are typically empty; rendering 15 "Not set" rows is poor UX and diverges from the web app, which renders type-specific fields conditionally. The "show all with Not set" idiom exists for LOGIN because LOGIN is editable on iOS and the rows mirror the edit form; non-login entries are read-only on iOS (C7), so empty rows carry no affordance. SECURE_NOTE keeps a single "Not set" when its body is empty (the note body is the entry's whole point, so its absence is worth showing).

**Impact**: Display-only; no contract/security change. Masking (SecretRow) and copy (copySecurely) behavior is identical to plan.

## D2 — Non-login footer caption

**Plan reference**: C7/F11 — scope the LOGIN edit-preservation footer to `.login`; "(optionally a neutral 'Edit this entry in the web app')" for non-login.

**Deviation**: Implemented the optional path — non-login entries show a neutral "Edit this entry in the web app." caption; LOGIN keeps its original edit-preservation caption. Within plan latitude.

## D3 — Decoder type-gating uses raw string comparison, not EntryTypeCategory

**Plan reference**: C2 — "When `entryType` resolves (via `EntryTypeCategory.from`) to a non-login type…"

**Deviation**: `EntryBlobDecoder` lives in the `Shared` target; `EntryTypeCategory` lives in the app target and is not importable from Shared. The decoder therefore gates sub-struct construction on the raw `entryType` string (`entryType == "CREDIT_CARD"` etc.) directly. Same behavior; the raw strings are the same server constants `EntryTypeCategory` maps. The view layer still uses `EntryTypeCategory.from` for dispatch.
