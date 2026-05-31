# Plan Review: structured-identity-fields

Date: 2026-05-31
Review round: 1

Core design (additive blob fields, no forced migration, monolithic fallback, iOS out) confirmed sound by all three experts. Findings are about **enumeration/propagation completeness** (the recurring [[project_integration_test_gap]] / R3 gap) and the **share feature** as an unlisted downstream consumer.

## Functionality
- **F1 [Critical]** — personal identity path builds blob INLINE in `src/components/passwords/personal/personal-identity-form.tsx:217-241` (`handleSubmit`), NOT via a builder. There is NO personal identity payload builder (`personal-entry-payload.ts` is LOGIN-only). Plan must name this site; prefer extracting `buildPersonalIdentityPayload` for SSoT.
- **F2 [Critical]** — `postalCode` fix requires propagation through every site (both blob builders, form inputs, `IdentityFormProps.initialData`, `VaultEntryFull` loader type, team-edit-dialog-loader mapping, `InlineDetailData`/`FullEntryData` in `src/types/entry.ts`, export). Enumerate all.
- **F3 [Major]** — C4 must list `extension/src/background/index.ts` (IDENTITY blob parse type ~1394 + `sendFillMessage` construction ~1438) in addition to messages.ts.
- **F4 [Major]** — structured-only entry (no `fullName`) → blank dropdown label. Compose `givenName + " " + familyName` into the overview's name slot at WRITE time in BOTH overview builders (team-entry-payload.ts:200-207 + personal-identity-form.tsx:232-238); NOT in the extension (overview is encrypted before it arrives). Make it an explicit acceptance criterion.
- **F5 [Major]** — enumerate all hydrate/read sites: `IdentityFormProps.initialData`, `VaultEntryFull` (personal-password-edit-dialog-loader), team-edit-dialog-loader blob mapping, `InlineDetailData`+`FullEntryData` (src/types/entry.ts), `identity-section.tsx` (read-only display), `share-entry-view.tsx`.
- **F6 [Major]** — export (`src/lib/format/export-format-common.ts:226-248`) + import (`password-import-steps.tsx`) drop structured fields silently → data loss on round-trip. New contract.
- **F7 [Minor]** — `autofill-identity.js` is a hand-maintained twin of `-lib.ts`; tests run against `-lib.ts` only. Require both edited + a parity smoke check.
- **F8 [Minor]** — v1 openapi.json may be stale (blobs are opaque; low impact).
- kana/フリガナ deferral: reasonable for v1; 姓/名 via given/family is the high-value win. Document the kana gap.

## Security
- **S2a [Medium]** — `share-permission.ts` `HIDE_PASSWORD.IDENTITY` masks only `idNumber`; a full address+postal is equally/more sensitive. Decide explicitly whether HIDE_PASSWORD masks `addressLine1/2`, `postalCode`.
- **S2b [Medium]** — `OVERVIEW_FIELDS.IDENTITY` (currently `title/fullName/email`) must explicitly EXCLUDE the new address components (only the name label belongs in overview).
- **S1/S7 [Med/Low]** — keep structured address OUT of the overview blob; if anything derived goes to overview, add to `share-dialog.tsx` `INTERNAL_FIELDS` defensively. Add a test asserting the overview builder output contains no address-component keys.
- **S3 [Low]** — `autofill-identity-lib.ts:48` `console.debug` logs the country/nationality value on select-mismatch; do NOT extend logging to address/postal values.
- **S4/S6 [Info]** — URL-independent identity fill is parity with native browser autofill + the card path (explicit selection + cross-origin guard already present) → no extra gate. `idNumber` intentionally not a fill target → keep it out of C4 fill targets.
- Encryption: confirmed — all new fields go into the encrypted `fullBlob` only; server never sees plaintext. No new plaintext/log path.

## Testing
- **T1 [Critical]** — add personal payload IDENTITY round-trip test (the path is currently untested + inline-built).
- **T2 [Critical]** — structured fill test MUST use DISTINCT per-field values and assert each lands in its correctly-typed field (given→given-name, family→family-name, city→address-level2) — else vacuous.
- **T3 [Critical]** — legacy entry on a split form (given-name/family-name present, no combined name) → assert both remain EMPTY (guards the no-mis-split forbidden pattern).
- **T4 [Major]** — background IDENTITY `AUTOFILL_FROM_CONTENT` fill test proving `postalCode` is non-empty when stored.
- **T5 [Major]** — detector tests for the new tokens (given-name/family-name/address-line2/address-level2/country-name).
- **T6 [Major]** — dropdown composed-label test (overview with only givenName/familyName → username = "Given Family").
- **T7 [Major]** — `src/__tests__/i18n/entry-form-translation-keys.test.ts:54` only checks 2 IdentityForm keys; add full en↔ja parity for the IdentityForm namespace.
- **T8/T9 [Minor]** — extend team payload identity test for structured fields; update `identity-fields.test.tsx` fixture props.
- R19 — all IDENTITY background-test mock blobs must carry the new fields or the new read path isn't exercised.

## Disposition
All adopted. Plan revised (round 2): enumerate full app touch-list incl. personal inline builder + hydrate types; add C6 (export/import), C7 (share-permission masking/overview exclusion); make overview-label composition an explicit acceptance; expand testing (distinct-value fill, no-mis-split, postalCode, detector tokens, label fallback, i18n parity, personal payload). Scope is materially larger than first drafted (~15 files + share + export/import) — surface to user before implementation.
