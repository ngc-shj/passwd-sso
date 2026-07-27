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
