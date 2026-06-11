# Code Review: dcr-dos-ttl-cap-rework

Date: 2026-06-11
Review round: 2

## Round 1 (on impl commit 6d2af372)

- **Security — No findings.** Verified: no security regression from the value changes (nothing else depends on the 1h TTL / 100 cap; consent claim does NOT filter on dcrExpiresAt so a slow consent can still claim until physical sweep — no fail-closed mid-flow gap); the 503 message no longer embeds a time window (no info-leak change, accurate); the arithmetic (cap 1000, 15min, 20/h per /64 → ~200 sustained /64s, ~10x) is correct; the docs' honest framing (cost-increase not elimination, SC1 residual) is accurate; raising the cap to 1000 introduces no resource issue (ephemeral rows, indexed COUNT trivial).
- **Functionality+Testing — F1/T1 [Minor], T2 [Info].** C1/C2/C1.5/C2-test/T2-bulk-insert/C3-docs all correct; the bulk INSERT column/value counts match (the `'hash'` literal fix held), both integration branches non-vacuous (beforeEach clears → deterministic counts). **F1**: docs/security/threat-model.md:130 (live doc) still said "100 unclaimed, 24h" — C3 missed it. **T1**: bulk-insert client_id used an 8-hex slice → ~1/8600 birthday collision at 1000 rows (flaky). **T2 [Info]**: push-order vs column labels swapped (functionally fine).

## Round 2 (on fix commit f7dfb8d9)

All three experts' concerns confirmed resolved: threat-model D6 now states 1000/15min + honest residual (accurate, not overstated, dual-sweep claim code-backed); bulk-insert uses the full uuid for client_id (collision-safe) + corrected labels; integration tests pass (3). **No findings.**

## Resolution Status

- F1 → threat-model.md D6 updated to 1000 unclaimed + 15min + honest residual cross-referencing D5 (fixed f7dfb8d9).
- T1 → bulk-insert client_id uses the full uuid (fixed f7dfb8d9); T2 labels corrected in the same edit.
- Security: No findings (Round 1); Round 2 edits are docs/test only.

Code review CLOSED after 2 rounds. No Major/Critical, no deferrals.
