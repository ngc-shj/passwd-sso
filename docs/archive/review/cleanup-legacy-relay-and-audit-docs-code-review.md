# Code Review: cleanup-legacy-relay-and-audit-docs
Date: 2026-04-19
Review rounds: 1, 2 (converged — all 3 experts returned "No findings" in round 2)

## Changes from Previous Round
Initial review.

## Functionality Findings

**F1 [Minor]**: `docs/security/security-review.md:220` named the HEC deliverer as "Splunk HEC" while `src/workers/audit-delivery.ts` uses the vendor-neutral `SIEM_HEC` enum. Reworded to "SIEM HEC (Splunk HTTP Event Collector–compatible protocol; vendor-neutral)".

**F2 [Minor]**: `extension/src/lib/constants.ts:1` header comment referenced the deleted `inject-extension-token.ts` (replaced by `inject-extension-bridge-code.ts`). Path updated.

## Security Findings

**S1 [Minor]**: `docs/security/threat-model.md:97` (§3.3 R1 row) still described the deleted in-memory FIFO retry buffer (max 100 entries, 3 retries), contradicting the §5 bullet 3 rewrite landed earlier in this PR. Replaced the Mitigation column with the durable outbox + worker description and updated the Residual-risk column to reflect the 256-char `lastError` METADATA_BLOCKLIST-bypass note (operator-diagnostics-only). Cross-cite to §5 added.

**Plan-coverage gap noted**: plan §F5 only enumerated `threat-model.md` §5 item 3; the §3.3 R1 row was an unrecorded duplicate description that survived the original rewrite. No structural fix needed in the plan — the §3.3 R1 fix is single-file, captured in this review log.

## Testing Findings

No findings.

## Adjacent Findings

None.

## Quality Warnings

None — all findings include file:line evidence and concrete fixes.

## Recurring Issue Check

### Functionality expert
- All R1–R30: see Round 1 expert output. R3 (Pattern propagation) PASS for source/test surface; one stale doc reference (F2) caught and fixed.

### Security expert
- All R1–R30 + RS1–RS3: see Round 1 expert output. R3 (Pattern propagation) FAIL → S1 finding → fixed in commit 6118417b.

### Testing expert
- All R1–R30 + RT1–RT3: see Round 1 expert output. All PASS / N/A.

## Resolution Status

### F1 [Minor] "Splunk HEC" wording — Resolved
- Action: rewrote `docs/security/security-review.md:220` to "SIEM HEC (Splunk HTTP Event Collector–compatible protocol; vendor-neutral)".
- Modified: `docs/security/security-review.md`.

### F2 [Minor] Stale `inject-extension-token.ts` reference — Resolved
- Action: updated `extension/src/lib/constants.ts:1` header comment to reference `inject-extension-bridge-code.ts`.
- Modified: `extension/src/lib/constants.ts`.

### S1 [Minor] In-memory FIFO mention surviving in §3.3 R1 — Resolved
- Action: rewrote `docs/security/threat-model.md:97` Mitigation + Residual-risk columns to describe the durable outbox + worker pipeline and the `lastError` METADATA_BLOCKLIST-bypass note.
- Modified: `docs/security/threat-model.md`.

(All three fixes landed in commit `6118417b review(1): address Phase 3 Round 1 expert findings`.)

---

## Round 2 Findings

All three experts returned **No findings**. Code review converged at Round 2.

- Functionality round 2: F1, F2 confirmed Resolved. Round 1's threat-model.md R1 update (S1 fix) noted as cross-consistent with §5 bullet 3 + security-review.md §5; R2 ("Same as R1") still coherent under the new wording.
- Security round 2: S1 confirmed Resolved. Stale-lexicon grep verification across `src/` and live `docs/security/`: zero hits for "in-memory FIFO", "buffer overflow", "audit-retry", "100 entries" (archive review docs intentionally retain historical references). Atomicity claim correctly bounded ("for successfully committed operations") — no overstatement. lastError METADATA_BLOCKLIST-bypass note now consistent across both threat-model.md §3.3 R1 and security-review.md §5 Notes/residual risk.
- Testing round 2: 0 test files modified by Round 1 fixes; no test asserts on the modified doc strings or the old comment value; existing `src/lib/inject-extension-bridge-code.test.ts` already targets the correct module name now reflected in the F2 comment fix. No new test-surface issues.
