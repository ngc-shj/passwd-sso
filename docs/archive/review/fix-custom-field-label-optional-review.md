# Plan Review: fix-custom-field-label-optional
Date: 2026-07-07
Review round: 1

## Changes from Previous Round
Initial review.

## Functionality Findings

**[F1] Minor — pre-existing**: `additionalUrlHosts` derivation (`personal-entry-payload.ts:52-54`) uses `f.value` (truthy) not `f.value.trim()`; a URL value with surrounding whitespace is serialized untrimmed. Pre-existing for labelled URL fields; not introduced by this fix. Note only.

**[F2] Minor — needs user sign-off**: The chosen rule DROPS label-only-empty-value non-boolean fields (`value.trim() !== ""` only). A user who adds a field, types a label, saves without a value, then re-opens → the row vanishes (mirror of the reported bug). NOT a new regression vs. today (today also drops it), but a persistent papercut the plan chose not to fix. Trade-off: dropping avoids persisting blank "added-and-forgotten" rows. Surface to user.

**[F3] Minor — needs user sign-off**: Boolean predicate `label.trim() !== "" || value === "true"` newly KEEPS an unlabeled `value==="true"` boolean (today both unlabeled true/false booleans are dropped). Correct and well-defined (boolean value is always `"true"`/`"false"`, verified), but a behavior addition beyond the literal reported URL bug. Surface to user per "no unrequested spec changes."

**[F4] Minor — non-blocking**: `CustomFieldLike` widening to `type?: CustomFieldType` makes the `type`-absent fallback branch unreachable from production (both callers pass required-`type` `EntryCustomField[]`). Mild YAGNI; optional to make `type` required. Harmless as-is.

Verified clean: member-set complete (only 2 callers, both LOGIN; non-login forms pass `customFields: []`; import path bypasses filter, correctly out of scope); read/edit-rehydrate needs no change; per-type predicate correct for all 6 types.

## Security Findings

**[S1] Minor — optional defensive fix**: `parseUrlHost("javascript:alert(1)")` returns `""` (not `null`), so a label-less dangerous-scheme URL field lands `additionalUrlHosts: ["", ...]` in the overview blob. Inert at every consumer (web favicon guards `!host` → Globe, no fetch; `normalizeFaviconHost("")` → null → server rejects; iOS `isHostMatch("", realhost)` → no false match). Pre-fix a label-less URL field was dropped, so the fix broadens reachability of an already-existing labelled-field class. Fix: `parseUrlHost` returns `null` for empty hostname (`return h || null`). Correct normalization regardless of this plan.

Cleared: no XSS/open-redirect (`isSafeHref` allowlist per-type, label-independent, `login-section.tsx:131`); no SSRF (favicon proxy allowlist + IP rejection + opt-in); no length-cap/DoS bypass (blob-level `CIPHERTEXT_MAX`/`MAX_JSON_BODY_BYTES` unchanged); no masquerade (value renderer keyed on `type`, not label); no authz path touched (pure client-side pre-encryption filter). Escalation: none.

## Testing Findings

**[T1] Critical**: `entry-form-helpers.test.ts:52-62` (`"keeps fields with non-empty label and value"`) asserts `{label:"",value:"456"}` AND `{label:"  ",value:"trimmed"}` are DROPPED. Both are KEPT under the new predicate → test goes red. Must be rewritten to the new contract (not just extended). The whitespace-label-with-value case is a distinct case absent from the plan's C1 table.

**[T2] Critical**: No failing-first regression test exists yet. The current test passes against the buggy predicate, so it is not a guard. Add a dedicated `it("keeps a label-less URL field (reported repro)")` asserting `{label:"", value:"https://example.com", type:"url"}` is kept; verify it FAILS on current `main` before implementing.

**[T3] Major**: C1 acceptance table gaps: (1) whitespace-only VALUE (`{label:"", value:"   ", type:"text"}` → drop; guards `value.trim()` vs `value !==""`); (2) HIDDEN type with value → keep (type absent from table); (3) multi-field mixed kept/dropped asserting survivor ORDER (INV-C1.4). Add these tests.

**[T4] Major**: `personal-entry-payload.test.ts:80-96` uses `{label:"",value:"skip",type:"text"}` and asserts `customFields.length === 1` (old behavior) → becomes 2 after fix; must update. New payload test must use a URL host ≠ the entry's main URL host or the `additionalUrlHosts` assertion vacuously passes (host equal to main is excluded, `personal-entry-payload.ts:54`).

**[T5] Major**: `team-entry-payload.test.ts:6-35` (`"builds login blobs ... non-empty custom fields only"`) feeds `{label:"",value:"c",type:"text"}` and asserts `customFields.toHaveLength(1)` → becomes 2 after fix; must update + add positive presence assertion. Each caller (personal + team) needs its own updated payload test — the shared helper test alone is insufficient for the serialization path.

**[T6] Minor — positive**: `filterNonEmptyCustomFields` is a pure exported function; `buildPersonalEntryPayload`/`buildTeamEntryPayload` return JSON synchronously with no crypto/DB deps. Directly unit-testable with plain literals; type widening preserves ergonomics.

**[T7] Minor**: No E2E for custom fields. Do NOT add E2E (over-investment for pure logic). Optional lightweight `login-section` render test with a label-less URL field to close the only untested link (detail-render of label-less field). Acceptable to defer.

## Adjacent Findings
- (F, adjacent → testing) regression guard must assert against old predicate — already covered by T1/T2, plan handles it.

## Quality Warnings
None flagged.

## Recurring Issue Check
### Functionality expert
- R42: PASS (key check) — member-set derived from `grep filterNonEmptyCustomFields` → 2 LOGIN callers, non-login forms pass `[]`, import bypasses filter. Complete.
- R1-R41: N/A (pure client-side logic; no DB/RLS/TOCTOU/AAD/migration/i18n/Bearer-route).
- Norm note: "no unrequested spec changes" — F2/F3 bundle behavior changes; user sign-off recommended.

### Security expert
- R1 injection: clear. R2 authz: N/A. R3 secrets-in-logs: clear. R4 length-cap: clear. R5 XSS/dangerous-scheme: clear (isSafeHref per-type). R6 SSRF: clear (favicon proxy allowlist; S1 empty-host rejected). R7-R41: N/A. R42: satisfied.
- RS1-RS5: N/A. Escalation: none.

### Testing expert
- R42 (test member-set): source callers enumerated (3 to fix) but existing tests asserting old behavior initially under-counted; now complete (3 tests: T1/T4/T5).
- RT4 / "regression test fails before fix": at risk → T2 adds it.
- RT1-RT3, RT5-RT7: no additional issues.

## Resolution Status (post-review + user re-scope)

**Essence shift (2026-07-07)**: The user re-scoped the objective from "keep label-less URL fields" to "never silently discard user-entered custom-field content." Confirmed design: keep any *touched* field (label OR value present, or boolean labelled/turned-on); drop only fully-untouched rows. This resolves F2 and F3 by user decision rather than deferral.

- **F1** (whitespace in URL value, pre-existing) — Skipped (pre-existing, unchanged file behavior for labelled fields too). Anti-Deferral: pre-existing in a file that IS in the diff. Justification: the field-value trimming is a separate cosmetic behavior; the fix does not touch value normalization. Cost to fix: low but out of the "no silent data loss" objective. **Orchestrator sign-off**: recorded as TODO(fix-custom-field-label-optional): trim URL custom-field value on save. Not blocking; no data loss.
- **F2** (drops label-only-empty-value) — **RESOLVED by re-scope**: INV-C1.2 now KEEPS label-only fields. The "symmetric surprise" the finding warned about is eliminated.
- **F3** (keeps unlabelled true boolean — unrequested spec change) — **RESOLVED by user sign-off**: user explicitly chose "入力があれば保存、未入力行のみ破棄," which includes keeping a turned-on boolean. INV-C1.4 encodes it. No longer an unrequested change.
- **F4** (`type?` fallback dead code) — Accepted as-is. Anti-Deferral (acceptable): worst case = one unreachable branch; likelihood = production callers always pass `type`; cost to fix (make `type` required) = trivial but removes defensive ergonomics for the generic. Kept optional per INV-C1.7. Non-blocking.
- **S1** (parseUrlHost empty-host) — **FIXED**: promoted to contract C2 (`return h || null`).
- **T1/T4/T5** (existing tests encode old behavior) — **Addressed in plan**: testing strategy now enumerates all three files with exact line refs and required updates.
- **T2** (failing-first regression test) — **Addressed**: the repro acceptance row is designated the failing-first guard; plan requires verifying it fails on current `main`.
- **T3** (whitespace-value / HIDDEN / order gaps) — **Addressed**: C1 acceptance table expanded with whitespace-only-value, whitespace-both, HIDDEN, and a mixed keep/drop order-asserting case.
- **T6** (testability positive) / **T7** (no E2E) — Accepted; T7 optional render test noted in strategy.
