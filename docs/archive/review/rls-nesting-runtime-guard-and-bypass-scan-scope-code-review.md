# Code Review: rls-nesting-runtime-guard-and-bypass-scan-scope
Date: 2026-10-17
Review round: 1 (fixes applied)

## Changes from Previous Round
Initial review. Branch commits reviewed: `2978de2b6` (check-bypass-rls cross-module following; check-team-auth-rls replaced by a runtime test) and `85bb2cda8` (check-rls-nesting; structured log on refused nesting). No plan file exists for this branch. Reviewers were given the user-approved requirements and the implementation decisions in their place.

Local LLM pre-screening and functionality seed: unavailable (server down). Security seed: "No findings". Testing seed: 3 findings (dispositions below). Merge was done by hand (Ollama unavailable).

## Functionality Findings
- **F1 [Major]** check-rls-nesting treats a call through a parameter that is not a wrapper's callback as harmless (fail-open).
  - Executed fixtures: `[opener].map((f) => f())`, and a `makeRunner(f) => () => f()` closure called in a callback. Both pass the gate.
- **F2 [Major]** check-bypass-rls `followClientInto` memoises an incomplete result for functions inside a call cycle. Which file is missed depends on file order.
  - Executed fixture: a cross-module `cycA`/`cycB` pair entered from two files with different allowlists.
- **F3 [Major]** check-bypass-rls counts interface implementations found in test files. A `vi.fn()` mock in a test reddens the production gate. The nesting gate already skips non-production implementations, so the two gates decide the same question differently (R48).
- **F4 [Major]** `CONDITIONAL_OPENER_ALLOWLIST` is keyed `file::callee`, so it also exempts a `derivePasskeyState` call that omits `tx`.
  - Executed: removing `tx` from the second `derivePasskeyState` call in `src/lib/mcp/oauth-server.ts` still passes.
  - Merged with S9 and T3-adjacent (three perspectives converge).
- **F5 [Major]** check-bypass-rls does not follow an own-code callee that reaches the ambient `prisma` proxy without being handed a client. This gap was not declared in the header.
- **F6 [Major]** Treating a non-literal index into a const table as every member is wrong when the table gains members after its initializer (`T.b = …`). Affects both gates.
- **F7 [Minor]** check-rls-nesting filters base-helper callbacks by type, so an `any`-typed callback is never checked. Merged with S4.
- **F8 [Minor]** Implicit invocations (getters, tagged templates) are not discovered as calls. Merged with S4.
- **F9 [Minor]** The forwarded-purpose rule matches annotation text:
  - `purpose: BypassPurpose` is a false positive.
  - A raw literal passed through a forwarder is a false negative.
  - The ALLOWED_PURPOSES pin is not applied through forwarders.
  - Merged with S6.

## Security Findings
- **S1 [Major]** check-bypass-rls misses client hand-offs wrapped in an object literal or passed as a `new` argument. The OK line still says "all followed".
  - Live case: `derivePasskeyState({ …, tx })` in `oauth-server.ts` reaches `webAuthnCredential` and `tenant`. Neither model is on that file's allowlist.
- **S2 [Major]** Both gates resolve a class method to its declared body only, so subclass overrides fail open.
- **S3 [Major]** check-rls-nesting does not recognize a context opened via `.apply`, `.bind` or a spread call.
- **S4 [Minor]** Getter, tagged-template and thenable invocations, and non-callable-typed callbacks, are not followed. Merged with F7 and F8.
- **S5 [Minor]** The STRANDED_ROW_MODELS grant also permits direct writes in `tenant-realignment.ts` and `tenant-domain.ts`. The grant is not bound to the stranded-rows callee.
- **S6 [Minor]** The ALLOWED_PURPOSES pin can be defeated by shadowing `BYPASS_PURPOSE`. Merged into F9.
- **S7 [Minor]** Production operator scripts and a worker are unscanned and not named in either header:
  - `migrate-account-tokens-to-encrypted.ts`
  - `migrate-webhook-secrets-v1-to-v2.ts`
  - `audit-chain-verify-worker.ts`
- **S8 [Minor]** Docs and comments overstate check-rls-nesting as rejecting any nesting.
- **S9 [Minor]** Merged into F4.

## Testing Findings
- **T1 [Major]** The EXTRA_SCAN_FILES scope of check-rls-nesting and its stale-factory check are untested. Removing the scope line stays green.
- **T2 [Major]** Over-breadth of EXTERNAL_SHAPE_ALLOWLIST is undetected. There are no allow or deny fixtures.
- **T3 [Major]** File scoping of CONDITIONAL_OPENER_ALLOWLIST is unpinned. A file-blind mutation stays green.

## Adjacent Findings
- T3 [Adjacent] Minor: the CONDITIONAL_OPENER_ALLOWLIST key ignores the argument. Routed to F4.

## Quality Warnings
None. Every Major finding carries an executed fixture or mutation.

## Seed Finding Disposition
- Functionality: seed unavailable, no dispositions to record.
- Security: seed analyzer returned No findings, no dispositions to record.
- Testing:
  - Seed 1: verified, adopted as T1.
  - Seed 2: rejected. A partial capture reddens the pass test through the over-breadth check (proven).
  - Seed 3: rejected. CI and pre-pr run the real-tree gate and judge it by exit status.

## Recurring Issue Check
### Functionality expert
- Checked: R1, R3, R17, R29 (F3), R44, R45, R46, R50
- Findings: R42 (F1, F5, F8), R47 (F9), R48 (F3), R49 (F1, F5), R52 (F2)
- N/A: all other rules

### Security expert
- OK: R44, R48, R50, RS1–RS4
- Partial: R3 (S3), R52 (S1)
- Fail: R29 (S7, S8), R42 (S1, S7), R43 (S5, S9), R46 (S6), R47 (S3, S4), R49 (S1, S2, S8)
- N/A: all other rules

### Testing expert
- OK: R19, R21 (red proofs re-run), R29, R33, R44, RT1, RT2, RT3, RT5, RT6, RT8, RT9, RT11
- Minor note, not adopted: R50 (no real-tree coverage floor)
- Fail: RT7 (T1–T3), RT10 (T2, T3)
- N/A: all other rules

## Environment Verification Report
N/A — no environment constraints declared in Phase 1.

## Resolution Status

Mechanism change before instance fixes. Most findings were members of two classes:

- **Enumerated invocation forms.** An invocation was recognized only when written in one of a listed set of forms (F1, F7, F8, S3, S4). Value references are now checked wherever they appear (array, object, `.bind`/`.call`/`.apply` receiver, argument). Callbacks are located by declared position. A context function used as a value fails the run.
- **Two copies of one resolution answer, disagreeing** (F3, F6, S2). The answer now lives in one module, `scripts/checks/lib/function-resolver.mjs`, which both gates use.

Every remedy clause below was red-proven separately on a scratchpad copy. There were 28 single-clause mutations, and each reddened the test that names it. Mutation N5 (tagged templates) at first stayed green because the reference rule also caught the case. The test now pins the invocation form ("calls tag"), and N5 reddens it.

### F1 [Major] Calls through a parameter treated as harmless
- Action: `classifyParameter` (shared resolver) decides by where the function value comes from:
  - A parameter of an inline callback is library code only when its signature is declared by a library. Otherwise it is unresolved.
  - A parameter of the enclosing function is checked where it is passed.
  - A captured parameter is resolved through its production callers.
  - Value references inside a callback, including `[opener]`, are judged as "hands on".
- Tests: closure, array, and inline-parameter deny cases; Promise `resolve` allow case.
- Mutations: LIB3, LIB3b, LIB3c, N2.

### F2 [Major] Cycle memo stored incomplete results
- Action: `followClientInto` tracks keys still open and memoises only results that depended on none.
- Test: cross-module `cycA`/`cycB` entered from two files; both files are charged both models.
- Mutation: BP1.

### F3 [Major] Test-file implementations counted (R48)
- Action: The shared resolver ignores implementations outside production. The two gates now share one rule.
- Test: a `vi.fn()`-style test implementation leaves the production gate green.
- Mutation: LIB2.

### F4 / S9 / T3-adjacent [Major] Conditional opener exempted by name
- Action: An entry is now `{ file, callee }`. A call is exempt only when its first argument has a `tx` property bound to a parameter of an enclosing function.
- Tests:
  - allow case;
  - three deny cases: tx omitted, `tx: undefined`, a non-parameter tx;
  - a deny case from another file;
  - a stale entry.
- Mutations: N9, N10.

### F5 [Major] Ambient prisma reach unfollowed
- Action: An own callee handed no client is followed with the ambient client, both same-file and cross-module. Calls on the client or its delegates are excluded.
- Tests: the same-file and the cross-module variant.
- Mutation: BP3.

### F6 [Major] Const table mutated after its initializer
- Action: `tableOf` refuses a table with any production reference that is not a read or a key enumeration. The rule is shared by both gates.
- Tests: deny case in both gates; allow case (`Object.keys` plus index).
- Mutation: LIB4.

### S1 [Major] Object-wrapped and `new` hand-offs missed
- Action:
  - Clients handed as a property of an object argument are followed into the destructured parameter or `param.key`.
  - An array, spread, nested-object or constructor hand-off fails the run.
  - The live reach was added to the allowlist after review: `oauth-server.ts` gets `webAuthnCredential` and `tenant` (`derivePasskeyState`).
- Tests: property and shorthand follow cases; constructor, array and nested-object refusals.
- Mutations: BP5, BP5b, BP6.

### S2 [Major] Subclass overrides missed (both gates)
- Action: A class method resolves to itself plus every production override (`withOverrides`).
- Tests: nesting gate via `this.step()`; bypass gate via a base-typed receiver.
- Mutation: LIB7.

### S3 [Major] Context opened via `.apply`, `.bind` or spread
- Action:
  - A context function used as a value fails the run.
  - A spread argument before the callback position fails the run.
  - `.call` and `.apply` are not treated as positional context calls.
- Tests: `.apply`, `.call`, a library holding the helper, spread.
- Mutations: N1, N7, N8.

### F7 / F8 / S4 [Minor] Implicit invocations and `any`-typed callbacks
- Action:
  - Tagged templates, own getters/setters, and `await` of an own `then` are treated as invocations.
  - Base-helper callbacks are taken by declared position.
  - Uncovered forms are listed in the header: iterator protocol, implicit conversions, Proxy traps, decorators, library-registered callbacks.
- Tests: getter, tagged template, thenable (each pinned to "calls"); `any`-typed callback.
- Mutations: N4, N5, N6.

### F9 / S6 [Minor] Purpose decided by name and annotation text
- Action:
  - The purpose argument must resolve through the Program to the real `BYPASS_PURPOSE`, including a destructured dynamic import.
  - A forwarder is recognized by its parameter TYPE.
  - Every production caller of a forwarder is checked against that caller's ALLOWED_PURPOSES.
- Tests:
  - shadowing refused;
  - dynamic-import destructure accepted;
  - `BypassPurpose` alias accepted;
  - raw literal through a forwarder refused;
  - a pinned file calling a forwarder with a disallowed member refused, and with an allowed member accepted.
- Mutations: BP10, BP11.

### S5 [Minor] STRANDED_ROW_MODELS granted to direct code
- Action:
  - `ALLOWED_VIA` grants the 21 models only to reach whose site is in `src/lib/tenant/stranded-rows.ts`. Direct entries return to `tenantMember`/`user`/`auditOutbox`.
  - Via grants are stale-checked per model.
- Tests: via allow case; direct write refused; unused via grant refused.
- Mutations: BP8, BP9.

### S7 [Minor] Unscanned production scripts
- Action:
  - Production is now `src/` plus `scripts/`, minus tests, CI tooling (`NON_PRODUCTION_SCRIPTS`) and `scripts/manual-tests` (`isProductionPath`). This replaces the hand-kept `EXTRA_SCAN_FILES`. An unlisted script is production by default (fail-closed).
  - New entries after review: `migrate-account-tokens-to-encrypted.ts` (raw SQL only) and `migrate-webhook-secrets-v1-to-v2.ts` (`teamWebhook`, `tenantWebhook`), both pinned to SYSTEM_MAINTENANCE.
  - `scripts/lib/assert-bypass-rls-active.ts::TxProbe` was added as an SDK-shaped type.
- Tests:
  - an unlisted script is scanned;
  - `manual-tests` and tooling are not scanned;
  - `scripts/lib` openers are counted;
  - the listed tooling files exist.
- Mutations: LIB12, LIB12b, LIB12c.

### S8 [Minor] Docs overstate the nesting gate
- Action: `security-review.md` and the `tenant-rls.ts` docblock now name the runtime guard as the boundary. The static gate is described as a development-time check with listed limits. Both gate headers were rewritten to match.

### T1 [Major] EXTRA_SCAN_FILES and stale-factory untested
- Action: EXTRA_SCAN_FILES and LIBRARY_FACTORY_ALLOWLIST were removed. A library-returned function is now judged by where its call signature is declared, which removed the factory list and its coupling to tenant-domain.ts. Scope tests cover `scripts/tenant-domain.ts`, `scripts/lib` and `manual-tests`.
- Mutation: LIB12c.

### T2 [Major] EXTERNAL_SHAPE_ALLOWLIST over-breadth undetected
- Action: deny fixture (an unlisted interface with no implementation), allow fixture (listed SdkClient), stale fixture.
- Mutation: LIB11.

### T3 [Major] Conditional-allowlist file scoping unpinned
- Action: deny case from a file the allowlist does not name.
- Mutation: N10.

### Verification (round 1 fixes)
| Check | Result |
|---|---|
| vitest | 16,927 passed, 1 failed |
| typecheck | pass |
| lint | pass |
| `next build` | pass |
| migration check | OK |
| check-rls-nesting (real tree) | OK — 1,046 files, 471 openers, 6 context functions, 598 callbacks |
| check-bypass-rls (real tree) | OK — 46 cross-module hand-offs, all followed |

The one vitest failure is `crypto-auth-deps-manifest` (E). It is caused by the pre-existing uncommitted `passwd-sso-cli` dependency in `package.json`. Removing only that line in an isolated copy turns it green (51/51). It is not part of this branch.

Runtime cost: check-rls-nesting takes about 43 s and check-bypass-rls about 40 s on the real tree.
