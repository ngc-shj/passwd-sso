# Plan: fix-custom-field-label-optional

## Project context

- **Type**: web app (Next.js 16 App Router, E2E-encrypted password manager)
- **Test infrastructure**: unit + integration (`vitest`) + E2E (Playwright) + CI/CD
- **Verification environment constraints**:
  - `verifiable-local`: the payload-builder round-trip (build → JSON shape) is a pure function testable in `vitest` with no external service. This is the core of the fix and is fully verifiable locally.
  - `verifiable-local`: detail-render + edit-rehydrate of a label-less custom field is testable via component render / `mapDecryptedBlobToDetailFields` unit test.
  - `blocked-deferred`: none. The bug and fix are entirely client-side pure logic; no paid-tier API, no hardware attestation, no cross-tenant billing needed.

## Objective

**Re-scoped (essence shift, 2026-07-07):** the reported symptom was "a label-less URL custom field disappears on update," but the user identified the true problem as broader — **any content the user typed into a custom field is silently discarded on save** (no error, success toast shown). The objective is therefore: **never silently drop user-entered custom-field content on save.** A field is persisted whenever the user has entered anything into it (a label OR a value); only a completely **untouched** row (the phantom row created by clicking "Add field" and never filling it) is dropped.

Original framing → new framing:
- Was: "make the field label optional so a value-only field is kept."
- Now: "keep any touched field; drop only untouched rows." This subsumes the original bug (value present, label absent → kept) AND the mirror case (label present, value absent → kept), eliminating silent data loss in both directions.

## Root cause (verified)

`filterNonEmptyCustomFields` in [entry-form-helpers.ts:26-30](../../../src/lib/vault/entry-form-helpers.ts#L26-L30):

```ts
export function filterNonEmptyCustomFields<T extends CustomFieldLike>(
  fields: T[]
): T[] {
  return fields.filter((field) => field.label.trim() && field.value.trim());
}
```

The predicate requires **both** `label.trim()` AND `value.trim()`. A URL (or any-type) field with a filled value but empty label fails the `label.trim()` conjunct → it is stripped from `validCustomFields` → never serialized into the encrypted blob → absent from detail and edit.

**Verification performed:**
- Full E2E crypto round-trip test (build payload → encrypt overview with AAD → decrypt via `decryptPersonalOverview` → sort/search) confirmed the *entry* does NOT disappear and nothing throws — the overview blob is `{"title":...,"urlHost":null,"tags":[],...}` and is benign. This ruled out the decrypt-skip / sort-crash hypotheses.
- User confirmed the symptom is **the URL field itself is missing**, not the entry — consistent with the field being filtered out at save.
- Confirmed the detail renderer [login-section.tsx:123-142](../../../src/components/passwords/detail/sections/login-section.tsx#L123-L142) renders a field with an empty `label` correctly (empty `<label>` + value/URL anchor), so a label-less field is fully displayable once persisted.

## Member-set derivation (R42)

The class is "every save path that drops user-entered custom-field data." Defining primitive: callers of `filterNonEmptyCustomFields`.

```
grep -rn "filterNonEmptyCustomFields" src/ | grep -iv test
```

Result (set A):
- `src/lib/vault/personal-entry-payload.ts:47` — personal login payload builder
- `src/lib/team/team-entry-payload.ts:182` — team login payload builder
- `src/lib/vault/entry-form-helpers.ts:26` — the definition itself

Both consumer call sites (personal + team) use the identical helper, so fixing the helper fixes both. **The fix is centralized in the helper** — no per-caller change needed. Indirect members checked:
- Import path (`password-import-payload.ts:225`) writes `customFields` **without** this filter (it passes through parser output), so import is not affected and not in scope.
- No raw-SQL or aliased-wrapper writers of custom fields exist.

## Field-type analysis (all CUSTOM_FIELD_TYPE values considered)

Per user instruction, the emptiness predicate must be correct for **every** type in [custom-field.ts](../../../src/lib/constants/vault/custom-field.ts):

| Type | value domain | "has data" predicate | Notes |
|------|-------------|---------------------|-------|
| TEXT | free string | `value.trim() !== ""` | |
| HIDDEN | free string (masked) | `value.trim() !== ""` | |
| URL | free string | `value.trim() !== ""` | the reported case |
| DATE | `"YYYY-MM-DD"` or `""` | `value.trim() !== ""` | UI clears value to `""` on type-switch |
| MONTH_YEAR | `"YYYY-MM"` or `""` | `value.trim() !== ""` | same |
| BOOLEAN | always `"true"` \| `"false"` | **special** — see below | UI defaults value to `"false"` on add / type-switch ([entry-custom-fields-totp-section.tsx:97-98](../../../src/components/passwords/entry/entry-custom-fields-totp-section.tsx#L97-L98)) |

**"Touched" is the unifying predicate.** A row is *touched* if the user entered anything into it. Drop only *untouched* rows.

**Non-boolean types** (text/hidden/url/date/monthYear): touched iff `label.trim() !== "" || value.trim() !== ""`. A value-only field (the reported bug) is kept; a label-only field (mirror case) is kept; a blank row is dropped.

**BOOLEAN**: `value` is never empty (`"false"` by default), so `value.trim()` cannot distinguish touched from untouched. A boolean is *touched* iff the user labelled it OR turned it on: `label.trim() !== "" || value === "true"`. A freshly-added, unlabelled, still-`false` boolean is the untouched/noise case and is dropped. (A label-less boolean would render as an empty-caption "はい/いいえ" with no meaning — dropping the untouched one avoids that; a user who turns it on without a label has still expressed intent and it is kept, accepting the empty caption as the cost of not losing their input.)

**Resolved rule (single predicate):**

```
keep(field) :=
  type === BOOLEAN
    ? (label.trim() !== "" || value === "true")     // boolean: touched = labelled or turned on
    : (label.trim() !== "" || value.trim() !== "")  // others: touched = has label or value
```

This is the user-confirmed design (2026-07-07): "入力があれば保存、未入力行のみ破棄" — keep if there is any input, drop only untouched rows. It fixes the reported bug and eliminates silent data loss in both directions, while still discarding the phantom empty row from clicking "Add field".

## Technical approach

Replace the single-predicate filter with a type-aware predicate. The helper is generic over `CustomFieldLike` (`{label, value}`) but the type-aware rule needs `type`. Options:

- **A (chosen)**: widen `CustomFieldLike` consumers to pass `type`. The two real callers already pass `EntryCustomField[]` (which has `type: CustomFieldType`). Extend `CustomFieldLike` to `{ label: string; value: string; type?: CustomFieldType }` and branch on `type`. When `type` is absent (defensive), fall back to the non-boolean rule (`value.trim() !== ""`).
- B: keep `filterNonEmptyCustomFields` label-agnostic (`value.trim()` only) and handle boolean noise elsewhere. Rejected: scatters the rule.

Chosen: A — one function, one rule, both callers fixed.

## Contracts

### C1 — `filterNonEmptyCustomFields` "keep-if-touched" predicate

- **Signature**: `filterNonEmptyCustomFields<T extends CustomFieldLike>(fields: T[]): T[]` (unchanged). `CustomFieldLike` becomes `{ label: string; value: string; type?: CustomFieldType }`.
- **Invariants** (app-enforced):
  - INV-C1.1: a non-boolean field with non-empty `value.trim()` is **kept** regardless of `label`. (Fixes the reported bug.)
  - INV-C1.2: a non-boolean field with non-empty `label.trim()` is **kept** regardless of `value`. (Fixes the mirror case — no silent loss of a label-only field.)
  - INV-C1.3: a non-boolean field with empty `label.trim()` AND empty `value.trim()` is **dropped** (untouched phantom row).
  - INV-C1.4: a boolean field is kept iff `label.trim() !== "" || value === "true"`; dropped iff empty label AND `value === "false"` (untouched).
  - INV-C1.5: field ordering is preserved (filter, not reorder).
  - INV-C1.6: no field object is mutated (pure filter; same references returned).
  - INV-C1.7: when `type` is absent (defensive — no production caller omits it), fall back to the non-boolean branch.
- **Forbidden patterns**:
  - pattern: `field.label.trim() && field.value.trim()` — reason: the exact both-required (AND) predicate that caused the data loss must not remain.
- **Acceptance criteria** (each is one unit test; every type appears ≥ once; whitespace + ordering covered):
  - `[{label:"", value:"https://example.com", type:"url"}]` → **kept** ← reported repro; MUST fail against current predicate.
  - `[{label:"note", value:"", type:"text"}]` → **kept** (label-only, mirror case).
  - `[{label:"", value:"secret", type:"hidden"}]` → **kept** (HIDDEN with value).
  - `[{label:"", value:"2026-01-01", type:"date"}]` → **kept**.
  - `[{label:"", value:"2026-03", type:"monthYear"}]` → **kept**.
  - `[{label:"", value:"", type:"text"}]` → **dropped** (untouched).
  - `[{label:"   ", value:"   ", type:"text"}]` → **dropped** (whitespace-only both → untouched).
  - `[{label:"", value:"   ", type:"text"}]` → **dropped** (whitespace-only value, no label; guards `value.trim()` vs `value !== ""`).
  - `[{label:"", value:"true", type:"boolean"}]` → **kept** (turned on).
  - `[{label:"", value:"false", type:"boolean"}]` → **dropped** (untouched boolean).
  - `[{label:"agreed", value:"false", type:"boolean"}]` → **kept** (labelled).
  - `[{label:"a", value:"1"}, {label:"", value:"", type:"text"}, {label:"", value:"2", type:"url"}]` → returns `[{label:"a",...}, {label:"",value:"2",...}]` in that ORDER (mixed keep/drop, survivor order asserted, INV-C1.5).
- **Consumer-flow walkthrough**:
  - Consumer `buildPersonalEntryPayload` (path: `src/lib/vault/personal-entry-payload.ts:47`) reads the returned `validCustomFields` and (a) serializes them into `fullBlob.customFields` when length>0, and (b) derives `additionalUrlHosts` from those whose `type==="url" && value`. After the fix, a label-less URL field is now in `validCustomFields`, so it correctly appears in the blob AND newly contributes to `additionalUrlHosts` (desirable — the host becomes searchable/iconable). No field the consumer reads is removed; only `type` is now consulted, which `EntryCustomField` already carries.
  - Consumer `buildTeamEntryPayload` (path: `src/lib/team/team-entry-payload.ts:182`) reads `validFields` and serializes into `entryFields.customFields` when length>0. Same shape; `type` already present on `EntryCustomField`. Label-less value fields now persist identically to the personal path.
  - Consumer (read-back) `mapDecryptedBlobToDetailFields` (path: `src/lib/vault/map-detail-fields.ts:37`) and `login-section.tsx` render each field's `{label, value, type}`; an empty `label` renders an empty `<label>` element — already tolerated. No consumer requires a non-empty label.

### C2 — `parseUrlHost` returns `null` for empty hostname (security S1)

- **Signature**: `parseUrlHost(value: string): string | null` (unchanged).
- **Invariants**:
  - INV-C2.1: a URL whose parsed `hostname` is `""` (e.g. `javascript:alert(1)`, `data:...`, `mailto:x`) returns `null`, not `""`.
  - INV-C2.2: well-formed http(s) URLs return their hostname unchanged.
- **Forbidden patterns**:
  - pattern: `return new URL(value).hostname;` — reason: must not return the bare hostname without the empty-string→null guard.
- **Acceptance criteria**:
  - `parseUrlHost("javascript:alert(1)")` → `null` (was `""`).
  - `parseUrlHost("https://example.com")` → `"example.com"`.
  - `parseUrlHost("")` → `null` (unchanged).
- **Rationale**: with C1 now keeping label-less URL fields, a dangerous-scheme URL value reaches `additionalUrlHosts` derivation (`personal-entry-payload.ts:49-56`). Today that would push `""` into the array. Inert at every consumer (verified by security review) but a data-hygiene wart; this is the correct normalization regardless. Low cost, folded in here.

## Testing strategy

- **Unit tests for `filterNonEmptyCustomFields`** covering every C1 acceptance row (one behavioral assertion per test). The repro row (`{label:"", value:"https://example.com", type:"url"} → kept`) is the failing-first regression guard — it MUST be verified to FAIL against the current `label.trim() && value.trim()` predicate before implementing (per common/testing "regression test fails before the fix").
- **Rewrite existing tests that encode the OLD drop-on-empty-label behavior** (these WILL go red — enumerated from review, R42 test member-set):
  - `src/lib/vault/entry-form-helpers.test.ts:52-62` — asserts `{label:"",value:"456"}` and `{label:"  ",value:"trimmed"}` dropped; both now KEPT (label-only "  " trims to empty but value present → kept; `{label:"",value:"456"}` value present → kept). Rewrite `.toEqual` to the new contract.
  - `src/lib/vault/personal-entry-payload.test.ts:80-96` — `{label:"",value:"skip",type:"text"}` now KEPT → `customFields.length` becomes 2 (was 1). Update.
  - `src/lib/team/team-entry-payload.test.ts:6-35` — `{label:"",value:"c",type:"text"}` now KEPT → `customFields` length 2 (was 1). Update + assert the kept field is present.
- **Payload-level test** (`buildPersonalEntryPayload`): a label-less URL field whose host ≠ the entry's main `url` host → assert `fullBlob.customFields` contains it AND `overviewBlob.additionalUrlHosts` contains the new host. (Host must differ from the main URL host — equal hosts are excluded at `personal-entry-payload.ts:54`, else the assertion vacuously passes.)
- **Team payload parallel test**: `buildTeamEntryPayload` (login) with a label-less value field persists it in `fullBlob.customFields`.
- **`parseUrlHost` C2 tests**: dangerous-scheme → null; http(s) → hostname; empty → null.
- **No E2E** (T7): pure logic is fully unit-covered. Optional lightweight `login-section` render test asserting a `{label:"", value:"https://…", type:"url"}` field renders its URL anchor — closes the only untested link (detail-render of a label-less field); acceptable to defer.

## Considerations & constraints

- **Scope contract**:
  - SC1 — Import path custom-field handling (`password-import-payload.ts`) is out of scope; it does not use `filterNonEmptyCustomFields` and has no reported defect. Owned by any future import-validation work.
  - SC2 — Adding a "required label" affordance to the UI is explicitly NOT the chosen direction (user chose label-optional); not in scope.
  - SC3 — Migration/backfill of already-lost data is impossible (the data never reached the server — E2E, client-dropped before encryption). No backfill contract; nothing to migrate. Users must re-enter previously-dropped fields.
- **Boolean default noise**: the boolean rule (INV-C1.4) is a deliberate behavior refinement, not strictly part of the reported bug. Included because (a) the user asked to consider all types, and (b) a naive "keep if value non-empty" would persist every default-`false` boolean row as noise. User-confirmed direction: keep only touched booleans (labelled or turned on).
- **Essence-shift record (2026-07-07)**: original scope was "fix label-less URL field disappearing"; re-scoped mid-plan to "no silent discard of user-entered custom-field content" after the user clarified the underlying objection. Trigger: the fix's true class is broader than the seed instance (the reported URL case is one member of "any touched field silently dropped"). Both callers and both empty-directions (value-only, label-only) are now in scope. This is why the diff (predicate + boolean handling + 3 test rewrites + parseUrlHost) is larger than a one-line URL fix.

## User operation scenarios

1. Edit a personal login → add additional field, type URL, leave label(名称) blank, paste `https://example.com` → Update → re-open: the URL field is present in detail and edit. (The reported bug.)
2. Add a text additional field with a value but no label → persists.
3. Add a text field, type a label, leave value blank → persists (mirror case; no silent loss of a labelled-but-unfilled row).
4. Add a boolean field, leave it off (false) and unlabeled → dropped (untouched noise row).
5. Add a boolean field, turn it on (true), no label → persists.
6. Add a field and touch nothing (blank label + blank value) → dropped (unchanged from today).
7. Same scenarios in a team login entry → identical behavior.

## Go/No-Go Gate

| ID  | Subject                                              | Status |
|-----|------------------------------------------------------|--------|
| C1  | `filterNonEmptyCustomFields` keep-if-touched predicate | locked |
| C2  | `parseUrlHost` empty-hostname → null (S1)             | locked |
