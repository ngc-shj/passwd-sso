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

## Round 2
Scope: `bb14ae253..52f783a0e`. No fix widened a predicate against round 1 (R43, all three experts).

### Findings
- **Security**
  - S2–S7 resolved. S1 continues as C1.
  - C1 Major: the residual's justification was refuted. `Reflect.get` and a `const`-bound handle
    escape, and a receiver-independent digest-shape rule closes them without a Program.
  - N1 Major: digest filters under `include`/`select`/`_count`/nested writes were not read.
  - N2 Major: the raw-SQL rule was defeated by `U&` identifiers, `trustedSql`/`sqlIdentifier`
    splicing, and whole-row projections.
  - M1 Minor: `inlineGate` accepted a negated condition or a non-refusing consequent.
- **Functionality**
  - F1–F5 resolved.
  - F6 Minor: the `requirePasskey` row omits the mint-point gates.
  - F7 Minor: the idle/absolute rows omit the iOS host token.
  - F8 Minor [Adjacent]: `CLAUDE.md` cites `src/proxy.ts:153` for the audit-emit fetch.
  - F9 Minor: same as N-1.
  - F10 Minor: the delegate-reference refusal message gives no remedy.
- **Testing**
  - T-1–T-12 resolved.
  - N-1 Minor: a `checkAuth` fixture omits `tenantId` and pins the removed contract.
  - N-2 Minor: some `.replace`-built variants have no no-op guard.
  - N-3 Minor: new C7 clauses have no fixtures.
  - N-4 Minor: a `mockReturnValueOnce` can leak into the next cell.
  - N-5 Minor: a fixed sleep before a negative assertion.

### User decision
C1/N1/N2: change the mechanism rather than keep closing spellings, or declare the gate a
tripwire.

### Resolution Status (round 2)
- **C1/N1:** lookup detection is receiver-independent. A digest key anywhere in a filter
  position counts, so `Reflect.get`, computed and parameter-passed delegates are covered where the filter is readable (corrected in round 3: an unreadable filter on such a receiver is a declared residual):
  - top-level `where`/`cursor`/`having`;
  - relation `where` under `include`/`select`/`_count`;
  - nested-write filters.
  
  Opaque refusal covers token models and one relation hop.
  - Why one hop: the transitive closure is 57 of 60 models, which would make 41 functions opaque
    today.
  - The longer hops are a declared residual with an Anti-Deferral entry.
  - The manifest goes from 28 to 39. The newly visible sites were each read; none is an ungated
    user-bound lookup.
- **N2:**
  - `U&`/`UESCAPE` are refused.
  - `renderSql` throws at run time on `token_hash`/`code_hash`, which closes identifier
    splicing. It has three callers, none affected (corrected in round 3, NF4): the retention-GC
    sweep and the audit-outbox worker render no digest column, and
    `scripts/migrate-account-tokens-to-encrypted.ts` touches only the `accounts` token columns.
  - Whole-row projections, dynamic SQL inside the statement, and migration-defined objects are
    declared residuals.
- **R49:** the gate header and the plan's C7 now state the control class, its adjudicated
  surface, its residuals and the real recovery path.
- **Minors:** M1, N-2, N-3 and F10 fixed in the gate. N-1/F9, N-4, N-5, F6 and F7 fixed in the
  tests and the docs.
- **F8:** `CLAUDE.md` is edited only with explicit user approval. The change was proposed and
  awaits an answer.
- **Red proofs (scratch copy):** 29 mutations for the detection rules, 7 for raw SQL, 9 for M1,
  and the N-3 cells. Each turned its cell red.
  - Exception: one rule was found to be a no-op, because ts-morph's `getText()` already returns
    unescaped names, so it was reverted.
- **Verification:** lint, full vitest (1092 files, 18881 tests), build, the C7 gate (39/39) and
  the raw-SQL gate all pass.
- **Runtime:** the gate takes about 6.5–7 s.

## Round 3
Scope: `52f783a0e..cd7187242`. No round-2 fix widened a predicate (R43, all three experts).

### Findings
- **Functionality**
  - F6, F9 and F10 are resolved. F7 is partly resolved and became NF1.
  - NF1 Minor: the idle/absolute rows' behaviour text was extension-only after F7 added the iOS
    token.
  - NF2 Minor: the renderSql refusal had no error code, and validateRegistry did not catch a
    digest identifier at boot.
  - NF3 Minor [Adjacent]: same as S3-1.
  - NF4 Minor: three renderSql callers, not two.
- **Security**
  - N1 and M1 are resolved. C1 and N2 are partly resolved.
  - S3-1 Major: `u&` assembled across a `sqlIdentifier` splice bypassed the renderSql refusal.
  - S3-2 Major: a digest key hidden in a spread, `&&` or helper return inside an unresolved or
    non-token filter is not seen, and the declared residual misstated it.
  - S3-3 Major: raw SQL through the pg driver's `.query` is outside C7, and is undeclared.
  - S3-4 Minor: same-file `const` computed keys were cheaply resolvable.
  - S3-5 Minor: `replacedByHash` is a digest column outside the class.
- **Testing**
  - N-1 to N-5 are resolved.
  - T3-1 Minor: the renderSql captured-exec has no tamper cell.
  - T3-2 Minor: the gate's case-insensitivity is unpinned.
  - T3-3 Minor: one unguarded replace remains.
  - T3-4 Minor: the lookup count is unanchored.
  - T3-5 Minor: the "writes nothing" negative cannot see a deferred write.

### User decision
After three rounds of escape spellings in C7, with no runtime-control defect since round 2, the
user chose to draw the line:
- fix our own overstated claims and the cheap items;
- declare C7 a best-effort detection gate (R49 tripwire class);
- record the rest as residuals with Anti-Deferral entries;
- give exhaustive coverage its own follow-up issue;
- confirm in round 4, then open the PR.

### Resolution Status (round 3)
- **S3-1/NF3:** renderSql also refuses `u&`/`uescape`, through a captured exec, with deny and
  allow cells.
- **NF2:** the refusals carry stable codes (`RAW_SQL_DIGEST_COLUMN`, `RAW_SQL_UNICODE_ESCAPE`),
  and validateRegistry refuses a digest identifier at boot.
- **T3-1:** tamper cells added.
- **S3-5:** `replacedByHash` was added to the gate's key and column sets, the pre-filter, and
  renderSql.
- **S3-4:** same-file `const` computed keys resolve.
- **T3-2/T3-3/T3-4:** fixed.
- **T3-5:** a structural no-DB-import cell, with a control import, red-proved by adding the
  import.
- **NF1:** the iOS precedence and error code are written out per client.
- **NF4:** both records list three callers.
- **S3-2/S3-3:** declared as residuals in the gate header, the plan's C7 and the deviation log
  ("Code review round 3 — residuals"), with measured costs:
  - refusing unreadable filters on every model surfaces 326 new functions;
  - more than one hop surfaces 7.
  
  The round-2 claims that overstated coverage are corrected in this file and in the deviation
  log.
- **Red proofs:** each new rule was mutated on a scratch copy, and each turned its cells red.
