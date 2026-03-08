# Plan Review: itemkey-client-generation

Date: 2026-03-09
Review round: 2

## Changes from Previous Round

Round 1 findings (Critical 2 / Major 7 / Minor 3) addressed:

- F1 [Critical]: RESOLVED — Added F8 requirement, history route to Step 4 file list
- S1 [Critical]: RESOLVED — Added F7 requirement, Step 5.5 for downgrade prevention
- F2 [Major]: RESOLVED — Step 6 expanded with field propagation details
- F3 [Major]: RESOLVED — Step 3 changed to use getEntryDecryptionKey
- F4 [Major]: RESOLVED — Step 4 note added for both decrypt and editData changes
- S2 [Major]: RESOLVED — Step 3 edit mode updated with key rotation re-wrap
- S4 [Major]: RESOLVED — Retry behavior added to Considerations
- T1 [Major]: RESOLVED — Step 7 expanded with decrypt call site tests
- T2 [Major]: RESOLVED — Step 7 expanded with import tests
- T3 [Major]: RESOLVED — Step 7 expanded with saveTeamEntry tests
- F5 [Minor]: RESOLVED — Client-side validation added to Step 2
- S3 [Minor]: SKIPPED — UUID v4 collision probability negligible
- T4 [Minor]: SKIPPED — covered by executeTeamEntrySubmit tests

## Round 2 New Findings

### F9 [Major] History list API also needs itemKeyVersion (Functionality)

- **File**: `src/app/api/teams/[teamId]/passwords/[id]/history/route.ts`
- **Problem**: Step 4 only added single-history GET route. The list API also should return `itemKeyVersion` for consistency.
- **Resolution**: Added to Step 4 file list.

### F10 [Minor] entry-history-section must use history record's own itemKeyVersion (Functionality)

- **Problem**: History records preserve the itemKeyVersion at time of save. Older records may be v0 even if current entry is v1.
- **Resolution**: Added note to Step 4 clarifying per-record itemKeyVersion usage.

### N1 [Major] POST endpoint should enforce minimum itemKeyVersion (Security)

- **Problem**: Server POST still accepts itemKeyVersion=0 for backward compatibility.
- **Resolution**: Added to Considerations — client-side enforcement sufficient for now; server-side enforcement deferred until all clients updated.

### N2 [Minor] Key rotation re-wrap scenario clarification (Security)

- **Problem**: Rotate-key endpoint already atomically re-wraps all ItemKeys. The S2 scenario only occurs with stale client cache, handled by 409.
- **Resolution**: Expanded key rotation consideration with 409 retry behavior details.

### N3 [Minor] SaveTeamEntryParams needs ItemKey fields (Security)

- **Resolution**: SKIPPED — already implied by Step 2 interface changes.

## Functionality Findings

No new findings.

## Security Findings

No new findings.

## Testing Findings

No new findings (testing expert findings were about code not yet implemented, which is expected in plan review phase).
