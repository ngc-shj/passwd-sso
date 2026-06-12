# Coding Deviation Log: extension-search-all-vault

## D1 — PASSKEY excluded from the `matched` list (resolves A3b ↔ I2 conflict)

- **Where**: `extension/src/popup/components/MatchList.tsx` — `matched` filter gained `if (e.entryType === EXT_ENTRY_TYPE.PASSKEY) return false;`
- **Plan says**: I2 — empty-query rendering "identical to the pre-change component". A3b — a PASSKEY entry "remains absent from the default (empty-query) view".
- **Conflict discovered during implementation**: pre-change code excluded PASSKEY only from the `unmatched` list; a PASSKEY whose `urlHost` matches the tab WOULD render in the `matched` list (as a bare row with no buttons). A3b and I2 cannot both hold for that edge case.
- **Resolution**: A3b treated as authoritative (matches the existing code comment "PASSKEY entries are excluded: they are handled by the WebAuthn interceptor, not by popup autofill", and FR7's search-only discoverability intent). The `matched` filter now excludes PASSKEY, symmetrizing with the pre-existing `unmatched` exclusion. PASSKEY entries are visible ONLY in search mode.
- **Impact**: behavior change only for the edge case "passkey entry whose host matches the current tab" — previously a button-less row in the matched list, now hidden unless searching. Plan's Background consequence 3 ("PASSKEY entries are never visible in the popup") was over-broad for this edge; the implementation makes it true.
- **Status**: to be verified by Phase 3 reviewers (functionality + security perspectives).

## D2 — Orchestrator refactor of `renderEntryRow` button block (quality, not contract)

- **Where**: same file — the sub-agent's first version duplicated the Copy/TOTP button block across `canFill(e) && (...)` and `!canFill(e) && LOGIN && (...)` branches (~24 duplicated lines inside the dedup helper).
- **Resolution**: orchestrator restructured to a single group `{(canFill(e) || e.entryType === LOGIN) && (... {canFill(e) && <Fill/>} {LOGIN && <TOTP/><Copy/>} ...)}`. Behavior-equivalent (verified by the full extension suite re-run: 759/759 pass). No contract affected.
