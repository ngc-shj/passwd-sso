# Plan Review: extension-dpop-sender-constrained

Date: 2026-05-24
Review round: 3 (final — leads to plan lock)

## Changes from Previous Round

Round 2 expert findings (F1-r2 through F6-r2 / S11-S22 / T15-T26) all incorporated into the plan. Round 3 launched two expert sub-agents (functionality, security) to verify resolution and surface any final issues. Testing agent skipped for Round 3 since (a) Round 2 testing concerns were comprehensive and applied as concrete test additions, and (b) no Adjacent testing items were flagged by func/security agents in Round 3.

## Functionality Findings (Round 3)

### Round 2 resolution status
All 6 Round 2 functionality findings (F1-r2 through F6-r2) verified resolved by Round 3 plan:
- F1-r2 (type cycle) → resolved via `extension-token-types.ts` leaf module + `import type`.
- F2-r2 (schema invariant) → resolved via partial CHECK constraint.
- F3-r2 (C12 missing) → resolved via new C12 contract.
- F4-r2 (session-storage upgrade) → resolved via `loadSession()` null on undefined `tokenCnfJkt` + user scenario 9.
- F5-r2 (Prisma enum) → resolved via `import { ExtensionTokenClientKind } from "@prisma/client"`.
- F6-r2 (sign-failure rationale inverted) → resolved via retry-once + `DpopSignError` + explicit "callers MUST NOT clearToken" invariant.

### Round 3 new findings (Functionality)

#### F1-r3 [Minor] — `swFetchAuthenticated` code-sample type narrowing — APPLIED to lock
- C8 code sample originally typed `proof: string | null = null` then unconditionally `headers.set("DPoP", proof)` — TypeScript reject.
- **Fix applied**: rewritten with inner `sign()` helper so `proof: string` narrows cleanly without `!`.

#### F2-r3 [Minor] — `ValidatedExtensionToken.cnfJkt` nullability — APPLIED to lock
- C12's `safeStringEqual(body.data.cnfJkt, validated.data.cnfJkt)` requires non-nullable cnfJkt.
- **Fix applied**: C5 invariant now states `cnfJkt: string` is non-nullable by construction (IOS_APP null-cnfJkt rows are filtered by the IOS dispatch guard at mobile-token.ts:247-251 BEFORE this type is constructed).

#### F3-r3 [Minor] — `EXTENSION_TOKEN_ROUTES` route-shape asymmetry — Phase-2 implementer note
- `isBearerBypassRoute` has hardcoded exact-match for `EXTENSION_TOKEN`/`EXTENSION_TOKEN_REFRESH`; new `EXTENSION_KEY_RESET` falls to default-arm prefix-match. Harmless (no child paths) but stylistically inconsistent.
- **Decision**: Phase-2 implementer note; not blocking lock.

#### F4-r3 [Minor] — Migration step ordering comment — Phase-2 implementer note
- Prisma wraps migration in transaction → safe as-is; documentation-only nit.
- **Decision**: Phase-2 implementer note.

#### F5-r3 [Informational] — `validateIosTokenDpop` re-export error-variant note — Phase-2 verification
- iOS callers previously returned `EXTENSION_TOKEN_DPOP_INVALID` only; new union adds `EXTENSION_TOKEN_INVALID`. Existing iOS test suite must pass without modification (plan's C5 acceptance pins this).
- **Decision**: Phase-2 verify; not blocking lock.

### Functionality verdict
**Plan ready to lock** after applying F1-r3 and F2-r3 (both done).

## Security Findings (Round 3)

### Round 2 resolution status
All Round 2 security findings (S11-S22) verified resolved by Round 3 plan, with one exception:
- S13 (canonicalHtuClient equivalence) → **Partial** — the algorithm `new URL(serverUrl).origin + route` was missing basePath. Exposed by Round 3 reviewer as S23-r3 below.

### Round 3 new findings (Security)

#### S23-r3 [Major — blocker] — `canonicalHtuClient` dropped basePath — APPLIED to lock
- escalate: false (deployment-config dependent — vacuously safe when APP_URL has no basePath, breaks 100% on basePath deployments).
- Server's `canonicalHtu` preserves APP_URL pathname as basePath. Plan's algorithm `new URL(serverUrl).origin + route` returns scheme + host + port only — no basePath. Any deployment with `APP_URL=https://example.com/passwd-sso` would have every DPoP `htu` mismatch.
- **Fix applied**: algorithm changed to `${url.origin}${url.pathname.replace(/\/$/, "")}${route}`. Smoke test extended with basePath-bearing case (`serverUrl="https://example.com/passwd-sso", route="/api/x"` → `https://example.com/passwd-sso/api/x`).

#### S24-r3 [Minor] — C12 audit overloads `EXTENSION_TOKEN_FAMILY_REVOKED` action — Phase-2 implementer note
- SIEM filters on action=FAMILY_REVOKED would surface user-initiated key resets too. `metadata.reason` discriminator is the only signal.
- **Decision**: accepted overload (per Option A no-new-audit-actions decision); Phase-2 documents the disambiguator. Not blocking.

#### S25-r3 [Minor] — `safeStringEqual` import not pinned — Phase-2 implementer note
- C12 uses `safeStringEqual` but plan doesn't specify which helper.
- **Decision**: Phase-2 implementer picks existing project helper (likely `crypto.timingSafeEqual` wrapper); cnfJkt is constant-length 43 chars so even `===` is timing-safe enough. Not blocking.

#### S26-r3 [Minor] — Cookieless-no-Bearer-no-DPoP 401 path test — Phase-2 test addition
- C12 acceptance adds: "cookieless + no Bearer + no DPoP → 401 unauthorized (NOT proxy 403)" to verify the route lands on `validateExtensionToken`'s `unauthorized()`.
- **Decision**: Phase-2 implementer adds the test case. Plan-level lock not affected.

#### S27-r3 [Informational] — `/key/reset` failure-mode self-heal note — Acknowledged
- Network drops between server 2xx and extension's receipt: server revoked, extension still has IDB key. Next swFetch returns 401 → clearToken → reconnect with fresh key. Self-healing.
- **Decision**: noted in plan's Known Risks (implicit in C12 atomicity contract). No action needed.

### Security verdict
**Plan ready to lock** after applying S23-r3 (done). Remaining Minors S24-r3, S25-r3, S26-r3, S27-r3 are Phase-2 implementation guidance.

## Recurring Issue Check (Round 3)

Both Round 3 experts confirmed no R1-R37 / RS1-RS4 / RT1-RT5 regressions from Round 2. Specifically:
- R8 (no false technical justification): Round 3 plan maintains honest cost trade-off framing.
- R12 (const object for string literals): `DPOP_VERIFY_ERROR.*` symbols and Prisma enum used throughout.
- R32 (boot test): tightened with direct IDB inspection.

## Summary

**Round 3 verdict: PLAN LOCKED.**

- Round 1 Critical (5): F1/F2/S2/T1/T2 — all resolved.
- Round 1 Major (12): F3/F4/F5/F6/F7/S3/S4/S5/T3/T4/T5/T7 — all resolved.
- Round 2 Critical (3): F1-r2/F2-r2/T15 — all resolved.
- Round 2 Major (11): F3-r2/F4-r2/F5-r2/F6-r2/S11/S12/S13/T16/T17/T18/T19 — all resolved.
- Round 3 blocking (1): S23-r3 (canonicalHtuClient basePath) — resolved.
- Round 3 Minor / Informational (7): F1-r3, F2-r3 applied; F3-r3, F4-r3, F5-r3, S24-r3, S25-r3, S26-r3, S27-r3 noted as Phase-2 implementation guidance.

All 14 contracts (C1-C12, C3b, C9a) locked.

Cleanup (post-commit):
```bash
bash ~/.claude/hooks/tri-tmpdir.sh cleanup /tmp/tri-d1Uonz
bash ~/.claude/hooks/tri-tmpdir.sh cleanup /tmp/tri-lSpTpO
```
