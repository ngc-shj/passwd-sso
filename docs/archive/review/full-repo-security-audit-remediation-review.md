# Remediation Review Log: Full-Repo Security Audit (S1–S10)

Branch: `fix/security-audit-remediation-v2`
Review skill: triangulate (functionality + security + testing, 3 rounds)
Audit findings source: [full-repo-security-audit-code-review.md](./full-repo-security-audit-code-review.md)
Manual test plan: [full-repo-security-audit-manual-test.md](./full-repo-security-audit-manual-test.md)

## Commits

| Commit | Summary |
|--------|---------|
| `71ef6e20` | S1–S10 audit remediation |
| `39ea7fc9` | Phase 2 self-R-check gap closure |
| `48cc8ce2` | review(1): autofill frame-origin bind (F1), CSV round-trip strip (F2), test coverage, minor fixes |
| `f6738a97` | review(2): frame-scope all content-driven credential release paths (autofill fill delivery + pending-save) |
| `fdd1d60a` | content-side frame-origin gate (blocks third-party-iframe leak on the popup broadcast path) |
| `8d41e5a1` | test/comment follow-ups (real popup AUTOFILL path; top-frame-only comment) |

## Round 1 — findings and resolution

- **F1 (Major, functionality+security converged)** — autofill origin bind used `_sender.tab.url` (top-tab) instead of `_sender.url` (frame). Broke cross-origin-iframe logins AND leaked to subframes. **Fixed**: bind to `_sender.url`; edge tests added.
- **F2 (Major, functionality+testing converged)** — CSV export prefixed formula-trigger cells (incl. password) with `'`; importer never stripped it → export→import password corruption. **User decision: symmetric strip on import.** `stripCsvFormulaGuard` in `parseCsvLine`; round-trip regression tests.
- **T1–T7, F3–F6 (Minor)** — consent UI tests, CLI CSV escaper module + parity test, delegation denial `create-not-called` assertions, forwarded-headers unset-env test, e2e golden vectors, formatExportCsv formula test, canDelegate comment, DCR warning copy (en+ja), amber style, tailscale-serve doc. **All fixed.**
- **[Adjacent] F7-A / T-A2 (residual data)** — pre-fix delegation sessions / kdfType=1 rows. **Accepted (recorded).** Dev-DB measurement: `kdf_type != 0` = **0 rows**; all clients derive via PBKDF2-600k regardless of stored kdfType, so any such row still decrypts (metadata inconsistent-but-inert). No migration.

## Round 2 — findings and resolution (same class as F1, horizontally expanded per R42)

- **Autofill LOGIN fill broadcast (Major)** — the LOGIN fill was `chrome.tabs.sendMessage(tabId,…)` (no frameId) + `executeScript allFrames:true`, leaking to subframes even after the trigger gate. **Fixed**: route through the frame-scoped `sendFillMessage`/`executeTarget`.
- **pending-save flow (Major)** — CHECK_PENDING_SAVE pull + SHOW_SAVE_BANNER push released the just-typed password to any frame, gated on top-tab host only. **User-approved fix**: bind pending to the submitting frame's origin (`_sender.url` → `frameHost`); CHECK requires frame-origin match (without consuming on sibling mismatch); push targets `frameId:0`. Subframe-denial + survival tests.

## Round 3 — findings and resolution

- **Regression introduced during Round 2 (Major)** — restoring `allFrames:true` on the popup executeScript fallback re-opened the third-party-iframe leak (user-flagged). **Reverted** to top-frame-only for popup; the test assertion was corrected to detect the leak (was pinning `allFrames:true` as "safe").
- **Root-cause fix (the essential remediation)** — even with the fallback safe, the **message path still broadcasts** to all frames for popup (frameId unknown), and the content-side handler filled unconditionally. **Fixed**: content-side `isFrameAllowedToFill` gate — a frame fills only if it is the top frame or its own origin matches the entry's `allowedHosts` (`urlHost` + `additionalUrlHosts`, sent in the payload). Gate lives in both `autofill-lib.ts` (typed twin) and `autofill.js` (production); `autofill-js-sync.test.ts` pins the production artifact. No new permission.
- **Testing coverage (medium/low)** — fallback frame-scoping assertions, content-gate subframe/top/hostless tests, `.js` parity test. **Added.** Follow-up: fallback test switched to the real popup path (`EXT_MSG.AUTOFILL`); executeTarget comment corrected to "top-frame-only".

## Dedicated verification of the frame-origin gate

**No findings.** Verified: no suffix-confusion (`bank.example.attacker.com`, `attacker-bank.example` both rejected — the required leading `.` prevents the trick); `window.top===window.self` not spoofable (isolated world); `.js`/`.ts` byte-parity (same `/^www\./i` strip, `http(s)`-only protocol check, `e===t || t.endsWith("."+e)`); all LOGIN delivery paths covered (message broadcast gated content-side, executeScript fallback top-frame-only for popup / frame-scoped for content-driven, CC/Identity injected only into the top frame via `{tabId}` so their listeners never exist in subframes); hostless entries fail closed to the top frame.

## Recurring Issue Check (summary)

R42 class-invariant: the "content-driven credential release gated on tab-URL" class was derived from code and fully closed — AUTOFILL_FROM_CONTENT (F1), LOGIN fill delivery (R2), pending-save pull/push (R2), and the broadcast content-side gate (R3). PASSKEY_* confirmed out-of-class (boundary is `isSenderAuthorizedForRpId`/WebAuthn `expectedOrigin`, not tab URL).

## Deferred to a separate PR (out of scope)

- **Origin-matched frame-specific injection for the popup executeScript fallback** — to also fill a legitimate cross-origin iframe login when content-script messaging is blocked (the message path already covers the common case safely). Requires enumerating frames (`webNavigation` permission) or per-frame self-match; a permission escalation, so deferred. Not a security hole — the current fallback fails safe to the top frame.

## Convergence

All Critical/Major findings resolved. Final state: extension suite 828 passed, app suite 12197 passed, `scripts/pre-pr.sh` 44 checks green, all typechecks clean.
