# Plan: Structured identity fields (split name + address) for autofill

Date: 2026-05-31
Intended branch: `feature/structured-identity-fields` — cut from **main after #504 merges** (#504 touches the extension identity detector/fill; this builds on it).
Status: PLAN ONLY — implementation deferred until #504 is merged.

## Project context

- **Type**: mixed — app (data model + editor UI + i18n) and browser extension (detector + fill). **iOS is OUT of scope** (iOS has no IDENTITY support at all yet — `VaultEntryDetail` is LOGIN-only — so changing the identity blob shape does not affect it; structured fields are simply available whenever iOS adds identity later).
- **Test infrastructure**: app Vitest (`npx vitest run`) + extension Vitest (`cd extension && npm test`).
- **Encryption constraint**: identity data lives in the **E2E-encrypted blob** (`PasswordEntry.encryptedBlob`). The server cannot read or migrate it. Any model change must be **client-side and non-destructive**.

## Objective

Identity entries today store **monolithic** `fullName` and `address` strings, so the extension cannot fill real-world forms that split name into given/family and address into line1/line2/city/state/postal/country (it dumps the whole `fullName` into one field, and the extension's `postalCode` autofill slot is a **dead field** — the app never stores a postal code). Add **structured** identity fields so split forms fill correctly, while keeping existing monolithic entries working unchanged (no forced migration).

### Confirmed current state
- App identity fields (`src/components/entry-fields/identity-fields.tsx`, `src/lib/team/team-entry-payload.ts` + the personal equivalent): `fullName`, `address`, `phone`, `email`, `nationality`, `idNumber`, `issueDate`, `expiryDate`. **No** split name, **no** `postalCode`/city/state/country.
- Extension (`identity-form-detector-lib.ts` / `autofill-identity-lib.ts`): detects `name`, `address-line1`, `postal-code`, `address-level1`(region), `tel`, `email`, `bday`; the `IdentityAutofillPayload.postalCode` is sent but the app has no source field → always empty (dead).

## Requirements

### Functional
1. An identity entry can store structured fields: **given name / family name** (+ optional middle), and **address-line1 / address-line2 / city / state-or-prefecture / postal-code / country**, plus the existing phone/email/nationality/idNumber/issue/expiry.
2. The extension fills split forms field-by-field using the structured data (HTML `autocomplete` tokens: `given-name`, `family-name`, `address-line1`, `address-line2`, `address-level2`=city, `address-level1`=state/prefecture, `postal-code`, `country-name`), and still fills combined `name`/`address-line1` fields.
3. **Back-compat (no forced migration)**: existing entries that only have `fullName`/`address` continue to fill — combined-name form gets `fullName`; a structured form gets a best-effort fallback (fill the combined name field if present; otherwise leave split name blank rather than mis-splitting). On next edit the user can populate structured fields.
4. The `postalCode` dead-field discrepancy is resolved (now backed by a real stored field).

### Non-functional
5. **Additive, non-destructive** blob schema: keep `fullName`/`address` as optional fields; add structured fields alongside. No DB migration of encrypted blobs. (Pre-1.0; per [[feedback_no_reflexive_migration_warnings]] avoid migration shims — additive read/write is enough.)
6. New strings in BOTH `messages/en.json` + `messages/ja.json` and the extension's `src/messages/{en,ja}.json`; no internal jargon ([[feedback_no_internal_jargon_in_user_strings]]). Convert any 3+ enumerated field-key literal lists to a const-object per [[feedback_const_object_for_string_literals]].

### Sub-decisions (RESOLVED by user)
- **Kana (フリガナ): INCLUDED in v1** — store + detect + fill `familyNameKana`/`givenNameKana` (regex-only detection, no autocomplete token; see C3). JP address granularity is covered by standard `address-level1`=都道府県 / `address-level2`=市区町村.
- **HIDE_PASSWORD masks address + postal** (see C7).

## Contracts

### C1 — Identity blob field set (app data model) — FULL touch-list
- Add optional fields: `givenName`, `familyName`, `middleName?`, **`familyNameKana`, `givenNameKana`** (フリガナ — user decision: include in v1), `addressLine1`, `addressLine2`, `city`, `state`, `postalCode`, `country`. **Keep** `fullName`, `address` as optional (legacy/back-compat + combined-form fill). Define the key set ONCE as a const-object (proposed: `src/lib/constants/identity-fields.ts`) imported by every site below ([[feedback_const_object_for_string_literals]]).
- **Kana note**: HTML `autocomplete` has no standard kana token, so kana detection/fill is regex-only (JP field hints: フリガナ / カナ / かな / セイ / メイ) — see C3. Kana fields are stored + filled best-effort; their absence on a form is normal (no fallback needed).
- **Write (persist) sites — BOTH paths**:
  - Team: `src/lib/team/team-entry-payload.ts` IDENTITY case (`:94-105` blob, `:200-207` overview).
  - **Personal builds its blob INLINE** in `src/components/passwords/personal/personal-identity-form.tsx:217-241` (`handleSubmit`) — there is NO personal payload builder today (`personal-entry-payload.ts` is LOGIN-only). **F1: either update this inline builder OR (preferred) extract `buildPersonalIdentityPayload` for SSoT** — do not assume a builder exists.
- **Read (hydrate) sites — all must gain the new fields, else round-trip/edit silently drops them (F5/R25)**: `IdentityFormProps.initialData` (personal-identity-form.tsx), `VaultEntryFull` type (`personal-password-edit-dialog-loader.tsx`), team blob mapping (`team-edit-dialog-loader.tsx:100-108`), `InlineDetailData` + `FullEntryData` (`src/types/entry.ts`), the read-only display (`src/components/passwords/detail/sections/identity-section.tsx`), and `src/components/share/share-entry-view.tsx`.
- **F4 overview label composition (explicit acceptance)**: a structured-only entry (no `fullName`) must not show a blank dropdown/list label. In BOTH overview builders, write the name slot as `fullName ?? (givenName + " " + familyName).trim()`. Compute at WRITE time (the overview is encrypted before it reaches the extension — cannot compose downstream).
- **Invariant**: writes are additive; saving structured persists structured fields; the extension/app prefer structured and fall back to `fullName`/`address` only when structured is absent.
- **Acceptance**: a saved structured identity round-trips ALL fields through encrypt→decrypt on BOTH personal and team paths; a legacy entry still loads, edits, and re-saves without losing data; a structured-only entry shows a composed label.

### C2 — Identity editor UI (app)
- **File**: `src/components/entry-fields/identity-fields.tsx` (+ the team/personal form loaders that pass props/labels).
- Render structured inputs grouped (Name: given/family; Address: line1/line2/city/state/postal/country) plus existing phone/email/nationality/idNumber/issue/expiry. Keep a sensible layout (TwoColumnFields where it fits).
- **Back-compat display**: when editing a legacy entry, show its `fullName`/`address` in the combined inputs (keep a combined "full name" / "address" input available), OR pre-split heuristically ONLY as an editable suggestion the user confirms — do NOT silently overwrite. (Reviewers: decide combined-inputs-retained vs heuristic-prefill; prefer retaining a combined field to avoid lossy auto-split.)
- **Acceptance**: editing a new entry captures structured fields; editing a legacy entry shows its data without loss.

### C3 — Extension detector: split tokens
- **File**: `extension/src/content/identity-form-detector-lib.ts`
- Add detection for `given-name`, `family-name`, `address-line2`, `address-level2`(city), `country-name` (keep existing `name`, `address-line1`, `address-level1`, `postal-code`, `tel`, `email`, `bday`), with EN+JA regex fallbacks (姓/名/市区町村/都道府県/国). Reuse shared visibility/usable helpers (no duplicate copies — see the [[project_extension_parallel_impl]] `-lib`/`.js` pairing; edit both).
- **Kana fields (regex-only, no autocomplete token)**: detect `familyNameKana`/`givenNameKana` via JP hints — name/id/placeholder/label containing フリガナ / カナ / かな combined with セイ/姓 (family) vs メイ/名 (given). Order-sensitive; when only a single combined kana field exists, fill the composed kana. Guard against false-matching the non-kana 姓/名 fields (a kana field's hint contains フリガナ/カナ/かな; a plain name field does not).
- **Acceptance**: a split form's given/family/city/state/postal/country fields are all detected; a JP form's フリガナ セイ/メイ fields are detected as kana (and NOT confused with the plain 姓/名 fields).

### C4 — Extension payload + fill (structured, with monolithic fallback)
- **Files**: `extension/src/types/messages.ts` (`IdentityAutofillPayload` — add the structured fields), **`extension/src/background/index.ts`** (F3: the IDENTITY blob-parse type at ~1394 AND the `sendFillMessage` construction at ~1438 — both must read+send the new fields; missing either sends empty strings), `extension/src/content/autofill-identity-lib.ts` + `autofill-identity.js` (edit BOTH — hand-maintained twins, F7).
- Payload carries structured fields; `performIdentityAutofill` fills each detected split field from the structured value when present; **fallback**: if the entry has no structured name, fill a combined `name` field from `fullName`; if no structured address, fill `address-line1` from `address`. **Never mis-split** a monolithic value into separate fields (forbidden pattern).
- Resolves the `postalCode` dead-field (now sourced from the stored field).
- `idNumber` stays NOT a fill target (no autocomplete token; high-risk to fill into arbitrary forms) — do not add it (S6).
- **Acceptance**: structured entry fills a split form fully (each field asserted by distinct value); legacy entry fills a combined form; legacy entry on a split form fills name-into-combined-if-present and leaves split given/family EMPTY (no garbage).

### C6 — Export / Import round-trip (F6)
- **Files**: `src/lib/format/export-format-common.ts:226-248` (identity block) + the import re-builder (`src/components/passwords/import/password-import-*`).
- Add the structured fields to the exported identity object and read them back on import, so export→import preserves structured data (today it would silently drop them).
- **Acceptance**: an entry with structured fields exported then imported retains all structured fields.

### C7 — Share-permission field classification (S2)
- **File**: `src/lib/constants/auth/share-permission.ts` (+ verify `src/components/share/share-dialog.tsx` `INTERNAL_FIELDS`).
- **`OVERVIEW_FIELDS.IDENTITY`** (currently `title/fullName/email`): explicitly keep address components OUT — only the name label + email belong in the overview tier.
- **`HIDE_PASSWORD.IDENTITY`** (currently masks only `idNumber`): **user decision — also mask `addressLine1`, `addressLine2`, `postalCode`** under HIDE_PASSWORD (a residential address is as sensitive as the ID number). Add them to the set.
- **`SENSITIVE_FIELDS.IDENTITY`**: review whether address components count as sensitive for the share matrix.
- **Invariant**: structured address PII never lands in the overview blob (S1); add a test asserting the overview builder output has no address-component keys.
- **Acceptance**: sharing an identity entry under each permission level handles the new fields per the explicit classification; address PII absent from overview.

### C5 — i18n
- **Files**: app `messages/{en,ja}.json` + extension `src/messages/{en,ja}.json`. Add labels/placeholders for the new fields in both locales; JA uses natural terms (姓/名/住所1/住所2/市区町村/都道府県/郵便番号/国). No internal jargon.
- **Acceptance**: both locales have all new keys; any key-coverage check passes.

### Forbidden patterns
- pattern: a heuristic that silently splits `fullName` on whitespace into given/family at SAVE or FILL time without user confirmation — reason: lossy, locale-broken for JP; back-compat must not corrupt data.
- pattern: scattered identity-field-name string literals (use the shared const-object/keys).
- pattern: editing `autofill-identity-lib.ts` without the matching `autofill-identity.js` (or vice-versa) — keep the `-lib`/`.js` pair in sync.

## Testing strategy

- **App payload round-trip — BOTH paths (T1)**: team identity payload test extended for structured fields (`team-entry-payload.test.ts`); AND a personal identity round-trip test (currently NONE — the personal path is inline-built and untested). Assert every structured field appears in `fullBlob` and that the overview composes the name label.
- **Extension detector (T5)**: split form with `given-name`/`family-name`/`address-line2`/`address-level2`/`country-name` (+ existing) — all detected; combined form still detected.
- **Extension fill — non-vacuous (T2)**: structured entry → split form, using a DISTINCT value per field, assert each lands in its correctly-typed field (`givenName`→given-name, `familyName`→family-name, `city`→address-level2, `state`→address-level1, `postalCode`→postal-code, `country`→country-name). Generic/same values would mask routing bugs.
- **Back-compat no-mis-split (T3, guards the forbidden pattern)**: legacy entry (only `fullName`/`address`) on a split form (given-name+family-name present, NO combined `name`) → assert both split fields remain EMPTY.
- **postalCode fix (T4)**: background IDENTITY `AUTOFILL_FROM_CONTENT` fill test with a blob carrying `postalCode` → assert the payload's `postalCode` is non-empty.
- **Dropdown label fallback (T6)**: overview with only `givenName`/`familyName` (no `fullName`) → `GET_IDENTITY_MATCHES_FOR_URL` response `username` equals the composed `"Given Family"`.
- **Kana (v1)**: round-trip familyNameKana/givenNameKana through save→load; detector picks フリガナ セイ/メイ fields WITHOUT matching the plain 姓/名 fields; fill routes kana values to kana fields only.
- **Share (C7)**: overview builder output contains no address-component keys; share under HIDE_PASSWORD masks `idNumber` AND `addressLine1`/`addressLine2`/`postalCode` (assert these are absent/masked in the HIDE_PASSWORD share payload).
- **i18n (T7)**: extend `src/__tests__/i18n/entry-form-translation-keys.test.ts` (currently checks only 2 IdentityForm keys) to full en↔ja parity for the IdentityForm namespace; extension `src/messages/{en,ja}.json` parity is auto-covered.
- **R19/mock alignment**: every IDENTITY background-test mock blob must carry the new fields; `identity-fields.test.tsx` fixture props updated (T9).
- Both app (`npx vitest run`) + extension (`cd extension && npm test`) suites + both builds green.
- Manual: edit an identity entry with structured fields; on a split checkout/address form confirm given/family/city/state/postal/country all fill.

## Considerations & constraints

- **No forced migration** of existing encrypted entries (server can't read them). Additive schema + monolithic fallback fill means legacy entries keep working; they gain structured data only when the user edits them. Document this; do not add a migration shim.
- **JP locale**: v1 covers 姓/名 + JP address components via standard `autocomplete` levels; **kana (フリガナ) deferred** — flag explicitly so it isn't mistaken for a gap.
- **iOS out of scope** — no identity support there; structured fields await a future iOS identity feature.
- Keep the dropdown label logic working (label from `fullName` or composed `givenName + familyName`).

## User operation scenarios

1. New identity entry: user enters given/family + split address → on a split checkout form, every field fills.
2. Legacy identity entry (only fullName/address) on a combined `name`+`address-line1` form → fills as today.
3. Legacy entry on a split form → fills the combined name field if one exists; split given/family left blank (no garbage); user can edit the entry to add structured data.
4. JP address form (郵便番号/都道府県/市区町村/番地) → postal/prefecture(level1)/city(level2)/line1 fill from structured fields.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Identity blob structured fields (additive) + FULL write/hydrate touch-list + personal inline builder + overview label composition | locked |
| C2 | Editor UI for structured fields + non-lossy legacy display | locked |
| C3 | Extension detector: split autocomplete tokens | locked |
| C4 | Extension payload + fill (structured + monolithic fallback, no mis-split); background read+send; postalCode fixed | locked |
| C5 | i18n (app + extension, en + ja) + IdentityForm parity test | locked |
| C6 | Export/Import round-trip preserves structured fields | locked |
| C7 | Share-permission classification (overview exclusion + HIDE_PASSWORD masking decision) | locked |

**Scope note**: this is materially larger than first drafted — ~15 files across both personal+team paths, plus the share feature and export/import. The core design is unchanged (additive, no migration, monolithic fallback); the growth is propagation completeness.
