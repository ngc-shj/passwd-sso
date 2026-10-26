# Code Review: api-key-passkey-requirement
Date: 2026-10-26

## Round 1
Scope: `main...HEAD` at bb14ae253, 96 files. No seed: the local LLM did not respond, so each
expert reviewed the full diff.

### Verified as clean
Security re-derived the bearer routes from the code, not from the plan list:
- Every user-bound bearer path ends in a gated validator.
- The three exempt handlers only revoke the caller's own rows or write one rate-limited audit
  row.
- `REVOKED` is checked before the gate, so replay detection still fires.
- The audit limiter cannot be spent by anyone who does not hold the credential.
- The AutoFill supersession only tightens.
- The measured raw-SQL exemption covers one file and one value.

Functionality found every consumer of the changed shapes handled, and the deviation-log claims
reproduce: 28 manifest entries, 7 of them `opaque-where`, and the attribution side effect.

### Security
| ID | Severity | Location | Finding |
|----|----------|----------|---------|
| S1 | Major | C7 gate | Lookups the gate cannot see: aliased, destructured or parameter-passed delegates; element-access or `.call` methods; `cursor` lookups. No per-model coverage. |
| S2 | Major | C7 gate | Two functions with the same name in one file merge under one key, and only the first is adjudicated. |
| S3 | Major | C7 gate | The digest-column raw-SQL check reads the source text, so escaped spellings (`token\x5fhash`) evade it. |
| S4 | Major | `policy-enforcement.md` | Claimed that the proxy gates session `/api/*` (that is `#959`). |
| S5 | Minor | C7 gate | `isOkFalseLiteral` ignores computed keys. |
| S6 | Minor | C7 gate | `refresh-bound` matches `inlineGate`/`lifetime` by name. |
| S7 | Minor | `check-auth.ts` (pre-existing) | IP restriction re-resolved an extension token's tenant from the user. |

### Functionality
| ID | Severity | Location | Finding |
|----|----------|----------|---------|
| F1 | Major | `policy-enforcement.md` | Same as S4. |
| F2 | Minor | `policy-enforcement.md` | The edited timeout rows cite a nonexistent error code and the wrong expiry formula; the grace rows omit the gate. |
| F3 | Minor | C7 gate comment vs deviation log | Two different runtime figures. |
| F4 | Minor | `v1-auth.ts`, `api-key.ts` | Stale status comments; `validateApiKeyOnly`'s `status` is unread. |
| F5 | Minor [Adjacent] | C7 gate | Same as S6. |

### Testing
| ID | Severity | Location | Finding |
|----|----------|----------|---------|
| T-1 | Major | `extension-token.test.ts` | The IP/UA-by-clientKind write assertions were deleted, not re-homed. |
| T-2 | Major | mapper tests | Fail-closed propagation is untested through `verifyAdminToken`, `validateV1Auth`, `authOrToken` and `checkAuth`; the planned metrics `rejects` cell is missing. |
| T-3 | Major | C7 self-test | Refusal clauses without fixtures; a gate consequent returning `ok: true` survives. |
| T-4 | Minor | CLI | The allow cell is a 404, not a non-passkey 403. |
| T-5 | Minor | integration | The policy axes are covered for the API key only. |
| T-6 | Minor | integration | The refusal does not assert the presented token stays unrevoked. |
| T-7 | Minor | raw-sql self-test | The exemption's under-count is uncovered. |
| T-8 | Minor | route tests | The limiter is picked by a non-unique `findIndex`. |
| T-9 | Minor | tests | Hardcoded literals where constants exist. |
| T-10 | Minor | integration | A tenant can leak if `createUser` throws. |
| T-11 | Minor | `passwords/route.test.ts` | Misleading comment. |
| T-12 | Minor [Adjacent] | C7 gate | `renderSql(trustedSql…)` accepted by spelling. |

## Recurring Issue Check (round 1)
### Functionality expert
R1 OK (membership check inline in 5 validators; no shared helper exists); R2 OK; R3 OK; R12 OK;
R25/R40 OK (no reader of the audit metadata; the sanitizer keeps the keys); R29 F2, F3; R42 OK;
R46 F5; R48 OK; R49 F1; R52 OK.
### Security expert
R3 OK; R29/R49 S3, S4, S6; R36 OK; R38 OK; R42 S1 (gate derivation; route set complete); R43 OK;
R46/R51 S2, S6; R47 S1, S3, S5; R48 S7; R52 OK; R54 OK; R5/R9 OK; RS1 OK; RS2 OK; RS3 OK;
RS4 OK; RS5 N/A; RS6 N/A.
### Testing expert
R3/R17 OK; R19 OK; R21 OK (T-1 is the one unmet migration); R42 OK; R50 OK; R53 OK; RT1 OK;
RT2 OK; RT3 T-9; RT4 OK; RT5 T-2; RT6 OK; RT7 T-3, T-7; RT8 OK; RT9 N/A; RT10 T-4; RT11 T-10.

## Environment Verification Report
- E1 (iOS app): the server responses are `verified-local`. The integration file passes against
  the real DB, with Redis and with `REDIS_URL` empty. The app's own presentation of a 403 is
  `blocked-deferred` to SC5 / `#963`, as declared in Phase 1. Its Anti-Deferral entry is in the
  plan's E1.

## Resolution Status (round 1)
- S4/F1, F2, F4 (comments), S7: fixed in 7e226dc27. S7 has a cell that pins the token's own
  `tenantId` being passed to `enforceAccessRestriction`.
- C7 (S1–S3, S5, S6/F5, T-3, T-12, F3): fixed. The self-test grows from 61 to 143 cells. Every
  new clause was red-proved on a scratch copy, except one: the shorthand-`ok` clause cannot fail
  alone, because the `FalseKeyword` test already rejects a shorthand. Its cell is pinned anyway.
  - The S1 relation-field exception and the computed-key residual are in the deviation log.
  - The model-coverage entry `models: {}` is empty, because all 13 token models have an analysed
    lookup.
- Tests (T-1, T-2, T-4–T-11): fixed.
  - The T-1 shape and truncation cells were red-proved by removing the IOS_APP conditional and
    the slice.
  - The T-2 cells were red-proved by wrapping each mapper's validator call in a try/catch that
    returns a deny.
  - The integration file has 29 cells, all passing against the real DB.
- Verification: lint, full vitest (1092 files), build, the C7 gate and the raw-SQL gate all
  pass.
