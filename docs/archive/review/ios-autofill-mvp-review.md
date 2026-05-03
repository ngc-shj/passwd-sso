# Plan Review: ios-autofill-mvp

Date: 2026-04-30
Worktree: `passwd-sso-ios` (branch `feature/ios-autofill-mvp`)
Plan: `docs/archive/review/ios-autofill-mvp-plan.md`

---

## Round 2

### Changes from Previous Round

Plan was substantially rewritten between rounds. The rewrite addressed all 12 round-1 functionality findings, most security findings, and most testing findings — but introduced new issues in the now-explicit detail. Round 2 verifies each fix and reports new findings against the rewrite.

### Summary

| Severity | Functionality | Security | Testing | Total round 2 |
|----------|---------------|----------|---------|---------------|
| Critical | 0 | 0 (S1/S2 no longer escalate) | 1 (T15) | **1** |
| Major | 6 (F13–F18) | 8 (S13–S16, S18–S20, S24) | 7 (T16, T17, T19, T21–T23 + T8/T9 continuing) | **21** |
| Minor | 3 (F19–F21) | 6 (S17, S21, S22, S23, S25, S26) | 5 (T14, T18, T20, T24–T26) | **14** |

### Headline (round 2)

The bones of the design are correct — both S1 and S2 (round-1 Criticals with `escalate: true`) are RESOLVED at the design level and **do not need Opus re-escalation**. The remaining issues are mostly localized plan-text corrections, not redesigns. The single Critical is a factual error in file paths that takes 3 minutes to fix.

**New must-fix issues** (security-relevant):
- **F15 / S19 — Open-redirect on `/api/mobile/authorize`**: server must validate `redirect_uri` matches `<self>/api/mobile/authorize/redirect` exactly; otherwise bridge code is phishable.
- **S14 — `.devicePasscode` ACL flag** contradicts the forensic-acquisition threat model the plan claims. Either drop the flag, or rewrite the threat model paragraph.
- **S15 — Passkey in ephemeral session doesn't work**: plan currently lists Passkey as a working provider via the ephemeral webview, but Considerations defers Passkey. Internal contradiction.
- **S20 — Server URL TOFU**: nothing pins the server URL on first vault unlock; phishing-via-server-URL is uncovered.
- **S24 — App-side AutoFill phishing**: malicious app with a valid AASA pointing at `victim.com` is handed the victim's credentials. UX warning is not present in app-side AutoFill (no URL bar).
- **T15 — Backward-Compat Regression Contract paths are wrong**: 4 of the 7 listed paths don't exist. Tests are co-located (`src/app/api/extension/token/route.test.ts` not `src/__tests__/api/extension/token/*.test.ts`). The contract is currently unenforceable.

**Scope undercount** (server-side):
- **F13 — DPoP infrastructure** is grep-zero in the parent codebase; the plan lists one new file (`src/lib/auth/tokens/mobile-token.ts`) for DPoP work that actually needs jti cache (Redis), `cnf.jkt` thumbprint storage, htu canonicalization, and `ath` claim verification — closer to ~5 files.
- **F14 — Tenant TTL fields** are not per-`clientKind`; iOS-specific TTLs require either schema additions or hard-coded constants.
- **F17 — `/api/notifications` is poll-only**, not push; team-membership-revoke staleness window is hours, not "one auto-lock cycle".

**Test feasibility / structure**:
- **T16 — CI orchestration mismatch**: the proposed `ci-ios.yml` uses workflow-level `paths:` while the parent uses `dorny/paths-filter` `changes` job — silent gaps on PRs that touch both surfaces.
- **T17 — Cross-process bridge-key test cannot run via XCUITest** as designed; needs an XCTest unit-test target with both entitlements granted to the test bundle.
- **T19 — Team-vault four-case enumeration omitted** (round-1 ask not fully delivered).

### Round-1 Resolution Verification

| ID | R1 Severity | Status | Notes |
|----|-------------|--------|-------|
| F1 | Critical | RESOLVED | "Auth & Token Acquisition Flow" defines `/api/mobile/{authorize, token, refresh}` |
| F2 | Major | RESOLVED | Magic Link explicitly Out of Scope |
| F3 | Major | RESOLVED | bridge-key model with biometric gate |
| F4 | Major | RESOLVED | Both entitlements separately documented |
| F5 | Major | RESOLVED | Save/update Out of Scope |
| F6 | Major | RESOLVED | iOS 17.0 pinned, `prepareOneTimeCodeCredentialList` named |
| F7 | Major | RESOLVED | bridge-key wraps team_keys; invalidation triggers documented |
| F8 | Major | CONTINUING | Server-side scope listed but undercount surfaces as F13/F14 |
| F9 | Major | RESOLVED | Three input shapes covered |
| F10 | Major | RESOLVED | iOS-specific TTLs + refresh ownership specified (caveat: F18) |
| F11 | Major | RESOLVED | Steps reordered correctly |
| F12 | Minor | RESOLVED | Concrete file list |
| S1 | Critical (escalate) | RESOLVED | clientKind + DPoP + scope segmentation. No re-escalation needed. |
| S2 | Critical (escalate) | RESOLVED | bridge-key + biometryCurrentSet. No re-escalation needed. |
| S3 | Major | RESOLVED | Universal Link, PKCE, ephemeral session |
| S4 | Major | CONTINUING | Cache-across-fills not explicit (S16) |
| S5 | Major | RESOLVED | Save/update dropped from MVP |
| S6 | Major | RESOLVED | Side-Channel Controls section explicit |
| S7 | Major | RESOLVED | AASA scoped to auth callback only |
| S8 | Major | PARTIAL | Implementation contract for replay disambiguation underspecified (S21) |
| S9 | Minor | RESOLVED | WhenUnlockedThisDeviceOnly pinned |
| S10 | Minor | PARTIAL | 3-item checklist; AAGUID + attestation policy still missing |
| S11 | Minor | RESOLVED | Out of scope, recorded |
| T1 | Critical | RESOLVED (caveat T14) | login-save fixture not extractable |
| T2 | Critical | CONTINUING | File paths wrong (T15) — contract globs nothing |
| T3 | Major | RESOLVED | XCTest pinned |
| T4 | Major | PARTIAL | ci-ios.yml structure conflicts with existing CI (T16) |
| T5 | Major | RESOLVED (caveat T17) | Test design correct; harness choice wrong |
| T6 | Major | RESOLVED | Three-tier matrix |
| T7 | Major | RESOLVED | Step 13 + Tier-2 |
| T8 | Major | CONTINUING | login-save parity test orphaned by save/update being out of scope (T18) |
| T9 | Major | CONTINUING | Four-case enumeration not explicit (T19) |
| T10 | Minor | RESOLVED | Two bullets |
| T11 | Minor | CONTINUING | TestClock not specified (T20) |
| T12 | Minor | CONTINUING | Passkey test plan not seeded |

### New Round-2 Findings

(See `/tmp/tri-y7rh59/*-findings.txt` and the full expert outputs preserved in this conversation for the complete text. Summary table:)

#### Functionality (F13–F21)

| ID | Severity | Title |
|----|----------|-------|
| F13 | Major | DPoP infrastructure missing from parent codebase; file list undercounts ~5× |
| F14 | Major | Tenant `extensionTokenIdleTimeoutMinutes` is not per-clientKind; schema or hard-coded decision needed |
| F15 | Major | `redirect_uri` validation policy on `/api/mobile/authorize` unspecified — open-redirect/bridge-code phishing |
| F16 | Major | Bridge-key Keychain item lifecycle has no atomicity for crash-mid-write |
| F17 | Major | `/api/notifications` is poll-only, not push; team-key invalidation is best-effort with hours-long window |
| F18 | Major | AutoFill extension's "refresh within 10% of expiry" budget conflicts with extension lifetime; shift refresh to host app only |
| F19 | Minor | AASA file path-pattern format ambiguous |
| F20 | Minor | iOS 17 user-base business decision not recorded |
| F21 | Minor | Contract test list misses idempotent-replay and clock-skew cases |

#### Security (S13–S26)

| ID | Severity | Title |
|----|----------|-------|
| S13 | Major | Host-app iOS token retains `passwords:write`; storage location ambiguous; coresident attacker on AutoFill ext can mass-overwrite vault |
| S14 | Major | `.devicePasscode` ACL flag weakens forensic-acquisition threat model the plan claims |
| S15 | Major | Passkey listed as working in ephemeral session, but Considerations defers Passkey — internal contradiction; SAML behavior in ephemeral session also unverified |
| S16 | Major | TOTP seed cache reuse window via Keychain biometric reuse (~10s) — biometric-per-fill claim is false |
| S17 | Minor | `UIPasteboard.OptionsKey.localOnly` API not cited correctly; iOS-16 pasteboard behavior changed |
| S18 | Major | DPoP design lacks jti store, ath claim, DPoP-Nonce, htu canonicalization, iat skew window — RFC 9449 conformance underspecified |
| S19 | Major | Universal Link bridge-code redirect has TOCTOU; bridge code lacks single-use enforcement, TTL, device_pubkey re-binding via DPoP at exchange |
| S20 | Major | First-time server-URL trust UX has no pinning; phishing-via-server-URL collapses ZK |
| S21 | Minor | "Refresh on revoked token → family revoke" risks false-positives on legitimate retry-after-network-failure |
| S22 | Minor | Secure Enclave key cannot do ECDH; record constraint to prevent future misuse |
| S23 | Minor | Bridge-key reboot semantics claim is technically slightly wrong (item is preserved, just temporarily unreadable) |
| S24 | Major | App-side AutoFill matching by URL host string allows malicious-app phishing; UX warning unavailable in apps without URL bar |
| S25 | Minor | Audit metadata for MOBILE_TOKEN_REPLAY_DETECTED insufficient to disambiguate attack vectors |
| S26 | Minor | "RFC 9449" citation loose; parent does not implement DPoP today |

#### Testing (T14–T26)

| ID | Severity | Title |
|----|----------|-------|
| T14 | Minor | `login-save-decisions.json` extraction is not behavior-preserving (depends on AES-GCM round-trip) |
| **T15** | **Critical** | **Backward-Compat Regression Contract names paths that do not exist** (4 of 7 wrong) |
| T16 | Major | New `ci-ios.yml` uses workflow-level `paths:` that conflicts with parent's `dorny/paths-filter` `changes` orchestration |
| T17 | Major | Cross-process bridge-key XCUITest is not actually feasible; needs XCTest unit-test target with both entitlements |
| T18 | Major | "Save/update decision parity" unit test is orphaned by save/update being out of scope |
| T19 | Major | Team-vault four-case enumeration still missing (continuing T9) |
| T20 | Minor | Auto-lock TestClock injection seam not specified (continuing T11) |
| T21 | Major | New `/api/mobile/*` contract tests not file-located; `src/__tests__/api/mobile/**` inconsistent with co-located convention |
| T22 | Major | DPoP signature failure test path lacks forgery harness specification (false-green risk) |
| T23 | Major | Prisma migration backward-compat test for `clientKind` rollout not specified (would wipe existing extension sessions on deploy) |
| T24 | Minor | Tier-2 manual-test adversarial scenarios incomplete (refresh-token theft, host-app crash mid-write, access-group rotation missing) |
| T25 | Minor | Test tenant fixture not pinned; manual-test pre-conditions non-reproducible |
| T26 | Minor | Step 2 fixture-extraction "no-behavior-change refactor" is hand-wavy; before/after diff verification not specified |

### Critical Re-evaluation (S1, S2 escalation status)

**S1 (R1 Critical, escalate=true)** → RESOLVED at design level. Residual S13 (host-app token scope storage) and S18 (DPoP underspec) are localized plan-text fixes. **No further Opus escalation needed.**

**S2 (R1 Critical, escalate=true)** → RESOLVED at design level. Residual S14 (`.devicePasscode` ACL flag inconsistency) is a one-line decision. **No further Opus escalation needed.**

### Disposition

The plan needs a third pass focused on:
1. The single Critical (T15 — fix file paths, ~3 lines).
2. The 8 security Majors with attacker-recoverable impact (F15, S14, S15, S16, S18, S19, S20, S24).
3. The 7 functional/test Majors driving real implementation cost or false-green CI (F13, F14, F17, F18, T16, T17, T19, T21, T22, T23).

Most fixes are localized plan-text edits. None require redesign. After round 3, the plan should be ready for implementation entry (Phase 2).
