# Plan Review: eliminate-prod-any-console

Date: 2026-07-27
Review round: 1

## Changes from Previous Round

Initial review. Three expert sub-agents (functionality, security, testing)
reviewed the plan in parallel, plus an Ollama pre-screening pass. 7 Critical and
12 Major findings. Every Critical was independently re-verified by the
orchestrator against the source before being accepted — see "Orchestrator
verification" below.

## Verdict

**No-Go as originally written; Go after correction.** The plan's central premise
— "TypeScript 5.9's `lib.dom.d.ts` already defines the WebAuthn extension types,
so delete the casts" — is true for lib.dom itself but **does not transfer to the
server files**, which resolve `@simplewebauthn/server`'s own narrower
declarations. Two of six `any`-bearing files had no working design. Separately,
the plan's single verification gate was proven vacuous.

All findings are now reflected in the plan; all six contracts are `locked`.

## Critical Findings

### CF1 — `@simplewebauthn/server` ships its own narrower DOM types (Functionality)

`node_modules/@simplewebauthn/server/esm/types/dom.d.ts` declares:

```ts
export interface AuthenticationExtensionsClientOutputs {
  appid?: boolean; credProps?: CredentialPropertiesOutput; hmacCreateSecret?: boolean;
}   // NO minPinLength, NO largeBlob, NO prf
```

`RegistrationResponseJSON.clientExtensionResults` uses *that*, not lib.dom's.
Compiling the plan's proposals produced `TS2339` ×2 and `TS2353`.

**Orchestrator verification**: read the file directly — confirmed. The plan had
cited `minPinLength?: boolean` on `AuthenticationExtensionsClient**Inputs**` to
justify an **Outputs**-side read. Wrong side of the wire.

**Correction**: plan now separates three type worlds (lib.dom / library / repo
wire types) and routes the extension reads through repo-local wire types with
`unknown`-valued fields.

### CF2 — PRF salts cross the wire as hex strings, not `BufferSource` (Security)

`webauthn-client.test.ts:145-167` sends `extensions.prf.eval.first = "a".repeat(64)`.
Typing the wire as `AuthenticationExtensionsClientInputs` (`first: BufferSource`)
makes `hexDecode(serverPrfExt.eval.first)` a type error; the cheapest compile-fix
drops `serverPrfExt` to `undefined`, falling into the `else if` at
`webauthn-client.ts:376` — **silently replacing the server-bound salt with a
client-constructed one**, changing the HKDF input to the vault wrapping key.

**Orchestrator verification**: read the test — confirmed hex string.

**Correction**: `PrfInputsWire` declared with `first: string`; hex→ArrayBuffer
conversion pinned to the single existing boundary; the C8-case-1 test named as
the I5 red-proof with an explicit "if this reds, the type is wrong, not the test".

### CF3 — I6's guard checklist listed 4 of 10 (Security)

The verify route's `response` is `z.record(z.string(), z.unknown())` — nothing is
field-validated by schema, so the inline guards **are** the validation. The
load-bearing pair: G5 (`Number.isInteger` + range on `minPinLength`) feeds G10
(tenant `requireMinPinLength` policy). Deleting G5 — the cheapest way to make the
retyped line 176 compile — lets a client send `minPinLength: 999` and **bypass
the tenant PIN-length policy**.

**Orchestrator verification**: read `route.ts:222-232` — confirmed G9/G10 exist
and consume G5's output.

**Correction**: full G1–G10 table added as an implementer checklist, plus a
required-pattern grep per guard.

### CF4 — `no-explicit-any` was already `error` repo-wide (Testing)

```
$ npx eslint --print-config src/lib/url-helpers.ts
@typescript-eslint/no-explicit-any: [2]
no-console: undefined
```

The 22 `any`s survive because **19 inline `eslint-disable` comments** suppress
them. Only `no-console` is genuinely new.

**Orchestrator verification**: ran `--print-config` and counted the disables —
both confirmed (19).

**Correction**: C5 restated. The `any` half is "delete 19 suppressions", a
strictly stronger gate than adding a rule, because config alone cannot satisfy it.

### CF5 — The red-proof was vacuous (Testing)

The plan prescribed copying a file to the **scratchpad** and running eslint.
Reproduced:

```
$ npx eslint <scratchpad>/probe.ts
  0:0  warning  File ignored because outside of base path
✖ 1 problem (0 errors, 1 warning)      EXIT=0
```

Flat config refuses out-of-tree files. The implementer would have found no error
lines to capture.

**Orchestrator verification**: ran both forms. Out-of-tree → exit 0. In-tree
(`src/lib/__redproof_tmp__/probe.ts`) → **exit 1** with `no-explicit-any` firing
and `no-console` not firing — which independently corroborates CF4.

**Correction**: procedure rewritten in-tree, exit status read directly (R44),
extended to three captures so the override list and ignore globs are also proven.

### CF6 — "Existing tests pass unchanged" is false for C1/C4 (Testing)

6 test files spy on the global `console`; a spy cannot observe a call routed
through a logger module. Under the plan's own rule ("a test edit means the edit
was not type-only"), the implementer would have read 6 expected reds as defect
signals and been pushed toward keeping `console.*` or deleting assertions.

**Orchestrator verification**: `git grep -ln 'spyOn(console' -- src` → 6 files.
`auth-gate.test.ts` → **0** console spies.

**Correction**: rule scoped to C2/C3 only; expected test-edit table added with a
forbidden-weakening clause; coverage reality table (5 asserted / 1 executed-but-
silent / 7 unreachable) added so the plan stops implying coverage that is absent.

### CF7 — PRF mock covers only the `ArrayBuffer` branch (Testing)

If a `BufferSource` narrowing is introduced, the mock's `ArrayBuffer` takes one
branch and a real authenticator's `ArrayBufferView` takes the other — which no
CI test can ever reach (VC1). Failure mode: corrupted wrapping key → vault fails
to unlock after passkey sign-in.

**Correction**: prefer retaining the `as ArrayBuffer` cast (zero behavior change,
and the uncast form does not compile — `TS2769`). If a narrowing is introduced
anyway, a two-variant mock is mandatory.

## Major Findings (all reflected)

| ID | Finding | Correction |
|----|---------|------------|
| MF1 | 2 SCIM `Record<string, any>` sites missing from the member set; count is 22 not 21 | Added to C3 with Prisma input types; grep corrected to cover type-argument position; disable-count cross-check added |
| MF2 | `RouteHandler` retype proven not to typecheck (`TS2345`) | `SC3` promoted from contingency to decision; objective restated "21 removed + 1 documented exception" |
| MF3 | Client logger has no key-name denylist — `{ token: "..." }` is a scalar and typechecks | Denylist required, superset of the server's 16 paths, single shared constant |
| MF4 | `use-password-entry-detail.ts:75` `NODE_ENV` gate omitted from the walkthrough | Preservation made explicit + required-pattern; same for `pick-messages.ts`, `url-helpers.ts` |
| MF5 | `env.ts` file-level `no-console: off` is a permanent hole in the highest-secret-density module | Banner extracted to `boot-stderr.ts`; `env.ts` stays gated |
| MF6 | `csp-builder.ts:37` is module-init scope, mis-routed to the client logger | Third KEEP, routed to `boot-stderr.ts` |
| MF7 | `team-vault-core.tsx:323` is a single interpolated string, not a fields call | Decomposition specified; test moves to field assertion (stronger) |
| MF8 | `auth-gate.ts:139` — the plan's MUST-preserve site — has zero test assertion | New coverage obligation with its own red-proof |
| MF9 | 95 files mock `@/lib/logger`; mock shapes at the 3 new `getLogger()` sites unchecked | C6 enumeration step added; member 7 declared unverifiable-by-suite |
| MF10 | RT8 throw tests under-specified; obvious malformed inputs already throw today | (a)/(b)/(c) table required; only rows where behavior differs count |
| MF11 | `I4` "emitted JS unchanged" false for ≥3 edits | Replaced with an enumerated table, each row carrying a test obligation |
| MF12 | Extension console leak class unenumerated before deferral | `SC5` added with all 6 sites; 2 emit autofilled card/identity values — flagged as a live pre-existing issue |

## Adjacent Findings

- **Security → Functionality**: `verifyRegistrationSchema.response` is unbounded
  `z.record(z.string(), z.unknown())`. Pre-existing, not caused by this work, but
  C3 touches the declaration — the cheapest moment to make I6 schema-enforced
  rather than grep-enforced. Recorded as a candidate, not adopted (would widen
  scope beyond a type/logging refactor).
- **Testing → Functionality**: `qr-capture-dialog.test.tsx` has no `ImageCapture`
  test; the new feature-detect branch would ship uncovered. Resolved by falling
  through to the existing `qrCaptureFailed` message (no new i18n keys, no
  user-visible change) plus a new test.

## Quality Warnings

None. All findings arrived with file:line evidence; the orchestrator
independently re-verified all 7 Criticals against the source rather than
accepting the sub-agent reports at face value (R21).

## Orchestrator verification (R21)

Commands run by the orchestrator itself, not delegated:

| Check | Result |
|-------|--------|
| `lib.dom.d.ts` `AuthenticationExtensionsClientOutputs` | no `minPinLength`, no `largeBlob` — CF1 confirmed |
| `@simplewebauthn/server/esm/types/dom.d.ts` | narrower still — CF1 confirmed |
| `webauthn-client.test.ts:145-167` | hex-string salt — CF2 confirmed |
| `route.ts:222-232` | G9/G10 present, consume G5 — CF3 confirmed |
| `npx eslint --print-config` | `no-explicit-any: [2]`, `no-console: undefined` — CF4 confirmed |
| disable count | 19 — CF4 confirmed |
| out-of-tree red-proof | exit 0, 0 errors — CF5 confirmed vacuous |
| in-tree red-proof | exit 1, `no-explicit-any` fires — correct procedure verified |
| `spyOn(console` in `src` | 6 files; `auth-gate.test.ts` has 0 — CF6 confirmed |
| `any` recount | 22 production sites — MF1 confirmed |
| lint wiring | `ci.yml:271`, `pre-pr.sh:719` — C5 is enforceable |

## Recurring Issue Check

### Functionality expert
- R1 (shared utility reimplementation): PASS — `logger/throttled.ts` imports pino, server-only; C1 does not duplicate it
- R3 (incomplete pattern propagation): PARTIAL → resolved via `SC5`/`SC6`
- R17 (helper adoption coverage): FAIL → 4 of 13 sites had wrong/absent specs; all corrected
- R29 (external spec citation accuracy): PASS — no RFCs cited; PRF channel priority and credProps semantics match source comments and tests
- R42 (member-set derivation): console PASS (13/13 exact); `any` FAIL → 22 not 21

### Security expert
- R3: applied — 2 findings (extension class, guard class)
- R36 (suppression as substitute for fix): applied — `env.ts` override rejected, replaced by extraction
- R42: console set A confirmed complete; I6 set incomplete (4 of 10) → Critical
- RS3 (input validation at boundaries): applied — tight-envelope/loose-payload posture documented as the reason I6 exists
- RS4 (PII in artifacts): clean today; `ClientLogFields` permits `email`/`userId` by construction → folded into the denylist
- RT9 (twin drift): checked — no drift today; extension `-lib.ts` twins have no `.js` counterparts carrying these calls

### Testing expert
- R19 (test mock alignment): FAIL → C6 enumeration step added
- R21 (orchestrator re-verification): FAIL → C6 obligations added
- R44 (gate exit status through a pipeline): FAIL → red-proof now reads `$?` unpiped
- RT1 (mock-reality divergence): FAIL → PRF `BufferSource` branch; resolved by preferring the retained cast
- RT5 (test call-path includes production primitive): PARTIAL → import-graph assertion rewritten as an AST walk
- RT6 (new exports without test diff): PARTIAL → one of two proposed assertions could not fail; rewritten
- RT7 (gate proven able to fail): FAIL ×3 → all three now carry red-proofs
- RT8 (vacuous denial-path test): FAIL → (a)/(b)/(c) table required
- RT9: PASS

---

# Phase 3 — Implementation Review

Date: 2026-07-27

Three expert sub-agents reviewed the implementation. **3 Critical, 9 Major.**
Every Critical was independently reproduced by the orchestrator before being
accepted. All are now fixed and each fix carries its own red-proof.

## Critical

### PF1 — `toCreationOptions` dropped the server's registration extensions

The single most consequential defect of the whole change, and the plan never
enumerated its class.

The wire/DOM boundary rule ("don't copy `extensions`; the wire carries hex")
was derived from the **authentication** path, where the server sends only `prf`.
It was then applied to `toCreationOptions` — but on the **registration** path
`webauthn-server.ts:141` sends `credProps`, `minPinLength`, and `largeBlob`,
none of which carry hex. Dropping them meant the browser was never asked for
them, so `getClientExtensionResults()` returned none:

- three columns (`discoverable`, `minPinLength`, `largeBlobSupported`) null for
  every newly registered passkey
- **the tenant `requireMinPinLength` policy became permanently inert** — not
  bypassed by an attacker, but silently non-enforcing on the honest path

Note what this defeats: all ten I6 guards survived verbatim, and every
required-pattern grep passed. The guards were not removed, their **input was
starved one layer upstream**. Guard-focused greps structurally cannot see that.

Fixed by `toDomExtensions()` (strips `prf`, forwards the rest) applied to both
converters. Red-proved: reverting the fix reds 2 of the 3 new tests.

### PF2 — the bundle guard could not follow `@/` imports

`client.ts -> @/lib/logger/throttled -> @/lib/logger -> pino -> node:async_hooks`
is a real, one-hop, browser-build-breaking edge. The walker followed only
relative specifiers, so it reported that edge **clean**. Reproduced directly:
adding the import left the suite green at 8 passed.

The guard passed for the trivial reason that `client.ts` happens to import one
relative path. Fixed to resolve `@/` against `SRC_ROOT`; the same probe now
reds.

### PF3 — the guard's own red-proof covered one regex of three

The positive control pointed at `throttled.ts`, whose only forbidden specifier
is a plain `… from "…"` import. Deleting the side-effect or dynamic-import
regex left the suite green — a red-proof that proved a third of what it claimed.
Replaced with six per-form fixtures (side-effect, dynamic, require, re-export,
multi-line, default+named), each dying if its regex is removed.

## Major (all fixed)

| # | Finding | Fix |
|---|---------|-----|
| PM1 | `message` bypasses redaction entirely; two sites interpolated caller data (`withBasePath`'s `path` can carry a token in a query string) | Both moved to `fields`; the constant-message rule is now enforced by an ESLint `no-restricted-syntax` selector, red-proved |
| PM2 | C4's pinned-count CI guards were never implemented — the two exempt files had **zero** enforcement inside them | `scripts/checks/check-console-sinks.mjs` checks argument *shape*, not counts (a count passes an unredacted 4th call). Wired into pre-pr → CI. Red-proved 3 ways + a 5-case self-test |
| PM3 | `no-console` ignored `src/**/e2e/**`; in this repo "E2E" also means end-to-end *encryption*, so `src/lib/e2e/` would be silently exempt production crypto | Ignore entry removed; Playwright specs live in the repo-root `e2e/`, outside the glob |
| PM4 | The three `WEBAUTHN_OPTIONS_MALFORMED` throws shipped untested (RT8) | 3 tests asserting the **named** error; red-proved against the pre-change form (a bare `.toThrow()` would have passed both sides) |
| PM5 | `auth-gate` warn→error was an unrecorded deviation from the locked C1 table | Deviation accepted and recorded here: promotion is deliberate, since `LOG_LEVEL=error` would otherwise silence the sole fail-closed signal |

## Confirmed to hold

- **All 10 I6 guards intact**, verified by reading each, not by grep. G3 is
  *stronger* than before: `Array.isArray(...)` rejects the hostile
  `transports: "usb"` string that `?? []` let through into a `.filter` 500.
- **I5 PRF channel priority preserved** — the designated C8-case-1 red-proof is
  green and round-trips the server salt.
- **Client denylist is a strict superset of the server's** (16 + 4), now from
  one shared constant; dropping a key from it reds two files.
- **All three dev-gates preserved** (`use-password-entry-detail`,
  `pick-messages`, `url-helpers`).
- **`env.ts` stays under `no-console: error`** — the exemption landed on
  `boot-stderr.ts`, which cannot see a secret.
- **ESLint gate correctly scoped** — overrides do not leak to siblings; the
  `any` rule still applies to tests.

## Process lesson

Three separate times a gate I wrote was green while not working: the bundle
guard's regex (missed side-effect imports), the guard's alias traversal, and its
red-proof's coverage. Each was caught only by *running a mutation and demanding
red* — never by reading the code or by a green suite. The one Critical the
mutations did not catch, PF1, was found by a reviewer asking what the pre-image
read that the post-image does not.

R42's defining primitive for a refactor like this should be **"every property
access present before and absent after"**, not "every guard the plan listed".
The guard list was complete and still missed a live regression.

## Final state

| Gate | Result |
|------|--------|
| `npx tsc --noEmit` | clean |
| `npx eslint .` | exit 0 (2 pre-existing warnings) |
| `npx vitest run` | exit 0 — 985 files, 13,063 passed |
| `npx next build` | exit 0 |
| `PRE_PR_STATIC_ONLY=1 pre-pr.sh` | exit 0 — 52 steps |
| production `console.*` (non-sink) | 0 |
| production `any` | 1 (`with-request-log.ts`, `SC3`) |
| inline `no-explicit-any` disables | 0 |

## Next step

Commit and open a PR. Deferred, recorded rather than silently dropped:
`SC5` (extension/ — 6 console sites, 2 emitting autofilled card/identity values
to the page console; a live pre-existing issue this work surfaced),
`SC6` (cli/ — legitimate stdout), and three Minor items: `PrfValuesWire.second`
is declared but discarded, the wire readers are named casts rather than
validators, and the `ImageCapture` feature-detect branch is uncovered.
