# Code Review: boot-stderr-caller-contract

Date: 2026-07-27
Review round: 1
Branch: `harden/boot-stderr-caller-contract`

## Changes from Previous Round

Initial triangulate review. (Two prior ad-hoc review passes had already closed
one fail-open and four bypasses in the gate; this is the first pass run through
the three-expert Phase 3 procedure.)

## Method

- Step 3-2a local LLM pre-screening: `No issues found`.
- Step 3-2b seeds: func `No findings`, sec `No findings`, test 4 findings (all
  four subsequently **rejected** on independent verification — see Seed Finding
  Disposition).
- Step 3-3: three expert sub-agents (Functionality / Security / Testing).
- Step 3-4 dedup: mechanical json-index join across the three experts' indices
  (the mandated pre-pass). The Ollama prose merge was skipped because all three
  outputs were already in the orchestrator context; re-serializing ~15k tokens
  through the merger would add no dedup information beyond the json join. The
  join below IS the dedup skeleton, per the documented fallback.

Every expert proved its claims by executing the gate against fixture trees under
`/tmp` with `BOOT_STDERR_CALLERS_ROOT`; the repo tree was never mutated.

## Perspective Convergence (mechanical join)

| Consolidated | Func | Sec | Test | Floor |
|---|---|---|---|---|
| C1 Caller-discovery class under-derived | F2 Major | **F1 Critical** | F2 Major, F6 Minor | **Critical** |
| C2 Cleared helper reads module-scope/imported secret | F1 Major | F3 Major | — | **Major** |
| C3 No caller floor — 0 callers reports OK | F6 Minor | F6 Major | — | **Major** |

Three-expert convergence on C1 is the dominant signal of this review.

## Security Findings

**C1 [Critical] Caller-discovery class under-derived** —
`check-boot-stderr-callers.mjs:153` `isBootStderrCall`. Nine call shapes were
proven to make the calling file *invisible* to the gate (exit 0, file not
counted, so no manifest entry could catch it either): local alias
(`const f = bootStderr`), callback position (`forEach`/`catch`/`setTimeout`),
aliased re-export (`export { bootStderr as boot } from`), specifier-less
re-export, `export * as ns from`, dynamic `import()` destructuring, object
property (`{ bootStderr }`), index-barrel resolution (`@/lib/sink` →
`src/lib/sink/index.ts`), and the default-import branch which does not work for
the scenario its own comment names. `escalate: false`.

**C2 [Major] Cleared helper reads a secret it did not read directly** —
`:278`. `readsProcessState` is applied to the function *body*, so a module-scope
`const CAPTURED = process.env.AUTH_SECRET` or an imported `env` object clears the
gate. Proven with both shapes.

**C4 [Major] `isSafeStringBuilder` never inspects arguments** — `:307`. The
`join` separator and the arguments to a cleared helper are unchecked, so
`names(issues).join(process.env.AUTH_SECRET)` passes.

**C5 [Major] `judge()` trusts a type annotation on a variable with a visible
initializer** — `:381`. `const declared: CspMode = process.env.CSP_MODE as CspMode`
passes — byte-for-byte the leak this branch just removed from csp-builder.

**C6 [Major] `isProvablyClosedMember` accepts a mutable member** — `:350`.
`readonly` is not required and later assignments are not scanned.

**C7 [Major] Scan root is `src/` only** — `:52`. `scripts/*.ts` holds production
workers (`audit-outbox-worker`, `retention-gc-worker`) that import `@/lib/*` and
hold `OUTBOX_WORKER_DATABASE_URL` / key material. The sibling gate
`check-console-sinks.mjs` scans from the repo root; `eslint`'s `no-console` is
also scoped to `src/**`, so nothing constrains those files.

**C3 [Major] No minimum-caller floor** — `:575`. Relocating the sink yields
`OK (0 calling file(s) verified)`, exit 0. The sibling gate explicitly guards
this ("did the sink move?").

## Functionality Findings

**C8 [Major] `closedTypeNames` skips `@/` imports** — `:199`. Rewriting
`./types` to the repo-standard `@/lib/key-provider/types` red-builds provably
safe code, with a message naming the interpolation rather than the resolution
failure.

**C9 [Minor] Aliased type imports dropped** — `:221`. `import type { KeyName as K }`
registers the original name then filters it out; `K` is never added.

**C10 [Minor] `ProviderName` carries a test-only member** —
`src/lib/key-provider/types.ts:44`. `"test"` has one user, a test fixture, but
now appears in every production exhaustiveness site.

**C11 [Minor] `StandardIssue` declared after use** — `src/lib/env.ts:38`, and it
restates Zod's issue shape by hand.

**R1 evidence**: `resolveSpecifier` + `indexReExports` reimplement, more weakly,
`check-destructive-wrapper-derivation.mjs:780 resolveSpecifierToRel` and its
re-export fixpoint — which already handle `/index.ts`, extension-ful specifiers,
specifier-less re-export laundering, and `export default` laundering.

## Testing Findings

**C12 [Major] Four self-test cases survive mutation** (RT7) — 20 mutants scored;
5 branches survive: the "bare identifier" case never reaches the Identifier
branch (it asserts a `BinaryExpression` fallback), `export * from` barrels are
uncovered, the `isLiteralUnion` restriction is unpinned (`type Loose = string`
passes a mutant), and the argument-count branch is untested.

**C13 [Major] `env.ts` — the highest-risk caller has no regression test** —
`src/lib/env.test.ts`. csp-builder got one; env.ts, which has all of
`process.env` in scope, did not. Confirmed no live leak today, but
`env-schema.ts:657` already interpolates into a Zod message, so the channel
exists and nothing pins it.

**C14 [Minor] `TREE_FILES` has no drift guard**; **C15 [Minor]** the newly
documented "nesting is a compile error" claim in `logger/client.ts:77` is
unpinned despite an existing `@ts-expect-error` block being the right mechanism.

## Seed Finding Disposition

- `err.status ?? err.code ?? 1` — **Rejected**: `code` is a *string* spawn error
  (`ENOENT`); the change would break `code === 1` assertions. Matches sibling
  convention.
- fixture lacks `tsconfig.json` — **Rejected**: `ast-project.mjs:39` uses
  `useInMemoryFileSystem` + `skipFileDependencyResolution`; no tsconfig lookup exists.
- `replace` first-occurrence — **Rejected**: every anchor verified to occur
  exactly once; `expect(src).toContain(from)` fails loudly on a stale anchor.
- `vi.mock` hoisting — **Rejected**: the mock is already at module scope above
  every `describe`; `vi.hoisted` applies to factory-referenced variables, of
  which there are none.

## Root-cause assessment

C1, C2, C4, C5, C6, C8, C9 are not seven independent defects. They are one
design defect: **`bootStderr` accepts `string`, and the gate tries to prove
arbitrary strings safe after the fact.** That is hand-rolled taint analysis, and
its member-set has now expanded three times (4 bypasses → 3 more → 9 more).

Per R42 §①b, a class that expands ≥2× was never derived from the true primitive.
The true primitive is the parameter type. This repo already recorded the lesson,
in `src/lib/logger/client-events.ts:6-10`:

> An earlier attempt used an ESLint selector on the callee name and was trivially
> bypassed by an aliased import, a variable, or a wrapper — **a detector always
> has one more spelling it has not seen, whereas an unassignable type has none.**

The client logger was rebuilt on that principle and has held. The boot sink was
not. Fixing this by adding a tenth detection case repeats the mistake the
codebase already paid for once (R22 / R1: use the established pattern).

## Resolution Status

The fix is structural, not nine patches. `bootStderr` no longer takes a string.

### C1/C2/C4/C5/C6/C7/C8/C9 [Critical + Major] — gate escapes and false positives
- Action: root-caused to the parameter type. `bootStderr(diagnostic: BootDiagnostic)`
  where `BootDiagnostic` is a discriminated union whose every field is a brand,
  a closed literal union, or a number. Rendering moved INTO the sink, so callers
  supply bounded data and never prose. Every listed escape is closed by
  construction: import form, call position, barrel, alias, dynamic import,
  module-scope capture, cast, mutable member, `join` separator, and scan root
  all become irrelevant when there is no parameter a secret fits.
- The taint-analysis gate and its manifest/self-test were deleted.
- Modified: `src/lib/boot-events.ts` (new), `src/lib/boot-stderr.ts`,
  `src/lib/env.ts:28`, `src/lib/security/csp-builder.ts:44`,
  `src/lib/key-provider/base-cloud-provider.ts:166`

### C1 residual — what remains guardable
- Action: `scripts/checks/check-boot-diagnostic-shape.mjs` (new) guards the one
  thing the compiler cannot notice — widening the payload type back toward
  `string`, which would keep every call site compiling. Small and total: sink
  signature, per-property type allowlist, brand present, constructor validates.
  Unrecognized shape → red.
- Self-test: `scripts/__tests__/check-boot-diagnostic-shape.test.mjs`, 11 cases,
  each performing the widening it claims to catch. Red-proven.
- Wired: `scripts/pre-pr.sh:283`; `check-gate-selftest-coverage.sh` green.

### C10 [Minor] ProviderName carried a test-only member
- Action: dropped `"test"`; the fixture now uses `"aws-sm"`.
- Modified: `src/lib/key-provider/types.ts:44`, `base-cloud-provider.test.ts:22`

### C11 [Minor] StandardIssue declared after use / restated Zod's shape
- Action: removed. The helper it existed for is gone with the redesign.
- Modified: `src/lib/env.ts`

### C12 [Major] Self-test cases survived mutation
- Action: obsolete — the suite they belonged to was deleted. The replacement
  suite's cases were each verified to fail on the mutation they name, and its
  `patch()` asserts anchor uniqueness (`split(from)` length 2) so a case cannot
  silently patch the wrong occurrence.

### C13 [Major] env.ts — highest-risk caller had no regression test
- Action: added `reports only variable names to stderr, never the rejected
  value`. It asserts the exact payload and that the rejected value is absent.
  Writing it surfaced a real defect: the same variable was reported twice
  (several Zod issues, one variable), now deduplicated.
- Modified: `src/lib/env.test.ts:50`, `src/lib/env.ts:31`

### C14 [Minor] TREE_FILES drift guard
- Action: not carried over as a finding — the new gate reads three fixed files
  by name and fails loudly when one is missing (`did the boot sink move?`),
  which is the case the old fixture list could not express. Covered by test 9.

### C15 [Minor] "nesting is a compile error" claim unpinned
- Action: added a `@ts-expect-error` line to the existing type-only block.
- Modified: `src/lib/logger/client.test.ts:141`

### Additional defect found while fixing
`envVarName` accepted an identifier-shaped value of any length, so a 4096-char
blob would reach the boot console verbatim. Bounded to 64 chars in the same
regex. Pinned by `boot-events.test.ts`.

## Environment Verification Report

N/A — no environment constraints were declared (no Phase 1 for this branch).
All verification ran locally: `npx vitest run` 987 files / 13094 tests, exit 0;
`npx next build` exit 0; `npx tsc --noEmit` exit 0; `bash scripts/pre-pr.sh`
62/62, exit 0. All statuses read unpiped (R44).

## Termination Check

Round 1 findings are all resolved. The C1 class expanded ≥2× across prior
passes, so per Step 3-8 "all findings resolved" is not by itself a stop
condition — the class is closed by construction (the type) plus a
mutation-verified guard: `check-boot-diagnostic-shape.mjs`, red-proven by 10
mutations in its self-test, wired into `pre-pr.sh` and thereby CI
(`.github/workflows/ci.yml:228`).

Round 2 is warranted: the redesign is new code touching a security boundary, so
the tightening-only skip does not apply.

---

# Round 2

Reviewed `git diff HEAD~1 HEAD` (b1bc8fe9e). Security expert plus a combined
Functionality/Testing expert. Both converged on the same three Major items.

## Verified resolved from Round 1

The nine call-shape escapes are genuinely closed — by the compiler, not a
detector. Confirmed by both experts: `tsc --noEmit` clean with five live
`@ts-expect-error` directives pinning the signature; `render()` exhaustiveness
is a real `TS2366` when a member is added without a case; `tsconfig` includes
`scripts/**`, so the production workers the old gate never scanned are now
covered by the same parameter type. C10, C11, C13, C14, C15 all confirmed
resolved, C13 red-proved against three independent mutants.

Operability is **not** regressed: `next` rethrows a failing `register()` with the
message preserved (`instrumentation-globals.external.js:64-68`), and `env.ts`
still throws the full per-issue text, so the operator gets names in the banner
and names+reasons in the error.

## R2-1 [Major, converged] `envVarName` validated shape, not origin

`src/lib/boot-events.ts`. The regex `/^[A-Za-z_][A-Za-z0-9_]{0,63}$/` matches a
64-char hex master key, `AKIAIOSFODNN7EXAMPLE`, and `api_9f2c7ba4e1d84c0f` —
every identifier-shaped secret this repo handles. `envVarName(process.env
.SHARE_MASTER_KEY)` type-checked and would have printed the key verbatim. The
Round-1 claim that the brand "means what it says" was wrong: a predicate over a
value's FORM cannot answer a question about its ORIGIN.

- Action: replaced with an allowlist — `envVarName(raw, declared: ReadonlySet<string>)`,
  admitting only names the schema declares. No secret is ever a schema key.
  The gate's `validates` heuristic now requires the allowlist parameter and a
  membership test, so a reversion to a shape predicate fails.
- Modified: `src/lib/boot-events.ts:47`, `src/lib/env.ts:47`

## R2-2 [Major, converged] `check-console-sinks`' assertion became vacuous

Moving rendering into the sink turned `message` from the typed PARAMETER into an
ordinary local. The gate asserts the argument text is `message`, which had
carried the whole caller→console chain; it then constrained nothing. Proven: a
sink body of `const message = \`${process.env.AUTH_SECRET}\`` passed both gates,
in the one file where `no-console` is off.

- Action: the call is now inline `console.error(render(diagnostic))` and the gate
  pins that exact text. `check-boot-diagnostic-shape` additionally rejects
  `render()` reading `process` and rejects any sink import beyond `@/lib/boot-events`.
- Modified: `src/lib/boot-stderr.ts:57`, `scripts/checks/check-console-sinks.mjs:96`

## R2-3 [Major, converged] Shape gate passed vacuously on non-inline members

Walking `getDescendantsOfKind(PropertySignature)` on the written node meant any
member that is not an inline type literal yielded zero properties and the gate
printed OK. Five widenings passed: named alias, index signature, method
signature, `& Record<string,string>`, `& Extra`. Extracting a growing union
member to its own alias is the most likely edit here, and it disabled the check
wholesale.

- Action: members are resolved (alias/interface/intersection/parenthesized,
  recursively) before property checking; `IndexSignature`, `MethodSignature`,
  `CallSignature`, `MappedType`, an unresolvable member, and a member with zero
  properties are each an explicit failure.
- Modified: `scripts/checks/check-boot-diagnostic-shape.mjs:231`

## R2-4 [Minor] Stale references / dedup / dead import

- `types.ts:42` cited the deleted gate; repointed. `eslint.config.mjs:110`
  described the old string signature; corrected.
- `env.ts` deduped on the resolved name, so several pathless issues could
  collapse into one `<unnamed>` line; now dedupes on the full path.
- `boot-events.test.ts` mixed a dynamic import with a static one, implying an
  isolation it did not provide (proved same instance); now a single static import.

## Round 2 verification

`npx vitest run` 987 files / 13102 tests, exit 0. `npx next build` exit 0.
`npx tsc --noEmit` exit 0. `bash scripts/pre-pr.sh` 62/62, exit 0. Gate
self-tests 26 cases across the two sinks, each red-proved. All statuses read
unpiped (R44).

## Termination

Round 2's findings are resolved. Every Round-2 item is a guard-layer defect
(false assurance) rather than a live leak, with one exception — R2-1, which was
a real egress path and is now closed by an allowlist plus a gate that rejects
the weaker predicate.

The C1 class is closed by construction: the guarantee is the parameter type,
checked by the compiler at every call site in every import form, with a
mutation-verified gate (`check-boot-diagnostic-shape`, red-proven by 17
mutations) covering the two things the compiler cannot see — widening the
payload type and the sink's own render body.

Round 3 not warranted: no finding remains open, and the remaining risk surface
is now enforced by the type system rather than by detection.

---

# Round 3

External re-review of the Round 2 fixes found two High fail-opens on the NEW
boundary. Both were real and are closed.

## R3-1 [High] The caller supplied `envVarName`'s trust anchor

Round 2 replaced shape validation with membership — but took the allowlist as a
PARAMETER, which moved the fail-open rather than closing it:

```ts
envVarName(secret, new Set([secret]))   // type-checks, prints the secret
```

A membership test is only as trustworthy as the set it tests against, so the set
cannot be an input. `envVarName(raw)` now derives it internally from
`getSchemaShape()` (memoized). `@/lib/env-schema` is the side-effect-free half of
env handling and imports only zod + constants, so there is no cycle and no boot
cost. The gate now requires exactly one parameter and rejects a caller-supplied
allowlist explicitly.

- Modified: `src/lib/boot-events.ts:70`, `src/lib/env.ts:47`

## R3-2 [High] `TypeQuery` accepted unconditionally

The branch existed for the `typeof BOOT_EVENT.X` discriminant but returned true
for every `typeof <expr>`. `detail: typeof process.env.AUTH_SECRET` resolves to
`string | undefined` and passed the shape gate, the compiler, render's `process`
check, and the console-sink gate — a complete path from caller to raw stderr.

Now restricted to `/^typeof BOOT_EVENT\.([A-Za-z0-9_]+)$/` where the member must
exist on the `BOOT_EVENT` object, and only on the `event` property.

- Modified: `scripts/checks/check-boot-diagnostic-shape.mjs:212`

## R3-3 [Non-blocking, adopted] Schema derivation pinned structurally

The reviewer noted the schema-origin check rested on import presence plus a
`.has(` substring, so leaving a near-unused import in place while building the
set elsewhere would pass. This is the same weakness that a `getSchemaShapeStub`
had already defeated once during Round 2 implementation. Closed with AST: the
imported binding is resolved (alias included) and must be the callee inside
`Object.keys(...)` within `declared()`.

- Modified: `scripts/checks/check-boot-diagnostic-shape.mjs:149`

## Round 3 verification

`npx vitest run` 987 files / 13108 tests, exit 0. `npx next build` exit 0.
`npx tsc --noEmit` exit 0. `bash scripts/pre-pr.sh` 62/62, exit 0. Shape-gate
self-test 23 cases, including one asserting an ALIASED schema import still
passes (proving resolution is binding-based, not spelling-based).

## Known residual (accepted, review-visible)

`secret as EnvVarName` compiles. A brand is nominal against structural forging,
not against a deliberate assertion. Closing it would need a cast scan over three
type names — a closed enumeration, so it would not reintroduce the taint-analysis
class — but it is not done here. Recorded rather than silently carried.
