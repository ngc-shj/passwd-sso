# Code Review: csp-form-action-loopback-scoping
Date: 2026-04-27
Review round: 1 (terminated — only finding was a non-code git-staging issue, fixed before commit)
Branch: refactor/csp-form-action-loopback-scoping

## Changes from Previous Round
Initial code review.

## Summary

3 expert agents reviewed in parallel against the plan and `git diff origin/main`.

| Expert | Outcome |
|--------|---------|
| Functionality | **No findings.** Plan adherence verified. The `buildCspHeader` extraction (deviation from plan's "export from proxy.ts") was assessed as a clean architectural improvement — security headers belong under `src/lib/security/`. R3 propagation re-verified; remaining loopback-host references are in distinct contexts (SSRF blocklist, CIDR config, CLI server validation). R10 / R20 / R21 all pass. |
| Security | **No findings.** CSP widening sound (loopback IPs not externally routable). RFC 8252 §7.3 / §8.3 citations verified against the live RFC during Phase 2 Step 2-1. CSRF Origin gate at consent route preserved. Open redirect still gated by server-side `redirectUris.includes(redirectUri)`. The four surfaces (DCR / Manual POST / Manual PUT / Frontend) plus the CSP directive accept the same loopback host set with no drift. |
| Testing | **F1 (Critical, non-code)**: `src/__tests__/csp-header.test.ts` and `src/lib/security/csp-builder.ts` were untracked at review time — they would not have shipped via the PR. **Fixed**: `git add` of both files before the implementation commit. All 61 targeted tests pass; CSP regression test pins all three loopback host literals. RT1 mock-reality alignment verified for the new PUT loopback test. |

After F1 fix the implementation is complete and clean. No subsequent rounds needed.

## Functionality Findings
No findings.

Verified:
- Plan steps 1–6 all executed.
- `LOOPBACK_REDIRECT_RE` defined exactly once in `src/lib/constants/auth/mcp.ts`; consumed by DCR, manual POST, manual PUT, and frontend validator.
- CSP `form-action` includes all three loopback hosts in the same order as the regex accepts them.
- `buildCspHeader` extraction preserves all module-level constants (`_isProd`, `_cspMode`, `_rawCspMode`, `_reportUri`, `_stylePrefix`, `_styleSuffix`, `_staticDirectives`) verbatim.
- R3 propagation (no missed sites): SSRF webhook validator (`url-validation.ts:14`), trusted proxy CIDRs, external-HTTP blocklist, Tailscale daemon comment, CLI server-URL validation are all intentionally separate concerns and not in scope for this regex.
- R10: `mcp.ts` imports only `MS_PER_MINUTE` from a leaf time module; safe for client component import.
- R21: `npx next build` exits 0; TypeScript types resolve cleanly across all new imports.

## Security Findings
No findings.

Verified:
- `proxy.ts` (root) delegates to `src/lib/security/csp-builder.ts`. CSP content matches the plan: `'self' http://localhost:* http://127.0.0.1:* http://[::1]:*` in `form-action`.
- RFC 8252 §7.3 ("Loopback Interface Redirection", "MUST allow any port") and §8.3 ("Loopback Redirect Considerations", "use of localhost is NOT RECOMMENDED") cited accurately in both `csp-builder.ts` and `mcp.ts`. Phase 2 verified against `https://www.rfc-editor.org/rfc/rfc8252.html`.
- The four surfaces (DCR, Manual POST, Manual PUT, Frontend) plus CSP form-action have identical loopback host accept sets. No drift.
- Frontend `validateRedirectUris` call sites (mcp-client-card.tsx lines 158, 233) gate submission on the validation result; no stale-state issue.
- CSRF Origin gate at consent route (line 14-17) untouched.
- Open redirect remains gated by `foundClient.redirectUris.includes(redirectUri)` (consent route line 45).
- `_cspMode` safety guard in production preserved.
- No client-bundle exposure of server-only env vars (`csp-builder.ts` is server-only).

## Testing Findings

### F1 — Critical (non-code, fixed): untracked files

- **Files**: `src/__tests__/csp-header.test.ts`, `src/lib/security/csp-builder.ts`
- **Problem**: After Phase 2, both files were untracked (`?? ` in `git status`). Without `git add`, neither would ship via the PR — the test would not run in CI and the new module would be missing entirely.
- **Resolution**: `git add` both files alongside the modified files in the same commit. Verified post-commit: `git log --stat HEAD -1` shows `create mode 100644` for both.

Beyond F1, no testing findings:
- T1 (CSP false-negative pattern): resolved by `csp-builder.ts` extraction + direct unit test in `csp-header.test.ts`. The test pins all three loopback host literals plus a sanity check that broad `http:*` is NOT in form-action.
- T2 (manual route no-port reject): added via `it.each` for both POST and PUT.
- T3 (DCR `[::1]` no-port reject): added (paired with `[::1]` accept).
- RT1 (mock-reality divergence): mock shapes for new PUT loopback test align with production select.
- R19 (mock alignment): no test mocks `@/lib/security/csp-builder`; new module does not affect existing mocks.

## Adjacent Findings
None.

## Quality Warnings
None.

## Recurring Issue Check

### Functionality expert
- R3 (propagation): Verified — no missed sites.
- R10 (circular import): Pass — `mcp.ts` is a leaf module from the client perspective.
- R20 (mechanical edit safety): Pass — both manual route refines edited per-file.
- R21 (build verification): Pass — `npx next build` exits 0.
- Others: N/A.

### Security expert
- R3, R29, RS1, RS3: Pass.
- R12 / R13 / R9 / R24 / R25: N/A.

### Testing expert
- R19 (mock alignment): Pass.
- R20 (mechanical edit): Pass.
- R21 (verification): Pass after F1 fix.
- RT1 (mock-reality): Pass.
- RT2 (testability): Pass — extraction enabled direct unit testing of `buildCspHeader`.
- RT3 (shared constants): Pass — tests use `LOOPBACK_REDIRECT_RE` indirectly via shape assertions.

## Resolution Status

### F1 Critical (Testing) — Untracked files
- Action: `git add src/__tests__/csp-header.test.ts src/lib/security/csp-builder.ts` before the implementation commit.
- Modified file: implementation commit (commit message references both new files).
- Status: Resolved (verified by `git log --stat HEAD -1`).

All other findings: No action needed.
