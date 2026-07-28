# Review: autofill-console-pii-leak

Date: 2026-07-28
Rounds: 3 (plan ×2, implementation ×1) × 3 experts (functionality, security, testing)

Findings by round: 32 (round 1) → 30 (round 2) → 19 (round 3). Every finding's
disposition is recorded in the plan's "Round 1 outcome", "Round 2 outcome" and
"Round 3 outcome" sections; this file records what the process itself surfaced.

## What the review changed, and why it mattered

The task began as "two content-script `console.debug` calls leak autofilled values".
Three things were wrong with that framing, and each was found by a different round.

**Round 1 — the deferral rested on a false premise.** `SC5` in PR #723 recorded the
two `background/` sites as logging "an `Error` object only, no user data", and the
user's decision to leave them out of scope was made on that basis. The security
expert refuted it by execution: V8 embeds a window of the *input* in a `JSON.parse`
`SyntaxError`, and the copy-password path parses a decrypted vault blob inside the
`try` whose `catch` logged the raw error. Reproduced end-to-end through the real
command handler:

```
[psso] copy command failed: SyntaxError: Unexpected token 'S',
..."password":S3cr3t-Pas"... is not valid JSON
```

Round 1 also killed the original enforcement design. The bespoke `ts-morph` gate
matched the `console` callee by *spelling* and the permitted labeller by *identifier
name*, so `console?.debug?.()`, `console["debug"]()`, `const c = console`, and a
locally-declared function named `describeSelect` all passed it. Closing those took
the gate past 400 lines for a tree containing four console calls.

**Round 2 — the replacement's own claims did not survive execution.** ESLint over
`extension/` was the right mechanism, but two successive selector designs were
verified wrong:

| Claim | Reality (executed) |
|---|---|
| "`no-console` is scope-based, so `const c = console` is caught" (round 1) | False — misses aliasing, destructuring, and every `globalThis`/`self`/`window` prefix |
| A selector built on `:not(MemberExpression[computed=false] > .property)` (round 2) | Misses **10 of 20** bypass forms — the exclusion that spares `obj.console` is the same one that blinds the rule to `globalThis.console` |
| Final: `Identifier[name='console']` + `Literal[value='console']`, no exclusions | **20/20 caught, 0 false positives across 64 real files** |

Every exclusion tried opened a bypass. The lesson generalises past this gate: an
exclusion added to spare a hypothetical false positive is a bypass for the case it
was not imagined against, and here none of the false positives it guarded actually
occurred in the tree.

Round 2 also found that a single `// eslint-disable-next-line` zeroed the whole
gate (fixed with `noInlineConfig`), and that the override block as specified would
have made the gate **red on the PR that introduced it** — with the inline disable as
the shortest path to green.

**Round 3 — mutation testing found what reading could not.** 41 production mutants
were applied to a throwaway copy; 5 survived, and every survivor was a real gap. The
most consequential:

- The code-point-truncation test was a **tautology**. `JSON.parse(JSON.stringify(s))
  === s` holds for *every* string, lone surrogates included (well-formed
  `JSON.stringify`, ES2019), and the all-astral fixture put the cut on an even
  UTF-16 offset so no pair could split. Two independent reasons the assertion could
  never fail — neither visible by reading it.
- `performAutofillForEntry` parses decrypted personal plaintext at two sites the
  plan had dismissed as "outside that try". That predicate was about the
  copy-command `catch`, not about the invariant `I6` actually stated ("may not
  escape to **any** surface"), and those parses reach a rendered popup toast.
- The same class in `passkey-provider.ts`, where the second parse is over the
  **decrypted passkey private-key JWK** and the error is delivered by
  `window.postMessage` **into the page's world**. The shared cause was
  `normalizeErrorCode` returning `err.message` verbatim — an unconstrained
  `Error → string` channel feeding a cross-boundary sink from every caller.

**Round 4 — the fix's own design was the last leak.** A post-push review found that
reading the select's `name`/`id` handed the page a lever: `setInputValue` dispatches
`input` synchronously, so a page listener runs before the next field is filled and can
move an already-written value into the next select's `name`. Red-proved on both paths
— `[passwd-sso] No exact match for select: 4111111111111111` (the PAN) and
`… 12?Rue?Secrete` (the address; the `?` are only the spaces the sanitiser caught).
The page learns nothing it did not already hold, but it gains write access to a log
surface only the extension can reach — the leak this work exists to close, re-opened
under attacker control. Replaced with a closed 16-member field-identifier union that
reads nothing from the DOM, which deleted the sanitiser, the truncation, the
`SelectIdentity` type and their tests outright.

The pattern across all four rounds is the same one: **a value that is safe where it
comes from is not safe where it arrives.** Page-authored attributes are harmless to
the page and dangerous in the extension's log; a `SyntaxError` message is harmless in
a debugger and dangerous in a `postMessage`; an `err.message` passthrough is harmless
per call site and dangerous as a class.

## Recurring rules that fired

- **R42 (class-membership derivation) — three times, always the same shape.** The
  member set was derived from a *syntactic anchor* rather than from the property the
  invariant states. Round 1: console sites enumerated from a grep that counted guard
  lines (6 reported, 4 real). Round 2: `JSON.parse` sites enumerated from one `try`
  block (1 of 3). Round 3: enumerated from one file and one surface (3 of 5). Each
  time the fix was to re-derive from the invariant's own predicate.
- **R3 (incomplete pattern propagation) — twice.** The team half of a function
  narrowed and the personal half not; `afterEach(vi.restoreAllMocks)` added to two
  of the three test files that gained a console spy.
- **RT7 / RT8.** Four assertions that could not fail and two vacuous denial tests,
  all found by mutation rather than by review.
- **R34.** Two pre-existing defects in touched files were pulled in scope rather
  than deferred: the combined-expiry branch writing `00/00` over a user-typed value
  in a live checkout field, and `idNumber` crossing into the page's renderer with no
  consumer.

## Claims refuted during review

Recorded because a review that only accumulates findings is not calibrated.

| Claim | Source | Verdict |
|---|---|---|
| "`no-console` catches `const c = console`" | round 1 security | False (executed) |
| Selector with `:not(MemberExpression[computed=false] > .property)` closes all bypasses | round 2 security | False — misses 10 of 20 |
| "`const f = console.debug` is missed by `no-console`" | plan revision 2 | False — it is caught |
| Unhandled rejection on the context-menu autofill path | round 3 functionality | False — `context-menu.ts:247` already `.catch`es |
| Card *number* reaches the console | PR #723's `SC5` | False — only `setSelectValue` logs, reached from expiry only |

## Verification

All read as exit status directly, never through a pipe.

| Gate | Result |
|---|---|
| `cd extension && npx tsc --noEmit` | clean |
| `cd extension && npm test` | 59 files, 947 tests, exit 0 |
| `npx vitest run scripts/__tests__/lint-extension.test.mjs` | 36 tests, exit 0 |
| `node scripts/checks/lint-extension.mjs` | 64 files linted, exit 0 |
| `bash scripts/checks/check-gate-selftest-coverage.sh` | exit 0 |
| `npx eslint .` | exit 0 |
| `cd extension && npm run build` + bundle greps | old value-interpolating literal absent; the only remaining literal is `No exact match for select: ${Cn(e)}` (minified `describeSelect` call) |
| `bash scripts/pre-pr.sh` | exit 0 — 64 steps |

Every new assertion was red-proved against pre-fix code on a throwaway copy, never
by mutating the real tree.

## Deferred, recorded rather than dropped

- `SC-B` — the rest of an extension lint config (type-aware rules, React rules,
  `no-explicit-any`). Worst case: latent quality issues, none security-bearing —
  verified, `rg ": any|as any" extension/src` excluding tests returns zero files.
  Cost: a full config plus a sweep across 118 files, well over 30 minutes.
- `SC-C` — the twin `setSelectValue` implementations are not commonised. They differ
  in signature and match strategy; merging them would rewrite a security-reviewed
  silent-failure matcher inside a log-hygiene diff.
- `S24` residual — a runtime-assembled console key evades the gate. Out of its
  threat model (accidental re-introduction); recorded in the config's own comment.
