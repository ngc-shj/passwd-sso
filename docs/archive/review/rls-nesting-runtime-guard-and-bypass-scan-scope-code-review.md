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

---

# Round 2
Date: 2026-10-17
Diff reviewed: `85bb2cda8..dd1e8ce1b` (review(1)). Ollama was unavailable, so the merge was done by hand.

## Changes from Previous Round
- Round-1 status:
  - Resolved: F2, F3, F6, F7/F8, S1-methods, S2-methods, S3, S5, S7, S8, T1–T3.
  - Regressed: F1 (see N1).
  - Partial: F4/S9 (see C1), F5 (see B2), S1 (see B1).
- New findings: 12 Major, 9 Minor. Two of the Majors were seeded by the round-1 fix itself:
  - N1, a regression against `85bb2cda8`;
  - P1, a widening of the purpose pin (R43).
- Of the 28 recorded mutations, the testing expert sampled 10 and confirmed 8 of them. M4 and M6 stayed green.

## Merged findings (round 2)
- **N1 [Major, regression]** The nesting gate drops a parameter result the wrapper fixpoint did not register. These forms now pass: an alias, `fn.call`, `{ run: fn }`, `fn: any`.
- **B1 [Major]** A client handed inside an object is lost once the container is destructured, aliased, passed on, or held in a variable.
- **B2 [Major]** Ambient following recognises only the identifier `prisma`. Import aliases and namespaces are missed; a live case is `emergency-access-server.ts`.
- **P1 [Major, R43]** The forwarder pass ignores the forwarder file's own ALLOWED_PURPOSES.
- **C1 = SN6 = T5 [Major]** (three perspectives) The conditional-opener exemption accepts any enclosing parameter as `tx`, including an optional outer one.
- **SN1 [Major, R43]** `hasLibrarySignature` reads an own function stored behind a library-declared type (`VoidFunction` via `Map.get` or a `forEach` parameter) as library code.
- **SN2 [Major]** Writes not spelled `x = …` are invisible in both gates: member assignment on a const object, destructuring assignment.
- **SN3 [Major]** Inherited constructors, `super()` and field initializers are not followed.
- **SN4 [Major, R48]** The bypass gate's ambient follow skips own functions handed to library calls as values. The nesting gate rejects the same shape.
- **T4 [Major]** The ALLOWED_VIA site clause is unpinned (mutation M4 stays green).
- **T6 [Major]** The forwarder chain and non-direct use are unpinned (G7, G8 green).
- **T7 [Major]** The resolver's fail-closed reasons are unpinned (G3, G4, G12, G13 green).
- **Minor:**
  - SN5: NON_PRODUCTION_SCRIPTS imported by production code is not detected.
  - SN7: the oauth-server grant should be ALLOWED_VIA through passkey-enforcement.ts.
  - SA1: an aliased helper import is a false positive.
  - M1: the read-only claim on ALLOWED_VIA is wrong.
  - T8: setters are untested.
  - T9: the via entry-level stale check is unpinned.
  - T10: `thenOf` property path, type-alias shape and the `Function` clause are unpinned.

## Root-cause note
B1, B2, SN4 and N1 are members of the class round 1 tried to close: a predicate decided by a NAME (the bypass gate's name-keyed client set, the wrapper parameter's spelling). SN2 and SN3 are the resolver's remaining surface-form predicates (R47). The class has now expanded twice. Per Step 3-8, a class whose member set expands twice is closed only by changing the mechanism, not by adding cases.

## Resolution Status (round 2)

Decision (user, in the conversation): change the mechanism rather than add cases.

Mechanism:
- `lib/function-resolver.mjs` gains a shared REACHABILITY engine (`createReachability`). From a callback it reaches every invocation and every function-valued reference, through the shared resolver, and fails closed on what it cannot name.
- check-bypass-rls Check 3 no longer tracks client NAMES. In every reached function, an access whose receiver is a Prisma client BY TYPE is a model reached. The type test: the member is declared by the generated `PrismaClient`, or the value is a delegate by shape, or an `any` receiver is accessed under a model name.
- check-rls-nesting derives wrappers from parameter hits during reach, not from spellings.
- The name-flow machinery was deleted: clientBindingsIn, followClientInto, mergeHandOffs, modelRefsIn, calleeFunctionOf.

User review, received during this round. All three fixed:
- **U1 (critical):** a wrapper callback chosen by a conditional. Resolver results now carry a `params` SET, so every selectable parameter becomes a wrapper position. Tests: deny and allow. Mutation: P1.
- **U2 (critical):** a named callback handed to a library (`[1].map(readSession)`). Reach follows value references, and the type-based check charges `prisma.session`. Tests: map and Promise.all. Mutation: P2.
- **U3 (medium):** purpose and callback were taken from any argument.
  - Purpose is now read only at withBypassRls's declared purpose position.
  - The callback is read only at the declared callback position, both in Check 3 roots and in `callbackOf` (C2/F3).
  - 15 fixtures that wrote the arguments in a non-real order were moved to the real order.
  - Mutations: P3 (purpose), P4 (callback roots), P23 (`callbackOf`). P4 was first green; its test now passes the real callback by reference so a decoy literal would be chosen by a "first function" picker.

| Finding | Resolution | Mutation |
|---|---|---|
| N1 | Wrappers derived from reach (alias, `.call`, object member, `any` all derive); 5 tests | P12 |
| B1 / B2 / SN4 | No name is tracked; container destructure, alias, rename, prebuilt args, import alias, namespace, and value-passed functions are all charged by type; 8 tests | P2, P6 |
| P1 | Forwarder pins travel along the chain; a pinned file's forwarder called from an unpinned file is refused | P5 |
| C1 / SN6 / T5 | Exempt only when `tx` is the root callback's own first parameter; an outer or optional parameter is refused (test) | — |
| SN1 | Library values judged on the UNINSTANTIATED declaration: a type parameter (`Map.get`'s `V`, `forEach`'s `T`) is ours-possible and unresolved; a function type or concrete library type (Promise `resolve`, `NodeRequire`) is library. LIBRARY_FACTORY_ALLOWLIST and `hasLibrarySignature` were removed | P10, P11 |
| SN2 | Writes classified by the language service (`isWriteAccess`); member writes merged; Object.assign / computed-key writes and non-plain writes unresolved | P9, P9b, P22 |
| SN3 | Classes are construction units (instance field initializers, constructor, base chain); `super()` resolves to the base | P8, P8b |
| SN5 | Production may not import a listed tooling script, and listed tooling may not import tenant-rls / tenant-context / prisma | P14 |
| SN7 | oauth-server's passkey reads moved to ALLOWED_VIA via passkey-enforcement.ts. The newly visible reach of emergency-access/[id]/vault (user, auditOutbox through the in-tx audit) was added as ALLOWED_VIA, not file-wide | — |
| SA1 | Aliased helper import passes (test) | — |
| T4 | Via grant bound to the via module (test) | P15 |
| T6 | Forwarder chain and aliased forwarder (tests) | P17, P18 |
| T7 | Resolver refusals name themselves: compound/destructuring writes, non-direct setter, spread, rest (tests) | P22 |
| T8 | Setter invocation (test) | P19 |
| T9 | Via entry-level stale (test) | P16 |
| T10 | `then` as a property assignment and type-alias SDK shape (tests). The `Function` clause was removed with `hasLibrarySignature` | P20, P21 |
| M1 | ALLOWED_VIA comment corrected: the grant is site-based, not read-only | — |

Removed as dead after mutation P13 stayed green: the optional/initializer clause of the conditional-opener check. withBypassRls always passes its client, so the root callback's first parameter is always defined.

Mutation runs: 24 single-clause mutations (P1–P23, plus P8b/P9b). Each reddened its own test after the two test fixes above.

Real-tree runs:
- check-rls-nesting: OK — 1,046 files, 6 context functions, 594 callbacks, about 41 s.
- check-bypass-rls: OK — 214 bypass callbacks followed through 958 reached functions, about 23 s. The only newly visible reach was emergency-access/[id]/vault, granted via its modules.


---

# Round 3
Date: 2026-10-17
Diff reviewed: `dd1e8ce1b..47d53b9e6` (review(2), the reach-and-types mechanism).

## Changes from Previous Round
- Round-2 status:
  - Resolved: N1, U1, U3, SN3, SN7, B1, B2, SN4, U2, P1, SA1, M1, T4–T10.
  - Reopened: SN1 — it holds only under the nesting fixture's `strict: false`.
  - Partial: SN2, SN5, C1/SN6.
- Review-log correction (N-T12): the round-2 table claimed P9/P9b/P22 pinned the SN2 Object.assign and computed-key refusals, and that a test pinned T7's rest refusal. Mutations Q15, Q16 and Q42 stayed green, so both claims were false. From this round on, every mutation ID is recorded with the clause it changes and the test it reddens.

## Merged findings (round 3)
- **R3-S1 = F1 + F7 [Critical, regression]** Lexical containment is lost. Function literals that are not direct call arguments (object members, array elements, a library-held object such as `ReadableStream({ start })`) and class static initializers or blocks inside a reached unit are neither charged nor checked. `dd1e8ce1b` scanned the callback's whole subtree.
- **R3-S2 = F2 [Major]** Callability is decided on the instantiated type. Under the real `strict: true`, `T | undefined` and `any` have no call signatures, so `Map.get(...)?.()`, `Reflect.get(...)()` and `[1].map(x!)` read as library code. The nesting fixture's `strict: false` hid this (R48).
- **R3-S3 = F6 [Major]** `isUntypedClientApi` and the any-receiver model-name arms treat own `any` objects as Prisma API.
- **R3-S5 [Major]** The conditional-opener exemption ignores a later spread that overrides `tx`.
- **F3 [Major]** An own invoker's argument is assumed reached.
- **F4 [Major]** `.bind` result: a module-level `opener.bind(null)` is judged library-made.
- **F5 [Major]** A client handed to library code is no longer reported.
- **F8 [Major]** Function values read through element access are not edges.
- **F9 [Major]** Member writes are unseen: `ops["run"] =`, `Object.assign` on an alias, on a parameter, or on a nested object.
- **N-T1..N-T5 [Major]** Clauses no test pins: valueReached re-enqueue, bypass `follow`, the delegate member-type path, the Object.assign and computed-key refusals, the boundary re-export.
- **Minor:**
  - F10: a class property holding a function reports "cyclic definition".
  - F11 = R3-S4: the boundary check misses `import()` and `require()`.
  - F12: a library holding the ambient client is not listed in the header.
  - R3-S6: header claims are stronger than the code.
  - N-T6..N-T11: rest-refusal assertion, allow-side branches, the dead forwarded-param branch, spread refusals, the index-derivation failure paths, stub/real divergence.

## Resolution Status (round 3)

| Finding | Resolution | Mutation |
|---|---|---|
| R3-S1 = F1 + F7 | Lexical-containment floor: a reached unit owns its whole subtree (type positions excepted). A class unit owns its field initializers and static blocks | R3-M1, R3-M1b |
| R3-S2 = F2 | `mayBeCallable` reads the call signatures of each non-nullable union member. The nesting fixture now runs `strict: true` | R3-M2, R3-M2b |
| R3-S3 = F6 | `isUntypedClientApi` and the any-receiver model-name arms were removed. A client is recognised by type only: a member declared by the generated `PrismaClient`, or a delegate shape | R3-M24 |
| R3-S5 | The conditional-opener exemption requires an object literal with no spread and exactly one `tx` | R3-M18 |
| F3 | An inline literal passed to an own invoker resolves to what that invoker passes at that position | R3-M8 |
| F4 | `.bind` resolves to its receiver. A library receiver is external | R3-M6, R3-M7 |
| F5 | A client handed to a library call inside reached code fails the run (`clientHandedToLibrary`) | R3-M21 |
| F8 | Element access in value position with a callable type is an edge | R3-M9 |
| F9 / N-T4 | Writes are classified by the language service. A string-key write is merged. `Object.assign` and the other object mutators, and computed keys, are unresolved. An alias or own-callee parameter holding the object is followed | R3-M10–M14 |
| F10 | A class property resolves to its initializer plus its writes | R3-M15 |
| F11 = R3-S4 | The boundary check covers literal `import()` and `require()`. Non-literal loads are listed in the header | R3-M19 |
| F12 / R3-S6 | The bypass header lists the module-level `makeRepo(prisma)` limit and the `any`-erased client. The stale "an `any` receiver counts" clause was removed | — |
| N-T1 / N-T2 / N-T3 / N-T5 | valueReached re-enqueue, bypass wrapper follow, the delegate member-type path, the boundary re-export: each now has a test | R3-M16, R3-M23, R3-M24, R3-M20 |
| N-T6 | The rest-parameter test asserts the refusal's own reason | R3-M17 |
| N-T7 | Moot: the `isUntypedClientApi` branch was removed with R3-S3 | — |
| N-T8 | Check 3's forwarded-parameter refusal is reachable only for a file on both INDIRECT_CALLBACK_ALLOWLIST and ALLOWED_USAGE. C2 refuses the same shape everywhere else. A test pins that no file is on both lists. The refusal stays as defence; R3-M22 is green by construction | R3-M22 (see note) |
| N-T9 | Spread at the purpose position: refused at a direct call (the purpose is not read off a shifted position) and at a forwarder call | R3-M25, R3-M26 |
| N-T10 | `CALLBACK_INDEX` / `PURPOSE_INDEX` derivation failure stops the run with PROGRAM_BUILD_FAILED | R3-M27, R3-M28 |
| N-T11 | The bypass stub's PrismaClient is generated from `prisma/schema.prisma` with no index signature. `TransactionClient` omits `$connect`/`$on`. The nesting stub carries model getters | — |
| N-T12 | This table: every mutation is listed below with its clause and the test filter it reddens | — |
| ADJ-1 | `.call`/`.apply` in `resolveCall`: allow test (an own factory's result through `.call`). `functionArgsOf`: deny test (a library result typed `Function` built from an own function). The `.bind/.call/.apply` receiver reference was already pinned by the nesting `.bind` test. `isPackageModuleLoad` was removed as dead (below) | ADJ-A1, ADJ-A2, ADJ-A4 |

Removed as dead after ADJ-A3 stayed green: `isPackageModuleLoad`. In every case it ran, the generic library branch returned the same external result: a dynamic `import()` yields a Promise, which is not callable, and `require`'s declared `any` return is judged library-made.

Removed as dead after R3-M4 stayed green: the `IndexedAccessType` clause of `isLibraryMadeTypeNode`. A type parameter reached through an indexed access is already caught by the type-parameter reference check.

### Mutation record (round 3)

Each mutation changes one clause in a copy of the gates and runs `npx vitest run <test file> -t "<filter>"`. "Red" means that run failed.

| ID | File | Clause changed | Test file | `-t` filter | Result |
|---|---|---|---|---|---|
| R3-M1 | function-resolver | lexical floor (non-argument literals and classes skipped) | bypass | `everything written inside` | red |
| R3-M1b | function-resolver | same | nesting | `fails an opener inside` | red |
| R3-M2 | function-resolver | `mayBeCallable` without `getNonNullableType` | bypass | `Map.get` | red |
| R3-M2b | function-resolver | same | nesting | `nullable library value` | red |
| R3-M3 | function-resolver | any/unknown invoked value not treated as a function | bypass | `returns as any` | red (green before the test was added) |
| R3-M4 | function-resolver | `IndexedAccessType` clause | bypass | `Reflect.get` | green → clause removed |
| R3-M5 | function-resolver | other declared shapes judged library-made | bypass | `Reflect.get` | red |
| R3-M6 | function-resolver | `.bind` own target dropped | bypass | `module-level bound` | red |
| R3-M7 | function-resolver | `.bind` library receiver unresolved | nesting | `library method bound` | red |
| R3-M8 | function-resolver | own invoker's arguments dropped | bypass | `own invoker passes` | red (green before the test was added) |
| R3-M9 | function-resolver | element-access value edges | bypass | `read off a table` | red |
| R3-M10 | function-resolver | `Object.assign` refusal | bypass | `Object.assign` | red |
| R3-M11 | function-resolver | computed-key write refusal | bypass | `a computed key` | red |
| R3-M12 | function-resolver | string-key write ignored | bypass | `string key` | red |
| R3-M13 | function-resolver | object alias not followed | bypass | `on an alias` | red |
| R3-M14 | function-resolver | own-callee parameter not followed | bypass | `parameter it is handed to` | red |
| R3-M15 | function-resolver | class property initializer dropped | bypass | `class field` | red (green before the test was added) |
| R3-M16 | function-resolver | valueReached re-enqueue | bypass | `re-queues` | red |
| R3-M17 | function-resolver | rest-parameter refusal | nesting | `rest parameter` | red |
| R3-M18 | check-rls-nesting | conditional-exemption spread check | nesting | `spread may override` | red |
| R3-M19 | check-rls-nesting | dynamic `import()`/`require()` boundary | nesting | `dynamically` | red |
| R3-M20 | check-rls-nesting | re-export boundary | nesting | `re-exports` | red |
| R3-M21 | check-bypass-rls | client handed to library | bypass | `handed to library code` | red |
| R3-M22 | check-bypass-rls | forwarded-param refusal in `bypassRootsOf` | bypass | `own callback parameter` | green (see N-T8; pinned by `disjoint`) |
| R3-M23 | check-bypass-rls | bypass wrapper follow of an ancestor parameter | bypass | `run inside its bypass callback` | red |
| R3-M24 | check-bypass-rls | delegate member-type path | bypass | `own type that holds one` | red |
| R3-M25 | check-bypass-rls | direct-call purpose spread check | bypass | `spread has shifted` | red |
| R3-M26 | check-bypass-rls | forwarder purpose spread check | bypass | `forwarder takes its purpose` | red |
| R3-M27 | check-bypass-rls | `CALLBACK_INDEX` failure | bypass | `declares no callback` | red |
| R3-M28 | check-bypass-rls | `PURPOSE_INDEX` failure | bypass | `declares no purpose` | red |
| ADJ-A1 | function-resolver | `.call`/`.apply` branch of `resolveCall` | bypass | `own factory invoked through` | red |
| ADJ-A2 | function-resolver | `functionArgsOf` in the library-result merge | bypass | `result is typed Function` | red |
| ADJ-A3 | function-resolver | `isPackageModuleLoad` | both, all tests | — | green → removed |
| ADJ-A4 | function-resolver | `.bind/.call/.apply` receiver as a value reference | nesting | `bound with .bind` | red |


---

# Round 4
Date: 2026-10-17
Diff reviewed: `47d53b9e6..77cb92b61` (review(3)). Ollama was not used; the findings were merged by hand.

## Changes from Previous Round
- Round-3 status:
  - Confirmed by execution: R3-S1, R3-S2 (resolveValue site only), R3-S3, F4 (identifier receiver), F8, F10 (base-class field only).
  - Partly false: F5, F9, F11 (`require()` half), R3-S5, N-T8.
  - Not recorded: the round-3 change to the production boundary predicate.
- Mutation record: 29 of 31 re-ran as recorded. R3-M2 / M2b do not reproduce as described. The union split and `getNonNullableType` each cover the other, so dropping either one stays green.
- Three round-3 changes are regressions against `47d53b9e6`: F1 = S1, F2 = S2, and S4. A fourth change, F11, adds a false positive.

## Merged findings (round 4)
- **R4-C1 = F1 + S1 [Critical, regression]** A class field resolves to its own initializer plus its property writes. The F10 change dropped implementation lookup. Missed shapes: a subclass override (`override run = opener`) and the constructor idiom `Object.assign(this, opts)`. Both were refused at `47d53b9e6`.
- **R4-C2 = F2 + S2 [Critical, regression, R43]** The boundary was narrowed from "not production" to "declared non-production". Production may now import a root `.ts`, a `.js` under `src/`, or a `.js` behind its own `.d.ts`. Neither gate scans those files. The real tree is green under the old predicate. S2 asks for the remedy to be decided at contract level: the scan set should be the import closure, not a path prefix.
- **R4-C3 = S3 [Critical, continuing]** `const { f } = await import("@/lib/own")` is judged library code by both gates. Production uses this idiom: webhook-dispatcher, audit-outbox-worker, instrumentation.
- **R4-C4 = T1 [Critical]** The strict-callability fix is unpinned at `referenceValueOf` and the element-access edge (O23, O24).
- **R4-C5 = T2 [Critical]** The delegate property-access arm of `modelAccessOf` is unpinned (O36).
- **R4-C6 = T-A1 [Critical]** A nested object replaced by plain assignment (`cfg.inner = { run }`, `Object.assign(cfg, { inner })`) is invisible to both gates.
- **R4-C7 = T-A2 [Critical]** A library result handed straight to an own invoker is never resolved: `retry(registry.get("a")!)`, `[1].forEach(Reflect.get(o, "f"))`.
- **Major:**
  - F3 + T3: object writes through `as`/`()`/`!`, a let alias, a container alias, the nested path, a library mutator, and the other OBJECT_MUTATORS. An unrecognised use defaults to a read.
  - F4: an own object with function members, built outside and handed to a library inside reached code.
  - F5 + S5: a client handed to a library inside an object, an array, a spread, a closure return, or a mixed own/library callee.
  - F6 + S8: the boundary skips `require()` in `.ts` files and side-effect `import()`.
  - S4 (regression): `(tx as any).user` is not charged.
  - S6: via-granted models can be written by the caller through a returned delegate.
  - S7: the conditional-opener entry exempts the whole callee.
  - S9: the tooling boundary compares direct-import paths and is defeated by a re-export.
  - S10: `["*"]` on `src/auth.ts` and `vault-reset.ts`.
  - S11: the docs say the gates fail closed.
  - T4: the `bypassRootsOf` arms are unreachable, so the N-T8 defence claim is false. The disjointness test parses the source by regex.
  - T5, T6: further unpinned deny arms.
- **Minor:** F7–F10, S12, S13 (UNVERIFIED), T7, T8, the stale "77 files" count in security-review.md.
- **F11 [Minor, regression, false positive]** `if (cb) cb(...)` in an own invoker is refused.

## Root-cause note
This is the fourth round in which the member set of "code the gate cannot see" has grown:
- Round 1 enumerated spellings.
- Round 2 introduced the shared resolver.
- Round 3 moved to reach and types.
- Round 4 found a further 7 Critical findings. Three of them are regressions seeded by the round-3 fixes.

The pattern matches the stopping rule for a class that expands under fixes: more rounds of case-adding do not converge. Two directions are left:
- Restrict the reached code to a subset the gate can decide, and refuse everything outside it.
- Narrow the gate's claim and rely on the runtime guard, which is the stated boundary.

The user decides between them.

## Decision (round 4)
The user chose to restrict the analysis to a subset it can decide, and to refuse what falls outside it. The real-tree cost was measured before committing to that.

### Measured cost
- **Reach.** The resolver was instrumented to tag each edge with the data-flow followers it passed through. Then both gates were run on the real tree.
  - check-rls-nesting: 56 of 2,673 reached edges use any follower.
  - check-bypass-rls: 49 of 1,342 reached edges use any follower.
  - Edges where a follower supplies an own function:
    - interface implementations: 14
    - object-literal members: 8
    - returned functions: 4
  - Followers no real edge uses: class-field writes, parameter-from-callers, own-invoker arguments, element access, subclass overrides, `.call`/`.apply`.
- **Global rules.** These would make declaration-based resolution sound. The scan covered 1,046 production files:
  - G1, a write to an own property whose type may be callable: 0
  - G2, an object mutator on `this`, `any`, or an object with own callable members: 0
  - G3, a computed-key member holding a function: 0
  - G4, a callable constructor parameter property: 0

  A scratch tree with one injected violation per rule reports each of them, so the zero is not vacuous. The 41 writes to callable-typed members on the real tree all target library-declared properties: React ref `.current`, DOM `onload`/`onerror`, `Object.prototype.toString`/`valueOf`.
- **New finding (R4-O1).** `getImplementations` does not return an object literal or a class that implements an interface only structurally. Verified on a scratch tree: of `const a: Runner = {…}`, `const s = { run }` and `class C { run() {} }`, only the first is returned. The checker's `isTypeAssignableTo` is available.

### Mechanism
1. **Global rules G1–G4**, enforced over all production code. A function stored in an object or class member then holds only what its declaration says. This replaces the write-following machinery (`objectUses`, `writesThroughUse`, class-field `writesTo`, the mutation scan in `tableOf`). Closes F3/T3, T-A1 and the `Object.assign(this, …)` half of C1 by construction.
2. **Every function value in reached code must resolve.** Any expression of callable type in a value position counts, not only identifiers and element accesses. Closes T-A2, F7, F9 and T1. An own object with callable members, or a client inside an argument, is found by walking the argument's type. Closes F4, F5 and S5.
3. **Library-held own values.** A library property typed by a type parameter (`RefObject<T>.current`) is unresolved. So is an `any`/`unknown` callee at the invocation (F8).
4. **Interface dispatch.** The candidate set is every production member of that name whose owner type is assignable to the receiver type (R4-O1). Subclass overrides, of fields and methods alike, come from derived-class enumeration (C1).
5. **Scan set.** The scan set is the production import closure. Module resolution goes through the compiler, which makes `require()` and side-effect `import()` visible. The tooling boundary is judged over the closure. Closes C2, S8 and S9. A destructure from an own module's `import()` resolves through the property declaration (S3).
6. **Bypass gate:**
   - charge at the operation by the delegate's type (S4, S6);
   - measured lists replace `*` (S10);
   - the conditional exemption becomes per edge, with no writes to `tx` (S7, F10);
   - forwarder purpose parameters must not be written (S12);
   - list disjointness is checked inside the gate (T4).
7. **Mutation record.** Clauses that can never fire are deleted. Every remaining clause is pinned by its own mutation, recorded with the exact old→new text.

## Resolution Status (round 4)

Every finding is addressed by the mechanism above, not by an added case. The table names where each one is now decided.

| Finding | Resolution | Mutation |
|---|---|---|
| R4-C1 = F1 + S1 | A class member is that member in the class and in every production subclass (`classMemberValue`, derived classes by name). A field holds its initializer; G1 refuses any other write and G2 refuses `Object.assign(this, …)` | R2, R3, S1, S5 |
| R4-C2 = F2 + S2 | The scan set is the production import closure (`productionScope`). A module production loads is scanned and held to G1-G5 (root `sentry.server.config.ts` is now scanned). Own JavaScript and a declaration over own JavaScript are refused | S11, S12, S15, S15b, B5 |
| R4-C3 = S3 | A destructure from `import()`/`require()` resolves the module through the compiler and reads the export's declaration. A package is library code | R7 |
| R4-C4 = T1 | `mayBeCallable` at the value-reference and element-access sites is pinned by tests that exist only under strict | R15 |
| R4-C5 = T2 | Pinned by a deny test (`repo.user`) and an allow test (a non-delegate `user`). The query is also charged where it runs | B1 |
| R4-C6 = T-A1 | G1: a write of a function to an own member after its declaration is refused, whatever the path (`cfg.inner = …`) | S1, S4 |
| R4-C7 = T-A2 | Every function value in reached code is an edge, not only a name: a call's result, a conditional, an `await` | R10 |
| F3 + T3 | G1 and G2 replace the write-following machinery (`objectUses`, `writesThroughUse`, field `writesTo`, the table mutation scan). Casts, aliases and nested paths no longer matter | S1–S6 |
| F4 | The own functions an argument to library code carries as members are edges (`memberFunctionEdges`). A non-literal array of functions handed to a library is refused | R11, R11b |
| F5 + S5 | `carriesClient` walks unions, arrays, tuples, closure returns and own object members. A mixed own/library callee is checked | B2, B2b, B2c, B2d, B2f |
| F6 + S8 | Module loads resolve through `ts.resolveModuleName`, so `require()` in `.ts` and a side-effect `import()` count. A non-literal specifier outside `NON_LITERAL_LOAD_ALLOWLIST` is refused, and so is an own specifier that does not resolve | S10, S13, S13b, S14 |
| S4 | The query is charged where it runs, by its `<Model>Delegate` type, each member of a union. A delegate type with no model name is refused | B1, B1b, B7 |
| S6 | The operation-site charge applies to a via grant too: a delegate handed back is charged to the module that queries it | B1 |
| S7 + F10 | The conditional-opener entry exempts one guarded edge inside the callee. The rest of the callee is reached. The callee entered without the guard in the same context voids the exemption, and so does a reassigned client. A missing guarded site, or a written guard, stops the run | N1–N5 |
| S9 | The tooling boundary is judged over each tool's import closure | S16 |
| S10 | `src/auth.ts` and `vault-reset.ts` carry measured model lists. Stranded-row counts and the audit enqueue are granted through ALLOWED_VIA. Check 3 now runs for both | (real tree) |
| S11 | The docs now say what the gate decides and what it refuses. They no longer claim a blanket fail-closed | — |
| S12 | A forwarder's purpose parameter that is written is refused | B3 |
| S13 | Moot: the read-only callee list was removed with the write-following machinery. G2 identifies a mutator by the declaration the call resolves to, reached through its name or a one-step alias | S5, S5b |
| T4 | INDIRECT_CALLBACK_ALLOWLIST / ALLOWED_USAGE disjointness is checked inside the gate (B4) and replaces the regex test. The unreachable `bypassRootsOf` arms were removed. The two alternation assertions now pin one message each | B4 |
| T5, T6 | Covered by the clauses above, each with its own mutation. The own-invoker argument logic (`argumentsPassedTo`, O9–O13) was removed as redundant: everything an own invoker passes is a value in its reached body | — |
| T7 | `isInvokedOrHandedOn`, `memberNameOf`, `resolveObjectMember`, the `.bind`/`.call` receiver exceptions and `isPackageModuleLoad` were removed. The value-flow edges cover what they did | — |
| T8 | Both fixture stubs now follow the generated client: per-model `<Model>Delegate` types, no string index signature, no callable delegate. The bypass fixtures carry the real `stranded-rows.ts` | — |
| F7, F9 | Both are value edges now (an element-access receiver of `.bind`, a private field) | R12 |
| F8 | An `any`/`unknown` callee that resolves to no own code is refused. A value from a known library module is the exception (`LIBRARY_MODULE`) | R5, R6, R6b |
| F11 | The false positive went away with `argumentsPassedTo` | — |
| R4-O1 | An interface member is every production member of that name. A member only tests supply resolves to nothing in production | R1x, R1b, R1c |
| ADJ1 | The security-review count is now 101 entries | — |

New allowlist entries the real tree needed, each reviewed:
- `EXTERNAL_SHAPE_ALLOWLIST`: `AwsSmModule`, `AzureKvModule`, `AzureIdentityModule`, `GcpSmModule`. These are the SDK module shapes the key providers cast `require()` results to.
- `FUNCTION_FLOW_ALLOWLIST`: `src/lib/prisma/raw-sql.ts::createGenuineObject::G1`. These are conversion traps that run only through implicit conversion, and `throwOnConversion` only throws.
- `NON_LITERAL_LOAD_ALLOWLIST`: `src/i18n/messages.ts` (message JSON) and `src/lib/crypto/crypto-client.ts` (a browser-side module URL).

### Mutation record (round 4)

Each mutation changes one clause in a scratch copy and runs `npx vitest run <file> -t "<filter>"`. Bypass = `check-bypass-rls.test.mjs`, nesting = `check-rls-nesting.test.mjs`.

| ID | File | Clause | Test file | `-t` filter | Result |
|---|---|---|---|---|---|
| S1 | soundness | G1 own-member write | nesting | `a field set in the constructor` | red |
| S2 | soundness | G1 write through an undeclared key | nesting | `a function written into an any object` | red |
| S2b | soundness | G1 value-side test | nesting | `a function written into an any object` | red |
| S3 | soundness | library-member exemption | nesting | `member a library declares` | red |
| S4 | soundness | destructuring-assignment leaves | nesting | `destructuring assignment onto a member` | red |
| S5 | soundness | mutator name prefilter | nesting | `Object.assign onto this` | red |
| S5b | soundness | one-step alias name | nesting | `Object.assign through a renamed alias` | red (after renaming the alias; green while it shared the name) |
| S5c | soundness | Reflect owner | nesting | `refuses Reflect.set` | red |
| S6 | soundness | `this` target | nesting | `defineProperty onto this` | red |
| S6b | soundness | `any` target | nesting | `defineProperty onto an any value` | red |
| S6c | soundness | own-function-member target | nesting | `Object.assign through an alias\|Reflect.set` | red |
| S6d | soundness | fresh literal exempt for Object.assign | nesting | `Object.assign onto a fresh literal` | red |
| S6e | soundness | fresh literal exempt for Object.assign only | nesting | `defineProperty onto a fresh literal` | red (the first version exempted every mutator, a hole found by this run) |
| S7 | soundness | G3 | nesting | `computed-key member` | red |
| S8 | soundness | G4 | nesting | `callable parameter property` | red |
| S9 | soundness | G5 class expression | nesting | `class expression that extends` | red |
| S9b | soundness | G5 non-name base | nesting | `mixin base` | red |
| S10 | soundness | declared non-production target | nesting | `listed tooling through require\|test module through a side-effect` | red |
| S11 | soundness | own JavaScript | nesting | `loading own JavaScript` | red (after adding allowJs to the fixture, as the real tsconfig has) |
| S12 | soundness | declaration over own JavaScript | nesting | `declaration over own JavaScript` | red |
| S13 | soundness | non-literal specifier | nesting | `non-literal specifier` | red |
| S13b | soundness | NON_LITERAL_LOAD_ALLOWLIST | bypass | `messages.ts shape\|crypto-client.ts shape` | red |
| S14 | soundness | own specifier that does not resolve | nesting | `does not resolve` | red |
| S15 | soundness | closure adds the module | nesting | `outside src/ implements\|outside src/ that production imports to G1` | red |
| S15b | soundness | same | bypass | `scans a module outside src` | red |
| S16 | soundness | tooling closure is transitive | nesting | `through a re-export` | red |
| S17 | soundness | FUNCTION_FLOW_ALLOWLIST excuses | nesting | `listed conversion traps` | red |
| S17b | soundness | stale entry | nesting | `once createGenuineObject writes no function` | red |
| S17c | soundness | entry keyed by enclosing function | nesting | `another function of the file` | red |
| R1x | resolver | name-based candidates | nesting | `implements the interface only structurally` | red |
| R1b | resolver | test-only member resolves empty | nesting | `member only a test supplies` | red |
| R1c | resolver | external shape first | nesting | `listed SDK-shaped interface` | red |
| R2 | resolver | derived-class members | nesting | `subclass field that overrides\|subclass override that opens` | red |
| R3 | resolver | field initializer | nesting | `field initializer\|subclass field` | red |
| R4 | resolver | library member typed by stored value | nesting | `library member typed by what was stored` | red |
| R5 | resolver | `any` callee refused | nesting | `any-typed library value called as a function` | red |
| R6 | resolver | library-module exemption at the callee | nesting | `library module, though typed any\|createRequire` | red |
| R6b | resolver | library-module exemption at the return | nesting | `createRequire` | red |
| R7 | resolver | module load in a destructure | nesting | `own module's import\|own module's require` | red |
| R8 | resolver | array pattern only when library-made | nesting | `array a library returns` | red |
| R10 | resolver | computed function values are edges | nesting | `library result handed straight` | red |
| R11 | resolver | member functions of library arguments | nesting | `own object handed to a library` | red |
| R11b | resolver | non-literal function array to library | nesting | `array of functions handed` | red |
| R12 | resolver | private identifiers | nesting | `private field handed on` | red (after building the instance outside the callback) |
| R14 | resolver | shorthand is not a binding write | nesting | `listed conditional opener when the call passes the outer tx` | red |
| R15 | resolver | `mayBeCallable` union and non-null | bypass | `optional function handed on` | red |
| N1 | nesting | drop the guarded edge | nesting | `listed conditional opener when the call passes the outer tx` | red |
| N2 | nesting | rerun without exemption when entered plainly | nesting | `also entered without the guard` | red |
| N3 | nesting | reassigned client | nesting | `client is reassigned` | red |
| N4 | nesting | guarded site must exist | nesting | `guarded opener is gone` | red |
| N5 | nesting | guard not written | nesting | `writes its own guard` | red |
| N6 | nesting | `mayBeCallable` in the context-as-value scan | nesting | `context function named in a value position` | green: equivalent. The name of a context function in value position is reported where it is written, before any holder's type matters |
| B1 | bypass | operation-site charge | bypass | `erased to any\|via module hands back\|union of delegates` | red |
| B1b | bypass | each member of a delegate union | bypass | `union of delegates` | red (after erasing the reads, so only the query names the models) |
| B2 | bypass | mixed own/library callee | bypass | `own or library` | red |
| B2b | bypass | closure return | bypass | `returned by a closure` | red |
| B2c | bypass | array element | bypass | `client handed in an array` | red |
| B2d | bypass | own object member | bypass | `inside an object` | red |
| B2f | bypass | delegate as a client | bypass | `as a delegate` | red |
| B3 | bypass | written purpose parameter | bypass | `rewrites its purpose parameter` | red |
| B4 | bypass | list disjointness | bypass | `on both INDIRECT_CALLBACK_ALLOWLIST` | red |
| B5 | bypass | closure files scanned | bypass | `scans a module outside src` | red |
| B6 | bypass | soundness checked in this gate | bypass | `member written after its initializer\|written through` | red |
| B7 | bypass | unnameable delegate refused | bypass | `model its type does not name` | red |

Removed as dead, each after its mutation stayed green: the own-invoker argument logic (R9, R9b), the `.bind`/`.call` receiver exceptions (R13), `getNonNullableType` in `carriesClient` (B2e). R1 named no code (its clause is R1x).

### Verification (round 4)
| Check | Result |
|---|---|
| vitest | 17,089 passed, 1 failed (the known `crypto-auth-deps-manifest` (E), the uncommitted `passwd-sso-cli`) |
| check-rls-nesting / check-bypass-rls fixture suites | 413 passed |
| typecheck, lint | pass |
| `next build` | pass |
| check-rls-nesting (real tree) | OK: 1,047 files, 600 context calls, 596 callbacks |
| check-bypass-rls (real tree) | OK: 221 bypass callbacks through 1,063 reached functions |
