# Plan Review: csp-form-action-loopback-scoping
Date: 2026-04-27
Review rounds: 2

## Round 2 Summary

All Round 1 findings (Critical T1, Major F1/T2, Minor F2/F3/F4/F5/S1/T3, Info S2) verified RESOLVED. One new minor finding caught in Round 2:

- **T4 (Minor)** — Testing strategy table still labeled `[::1]` no-port reject as "Optional" while §5 made it non-optional. Internal plan inconsistency. **Fixed in plan immediately** — table updated to match §5.

Plan is stable. Proceeding to Phase 2.

## Round 1 Summary

3 expert agents reviewed in parallel against the initial plan.

| ID | Severity | Source | Status |
|----|----------|--------|--------|
| F1 | Major | Functionality | Frontend validator (`mcp-client-card.tsx:71`) not in scope → client/server divergence. **Reflected — plan §3c + step 4.** |
| F2 | Minor | Functionality | DCR error message at `register/route.ts:51` omits `[::1]`. **Reflected — plan §3b + step 2.** |
| F3 | Minor | Functionality | Document port :0 acceptance. **Reflected — plan "Edge cases (regex)" section.** |
| F4 | Minor | Functionality | Confirm port > 65535 chain (URL ctor → regex). **Reflected — same.** |
| F5 | Minor | Functionality | R20 mechanical edit safety note. **Reflected — plan §3 editor note.** |
| S1 | Minor | Security | Same root as F2 (DCR error message). **Reflected via F2.** |
| S2 | Info | Security | RFC 8252 §7.3 / §8.3 citation unverified. **Flagged in plan R29 section as `citation unverified — please confirm` per Common Rules R29.** |
| S3-S6 | — | Security | Confirm-only (CSRF gate / open redirect / port squatting / URL alias bypass) — all bounded or pre-existing-and-mitigated. No action required. |
| T1 | **Critical** | Testing | CSP regression test using hardcoded `dummyOptions.cspHeader` would false-negative. **Reflected — plan §5 mandates `buildCspHeader` export OR `proxy()` real-response check; step 6 added for export.** |
| T2 | Major | Testing | Manual route no-port reject tests missing. **Reflected — plan §5 negative cases for both POST + PUT.** |
| T3 | Minor | Testing | DCR `[::1]` no-port reject was Optional. **Reflected — plan §5 makes it non-optional, symmetric with `127.0.0.1` / `localhost`.** |

All Critical and Major findings reflected in the plan. Round 2 verification follows.

## Round 1 — Functionality (full)

(See Round 1 sub-agent output saved separately — synthesized above. Key takeaway: F1 is the load-bearing fix; without the frontend update, scenarios 3 & 4 in the plan break in the UI.)

## Round 1 — Security (full)

(See Round 1 sub-agent output saved separately — synthesized above. Key takeaway: the threat model is unchanged. The CSP widening is bounded by loopback semantics + server-side `redirectUris` allowlist + PKCE. RFC citations need manual verification before commit.)

## Round 1 — Testing (full)

(See Round 1 sub-agent output saved separately — synthesized above. Key takeaway: the existing `_applySecurityHeaders` test pattern in `proxy.test.ts:31` uses a hardcoded `dummyOptions.cspHeader = "default-src 'self'"` — using that pattern for the new test would NOT exercise the `[::1]:*` addition. Either export `buildCspHeader` or test through the real `proxy()` export.)

## Recurring Issue Check (Round 1 — consolidated)

### Functionality expert
- R3: F1 — frontend consumer was a propagation gap (now fixed).
- R10: Verified — `src/lib/constants/auth/mcp.ts` is a leaf module.
- R20: F5 — edit-per-file note added.
- R22: Other route-level redirect URI validators reviewed — only authorize/consent/token routes, which validate by DB allowlist (not regex). Out of scope.
- R29: paraphrase-only citations, marked unverified.

### Security expert
- R3 / R29 / RS1 / RS3: covered above.
- R12 / R13 / R9 / R24 / R25: N/A.

### Testing expert
- RT1: T1 — mock-reality divergence in existing test pattern.
- R19 / R20: covered above.
- R24 / R25 / R21: N/A.

## Round 2 Status
Pending — plan updated; verification re-launched against the updated plan to confirm all Round 1 findings are correctly addressed.
