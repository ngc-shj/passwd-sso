# Plan Review: copy-feedback-silent-failure

Date: 2026-08-20
Review round: 1

## Changes from Previous Round

Initial review. Three expert sub-agents (Functionality / Security / Testing) reviewed the plan
independently. Merge was performed manually from the three machine-readable finding indexes
(the documented fallback when the Ollama prose merger is not used); the json join on
(file, line ±5, root cause) seeded the deduplication and the convergence stamps below.

## Orchestrator adjudications (verified before merging)

Two expert claims contradicted each other and one contradicted the plan. All three were re-derived
by the orchestrator rather than merged as-is:

| Claim | Verdict | Evidence |
|---|---|---|
| Testing F3: "no en/ja key-parity test covers the `CopyButton` namespace" | **REFUTED** | `src/i18n/messages-consistency.test.ts` — `it("keeps key sets aligned between locales per namespace")` iterates `for (const ns of NAMESPACES)`, so INV-5.1 IS automatically enforced. Functionality's contrary reading is correct. The *second* half of Testing F3 (echo-mocked `useTranslations` makes the new-key assertions in component tests phantom) survives as M21. |
| Functionality F4: `execCommand` exists in the repo | **CONFIRMED** | `rg -ln "execCommand" --glob '!node_modules' .` → `extension/public/offscreen.js`, `extension/src/background/clipboard.ts` (+2 docs). The plan's "no `execCommand` fallback exists" was measured over `src/` and written unscoped. Plan defect. |
| Security F1 / Functionality F1: the row ⧉ and ⋮ paths bypass `requireReprompt` | **CONFIRMED** | `createGuardedGetter` (`src/hooks/vault/use-reprompt.ts:46`) reaches `CopyButton` only via `password-detail-inline.tsx:49` → `sections/*`. `entry-actions-menu.tsx:145-152` passes raw `fetchPassword`; `entry-list-view.tsx:428` destructures `requireReprompt` out and discards it. |

## Perspective convergence (severity floor applied)

Per the convergence rule, a finding independently reported by ≥2 perspectives takes the MAXIMUM
reported severity and is floored at Major.

| Merged | Reported by | Floor applied |
|---|---|---|
| M2 (no `CANCELLED` outcome) | Security F2 (Major), Functionality F1 (Major) | Major |
| M3 (clear-fallback misdescribed) | Security F3 (Major), Functionality F3 (Major) | Major |
| M4 (INV-4.2 preserves silence) | Testing F1 (Major), Functionality F5 (Major), Security F10 (Minor) | Major |
| M5 (58 vs 62; `:150-158` range) | Testing F9 (Minor), Security F11 (Minor), Functionality F9 (Minor) | **Major** (3-way convergence + R29) |
| M6 (forbidden-pattern gate) | Security F5 (Major), Functionality F11 (Minor) | Major |
| M21 (sibling tests render CopyButton) | Functionality F10 (Minor), Testing R19 (Minor) | Major |

## Security Findings

**M1 — Critical (escalate: true): the row ⧉ and ⋮ copy paths bypass `requireReprompt`, and the plan
forecloses the fix on an unrelated premise.**
`createGuardedGetter` defers the getter behind `RepromptDialog` → `verifyPassphrase`, and rejects on
cancel. It is wired only through the detail pane's `sections/*`. The row accelerator
(`entry-actions-menu.tsx:145-152`) and the ⋮ menu (`use-entry-actions.ts:135-148`) pass raw getters.
`entry-list-view.tsx:428` drops the flag the adapter supplies (`build-personal-get-detail.ts:71`).
Two adjudicators answer "may this decrypted secret leave the vault?" for the same field of the same
entry, by different semantics, and the weaker one is on the button the user actually clicks (R48).
The plan's line 60 — "No step-up work belongs in this change" — is a true statement about a
*server-side* `@stepup` marker on DELETE, carrying a decision about a *client-side* `requireReprompt`
gate on GET-then-copy that it does not support (R29 rationale clause).
*escalate_reason*: multi-step trust boundary; the remedy touches the consolidated primitive and the
team-vault adapter, and the plan actively closes it.

**M8 — Major: no invariant forbids interpolating caught-error text into the failure toast, while VC2
and scenario 2 push toward it.** `build-personal-get-detail.ts:65` runs `JSON.parse(plaintext)` on
the **decrypted vault blob**; V8 embeds an input prefix in `SyntaxError.message`. An `err.message`
interpolation renders decrypted plaintext into an on-screen toast. Not injection (React/sonner
escape) — disclosure, which is the harm a zero-knowledge product exists to prevent.

**M9 — Major: SC1's scope-out rests on a false rationale.** SC1 says the two members "have their own
feedback". `recovery-key-dialog.tsx:156-163` catches with a comment describing a select-text fallback
that does not exist in that function — the exact silent failure this plan removes, on the
highest-value secret in the product, with no auto-clear. `password-generator.tsx:164-175` has no
try/catch at all. Same for `share-dialog.tsx:457` / `send-dialog.tsx:236` (share access password).
Additionally the disposition table partitions on "writes a secret **and** has a 30 s clear", so
members are excluded *because* they lack the control.

**M7 — Major (R49): C1's declared control class is stronger than the implementation.** C1 is declared
`fail-closed verification gate`; it denies nothing. It is a total classification function
(detection-only for the outcome) plus one best-effort tripwire (the 30 s clear, whose bypasses —
`readText` unavailable, both writes rejected, OS clipboard history — are unlisted). The gate's own
scoping and C2's deliberate downgrade both lean on C1 carrying a boundary it cannot carry.

**M22 — Minor: INV-2.3 promotes "Copied! (clears in 30s)" to a toast at all 58 sites**, asserting a
guarantee C1 itself declares best-effort and that never reaches OS clipboard history. Also R27: the
literal "30s" in both locale strings goes stale if `CLIPBOARD_CLEAR_TIMEOUT_MS` changes.

**M23 — Minor (question): `UNAVAILABLE` is effectively the app's only insecure-context detector**
(`rg -n "isSecureContext" src` → 0 hits) and is surfaced as a clipboard-capability message. What
answer closes it: is there an unconditional HTTPS redirect on *both* the production and the
developer/verification access paths? Note `http://<lan-or-tailscale-host>:3001` is **not** a secure
context, which matches this project's dev access pattern.

## Functionality Findings

**M2 — Major: `COPY_OUTCOME` has no `CANCELLED` member.** `use-reprompt.ts:55` rejects with
`new Error("cancelled")` when the user declines the passphrase dialog. INV-1.2 routes any `getValue`
rejection to `FAILED`, and INV-2.2 makes every non-`OK` raise `toast.error` → the user who
deliberately declines is told "Couldn't copy — try again". Today's `catch {}` is *correct* for this
one path. ~32 guarded call sites across `sections/*`, `password-detail-inline.tsx`, `totp-field.tsx`.
Discriminate on a typed sentinel exported from `use-reprompt.ts`, never on `error.message` (R47).

**M11 — Major: `FAILED` conflates "could not obtain the secret" with "could not write the
clipboard".** Scenario 2 promises "error toast naming the failure" and VC2 rests the plan on the
change being the diagnostic. One undifferentiated `FAILED` names nothing. It is also a regression:
`use-entry-actions.ts:86` and `password-card.tsx:341,361,…,457` currently distinguish the source path
with `networkError`, which INV-4.2 commits to preserving — so INV-4.2 and C1 are mutually
unsatisfiable as written. Split into `SOURCE_FAILED` / `WRITE_FAILED`.

**M12 — Major: the order of the `UNAVAILABLE` check relative to `getValue()` is unspecified.** Under
the natural reading (getValue first), a non-HTTPS origin performs the full fetch + AES-GCM decrypt
before discovering the clipboard does not exist; if that fetch fails the outcome is `FAILED` and
scenario 3's promised toast never appears. Also decrypts a secret on a path that cannot consume it.
Gate first; acceptance case "clipboard absent → `UNAVAILABLE`, `getValue` **not called**".

**M4 — Major: C4/INV-4.2 preserves silence in branches Requirement 1 forbids.** For
`password-card.tsx:345-352` the "existing user-visible toast text" on failure is `catch {}` —
nothing. Eight further `if (!x) return;` guards at `:368,380,392,404,416,428,440,452` are
structurally identical to `use-entry-actions.ts:81`, which INV-3.1 explicitly removes: the plan
removes it on one side of the twin and preserves it on the other. `use-entry-actions.ts:138`
(`onCopyUsername`) is a second silent guard INV-3.1 also misses. An existing test —
`use-entry-actions.test.tsx:123` — will keep passing and now reads as coverage for a
requirement-1 violation. C4 also never says what `EMPTY`/`UNAVAILABLE` produce in `PasswordCard`.
Requires a `never`-typed exhaustive switch so adding an outcome is a compile error at all 11
handlers.

**M3 — Major: INV-1.3's rationale misdescribes the code it says to retain.** All three
implementations fall into a `catch` that writes `""` **unconditionally**, with no still-holds check.
`readText()` is unavailable to page script in Firefox and permission-gated in WebKit, so that
fallback is the *dominant* path there, not the exceptional one. Two readings, both defects: retain it
and every secret copy blanks the clipboard 30 s later regardless of what it now holds (destroying a
newer copy); implement INV-1.3 literally and nothing clears on those engines, removing the only time
bound on a decrypted secret. The plan does not decide, and the consolidation is the moment it is
cheap to.

**M10 — Major (R42 recompute): `code \ plan` is non-empty and two claims are stated unscoped.**
Verified by the orchestrator: `cli/src/lib/clipboard.ts` implements the same secret-copy-with-clear
contract and carries its own `CLEAR_TIMEOUT_MS = 30 * MS_PER_SECOND` (a second definition of the
constant INV-1.4 claims is centralised); `extension/public/offscreen.js:16` +
`extension/src/background/clipboard.ts:36` use `execCommand("copy")`;
`ios/Shared/Clipboard/SecureClipboard.swift` is a third. These are cross-runtime (Node / MV3 worker /
Swift) and genuinely cannot import a `"use client"` module — the remedy is scope honesty plus an
`SC5`, not a merge. The CLI's duplicated 30 s literal is the one cheap convergence.

**M6 — Major: the forbidden-pattern gate is declared over two trees and then narrowed to three
files.** As declared it can never go green (seven SC members live under `src/components/**`); as
narrowed it is an instance check — a new component calling `navigator.clipboard.writeText(secret)`
matches nothing and the gate reports PASS. Invert it: scan `src/**` minus an explicit named exception
list (the primitive + the seven SC members with their SC ids), so new matches fail by default. Add
the destructured spelling (`const { clipboard } = navigator`) and note that the class is closed by
the exception-list inversion, not by pattern completeness (R47). No control class is declared for the
check itself, and its CI status is unstated; `scripts/checks/check-gate-selftest-coverage.sh` exists
and would not cover it.

**M5 — Major (R29): derived figures used inconsistently.** `:211` says "62 call sites" while `:77`
and `:291` say 58. Both reproduce — 62 includes test files — but they are used for one referent
without stating the glob difference, and the toaster-availability derivation walks "the 22 host
files". Separately `:104/:196/:243` cite the `PasswordCard` clear as `:150-158`; it spans `:147-164`
with its import at `:145`, so an implementer deleting the cited range leaves the signature, the
closing brace and a dead import.

**M19 — Minor: whitespace-as-empty widens the predicate it replaces.** `use-entry-actions.ts:81`
(`!val`) and `password-card.tsx:368` (`!num`) treat only `""` as empty. INV-1.2 adds whitespace, and
the plan never says whether the value handed to `writeText` is trimmed. A password with significant
leading/trailing whitespace must be written byte-identically; `" "` is a tie to call explicitly.

**M20 — Minor (question): `isClipboardAvailable()` is exported with no consumer in the walkthrough.**
Is it for a call site outside C1 — e.g. disabling the ⧉ button in an insecure context so the user
sees the constraint before clicking? If yes it belongs in the walkthrough and the file list; if no,
make it module-private.

## Testing Findings

**M13 — Major: the declared mocking boundary cannot mount `PasswordDashboard`.** `use-layout-mode.ts:12`
calls `window.matchMedia`, absent in jsdom — `password-list.test.tsx:53` carries the comment verbatim.
`useVault`, `decryptData`, `buildPersonalEntryAAD`, `useTravelMode`, a `ResizeObserver` polyfill and
`sonner` are all required too. The dangerous variant: a naive `matchMedia` stub (`matches: false`)
renders **`PasswordCard`, not `PasswordRow`** — green, named for the row path, testing the card path.
Mock `@/hooks/use-layout-mode` directly and assert the master-detail precondition before clicking.

**M14 — Major: VC1's Anti-Deferral justification prices one branch and defers the whole real-browser
layer.** `.github/workflows/ci.yml:568-575` already runs Playwright/Chromium against a live stack, and
`e2e/tests/teams.spec.ts:24` / `emergency-access.spec.ts:21-22` already call
`grantPermissions(["clipboard-read","clipboard-write"])`. **Withholding** `clipboard-write` makes
Chromium's `writeText` reject — the `FAILED` branch, in a real browser, at zero added cost. So OK +
FAILED are `verifiable-CI`, not `blocked-deferred`; only UNAVAILABLE + WebKit-activation are blocked
(WebKit is deliberately not installed, `ci.yml:569-572`). Separately,
`rg -rn "clipboard|Copied|コピー" e2e/` returns only those two permission lines: **no E2E asserts the
copy path at all**, so requirement 4 is never observed against a real `Clipboard` object.

**M15 — Major: RT-3 is green before and after the change, and RT-4's second clause is never
red-proven.** RT-3 re-runs the throwaway measurement the plan records passing 2/2 on unchanged code —
a rejected-hypothesis pin, legitimate but it must be labelled or someone will later treat it as the
row-copy regression test. RT-4's "leaves the button un-checked" clause is green today too
(`setCopied(true)` at `:57` is unreachable when `getValue()` rejects), so it can be deleted without a
red. The false-success regression that motivates C2 has no test that reds on current code — it reds
only on the EMPTY case, which the plan files under RT-2 (see M17).

**M16 — Major: requirement 4 has no baseline for two of the three collapsed implementations.** Only
`use-entry-actions.test.tsx:135-153` pins the clear today. `copy-button.test.tsx` never advances
timers; `password-card.test.tsx:39` mocks `../shared/copy-button` away and installs no
`navigator.clipboard` at all. Two thirds of the collapse is a deletion with nothing to compare
against, so "preserved exactly" is unverifiable. Add characterization assertions at both, prove them
green on current code, then re-run after the collapse.

**M17 — Minor: RT-2 asserts the visible label but not the mutation (RT8).** Today's code *does* call
`writeText("")` on an empty value; INV-1.2 requires the check to precede any write. RT-2 as specified
passes against an implementation that still wipes the user's clipboard and merely suppresses the
check icon.

**M18 — Minor: fixture teardown is unspecified, and the file RT-5 extends already leaks.**
`use-entry-actions.test.tsx:136`/`:152` has no `try`/`finally`, so a failing assertion at `:150`
leaves every later test in the file under fake timers. `:83`'s `Object.assign(navigator, {clipboard})`
is never removed and `vi.restoreAllMocks()` does not undo it. `src/__tests__/setup.ts:28-36` restores
neither timers nor globals, so there is no backstop. RT-1 needs fake timers and RT-2 needs to *remove*
`navigator.clipboard`; both need teardown registered at acquisition.

**M21 — Major (converged): 18 sibling test files render `CopyButton`** — `entry-actions-menu`,
`password-row`, `password-card`, the eight `sections/*`, `share-entry-view`, `share-send-view`,
`team-scim-token-manager`, `team-pending-invitations-list`, four `settings/developer/*`. C2 adds a
`toast.success` inside `CopyButton`; any of these asserting `sonner` call counts, or mocking
`copy-button` away, now diverges from the real component (R19 / RT9). The plan's file list names only
`copy-button.test.tsx` and the `use-entry-actions` / `password-card` tests. Also: the four test-file
`<CopyButton>` sites are exactly the 62−58 delta in M5.

**Refuted — Testing F3 first half.** See Orchestrator adjudications. The surviving half: every test in
this chain echo-mocks `useTranslations` (`copy-button.test.tsx:6-8`), so RT-2's
`copyFailed`/`copyEmpty`/`copyUnavailable` assertions pass against an implementation where C5 was never
written. Assert via `getByRole("button", { name })`, never `getByText` — `stateLabel` renders twice
(`copy-button.tsx:94` aria-label and `:105` TooltipContent). Recorded as part of M21.

## Adjacent Findings

- Functionality M12 → `[Adjacent] Major` to Security: decrypting a vault secret on a path that
  structurally cannot consume it is unnecessary plaintext exposure.
- Testing M14 → `[Adjacent] Minor` to Security: a clear that silently never fires in a real browser
  leaves a decrypted secret resident indefinitely.
- Testing M4 / Security M4 → `[Adjacent] Major` to Functionality: INV-4.2 contradicts requirements 1
  and 3.
- Functionality M21 → `[Adjacent] Minor` to Testing: mock alignment with a changed shared component.

## Quality Warnings

None. Every finding named a file and line inside the change or in code the change consolidates; the
two questions (M20, M23) are correctly ranked Minor and phrased as questions with a stated closing
answer, per the Finding Floor.

## Round 1 tally

1 Critical (escalated), 15 Major, 7 Minor, 1 refuted.

The Critical (M1) and several Majors (M2, M11, M12, M4, M3) change contract *shapes*, not prose —
`COPY_OUTCOME`'s member set, C1's signature, and C4's scope all move. Per the Go/No-Go rule every
contract stays `pending`.

## Recurring Issue Check

### Functionality expert
R1 F4 · R2 F4 · R3 F5 · R4 N/A · R5 N/A · R6 N/A · R7 Pass · R8 Pass · R9 N/A · R10 Pass · R11 N/A ·
R12 F5 · R13 N/A · R14 N/A · R15 N/A · R16 Pass · R17 F4 · R18 Pass · R19 F10 · R20 F9 · R21 N/A ·
R22 F4 · R23 N/A · R24 N/A · R25 N/A · R26 F8 · R27 Pass · R28 N/A · R29 F3, F9 · R30 Pass · R31 N/A ·
R32 N/A · R33 N/A · R34 F3 · R35 Pass · R36 Pass · R37 Pass · R38 Pass · R39 Pass · R40 N/A · R41 F2 ·
R42 F4 · R43 N/A · R44 N/A · R45 N/A · R46 F11 · R47 F11 · R48 Pass · R49 F11, F4 · R50 Pass ·
R51 N/A · R52 F3 · R53 N/A · R54 N/A · R55 F7 · R56 N/A · R57 N/A

### Security expert
R1 F3 · R2 Pass · R3 F10 · R4 N/A · R5 N/A · R6 N/A · R7 Pass · R8 Pass · R9 N/A · R10 Pass · R11 N/A ·
R12 F2 · R13 N/A · R14–R20 N/A · R21 N/A · R22 Pass · R23 N/A · R24 N/A · R25 N/A · R26 Pass ·
R27 note under F9 · R28 Pass · R29 F1, F6, F11 · R30 Pass · R31 N/A · R32 N/A · R33 N/A · R34 Pass ·
R35 N/A · R36 Pass · R37 F9 · R38 Pass · R39 Pass · R40 N/A · R41 N/A · R42 F1, F2, F5, F6 ·
R43 F2, F3 · R44 Pass · R45 Pass · R46 N/A · R47 F5, F2 · R48 F1 · R49 F4, F5, F9 · R50 Pass ·
R51 N/A · R52 F1 · R53 N/A · R54 N/A · R55 Pass · R56 N/A · R57 N/A
RS1 N/A · RS2 N/A · RS3 Pass with note (add a `typeof value === "string"` guard in C1) · RS4 Pass ·
RS5 N/A · RS6 Pass

### Testing expert
R1 Pass · R2 Pass · R3 F1 · R4 N/A · R5 N/A · R6 N/A · R7 F3 (partly refuted — see adjudications) ·
R8 Pass · R9 N/A · R10 N/A · R11 N/A · R12 Pass · R13 N/A · R14 N/A · R15 N/A · R16 Pass · R17 F1 ·
R18 Pass · R19 F1, F7 · R20 Pass · R21 N/A · R22 Pass · R23 N/A · R24 N/A · R25 N/A · R26 N/A ·
R27 Pass · R28 N/A · R29 F9 · R30 Pass · R31 N/A · R32 N/A · R33 Pass · R34 F4 · R35 F4 · R36 Pass ·
R37 Pass · R38 Pass · R39 Pass · R40 N/A · R41 F3 (refuted) · R42 F1 · R43 N/A · R44 Pass · R45 Pass ·
R46 N/A · R47 N/A · R48 Pass · R49 Pass · R50 F2 · R51 N/A · R52 Pass · R53 N/A · R54 N/A · R55 Pass ·
R56 N/A · R57 N/A
RT1 F4 · RT2 Pass · RT3 Pass · RT4 F8 · RT5 F2 · RT6 Pass · RT7 F5 · RT8 F7 · RT9 F6 ·
RT10 Pass with caveat · RT11 F8

---

# Review round: 2

Date: 2026-08-21

## Changes from Previous Round

The plan was rewritten to rev 2: contracts grew 5 → 10 (C6 reprompt, C7 view-parity pin, C8 E2E,
C9 recovery-key/generator, C10 CI gate), the outcome union grew 4 → 6 members, and the round-1
corrections were applied. Round 2 reviewed that rewrite.

## Orchestrator adjudications (re-derived by execution before merging)

| Claim | Verdict | Evidence |
|---|---|---|
| INV-6.1's target `entry-list-view.tsx:428` is the row copy path | **REFUTED — orchestrator's own error** | `:424-436` is `handleShare`; `:428` strips internal fields from the share payload. Round 1's security finding said ":428 discards the flag"; the *bypass* was verified, the *remedy target* was not. Deleting `requireReprompt: _rp` injects the flag into `shareData` and delivers nothing to the row callbacks. Converged: Functionality F1 (Critical), Security S10, Testing T7. |
| The real seam is already on the overview row | **CONFIRMED** | `DisplayEntry.requireReprompt` (`display-entry.ts:34`) and `TeamDisplayEntry.requireReprompt` (`team-display-entry.ts:31`) are both non-optional `boolean`. `DisplayEntryLike` (`use-entry-actions.ts:13-16`) is the type that must widen. |
| Withholding `clipboard-write` makes Chromium's `writeText` reject (round-1 F4, accepted into VC1) | **REFUTED** | Testing ran a Playwright probe: with no `grantPermissions`, `clipboard-write` reports `granted` and `writeText` **resolves**; `readText` rejects unless `clipboard-read` is granted. Playwright has no deny API. C8's negative case has no executable path as specified. |
| Team vault is fail-open on `requireReprompt` today | **CONFIRMED** | `build-team-get-detail.ts` never sets `requireReprompt`; `InlineDetailData.requireReprompt` is `?: boolean`; 26 gating sites coalesce `?? false`. Pre-existing, independent of this change. |
| `secure-note-section.tsx:59` copies the note body with a raw getter | **CONFIRMED** | `SecureNoteSection({ data })` destructures only `data`; `createGuardedGetter` is declared in `SectionProps:17` and unused. |
| INV-5.3's `console.error` sink is unimplementable | **CONFIRMED** | `eslint.config.mjs:105` sets `no-console: "error"` over `src/**`; `sentry-scrub.ts:166-193` scrubs breadcrumb `data`/`url` but not `message`, where console breadcrumbs land. |

## Round 2 findings

**Critical**
- **F1 / S10 / T7 (converged)** — INV-6.1 targets the share-payload strip, not the copy path.
- **F2 / S4 (converged)** — C6 locks no shape: `repromptDialog` is a `ReactNode` that must be
  rendered for the promise to settle, and C6 names no mount point on the row surface. As written,
  `getValue()` never settles and `copySecretToClipboard` never returns — silence, on the path the
  change tightens. S4 adds that `useReprompt`'s single `pending` slot (`use-reprompt.ts:16,54`)
  orphans a superseded promise and attributes the passphrase to whichever entry called `setPending`
  last, with no entry identity in the dialog — a confused deputy the moment guarded getters sit on a
  list of rows. Also collides with the recorded INV-C2.3 (`password-detail-pane.tsx:62-64`).
- **S1** — INV-5.3 relocates the decrypted-plaintext disclosure from a transient local toast to an
  indexed remote sink, and cannot be implemented without a third sanctioned console sink or an
  inline disable. Remedy: `clientLogError(CLIENT_LOG_EVENT.…, { code: toClientErrorCode(err) })`,
  matching what `use-password-entry-detail.ts:74-83` already does for the same error object.
- **S2** — C6's member set omits the team detail pane (fail-open today) and
  `secure-note-section.tsx:59`. The declared *enforceable boundary* is fail-open for an entire vault
  kind and an entire entry type. `InlineDetailData.requireReprompt` should become required so the
  compiler, not a grep, enumerates the sites. Counter-case that forbids a blanket default:
  `dashboard/emergency-access/[id]/vault/page.tsx:251` sets `false` deliberately — the grantee cannot
  satisfy the grantor's passphrase.

**Major (19)** — F3 (`createGuardedGetter`'s `() => string` cannot accept the async getters INV-6.2
wraps), F4/T7 (INV-6.3's `undefined` case unreachable; ~26 `?? false` upstream), F5/S3 (guard is
per-field in the pane, per-surface in C6 — over-guards SSH fingerprint and passkey username), F6/T6/S5
(C1's one-parameter signature cannot express INV-9.3's clear opt-out; any parameter is an escape hatch
C10 cannot see), F7 (C6 puts a human typing a passphrase between click and `writeText`, making
`WRITE_FAILED` dominant on Firefox/WebKit), F8 (SC5's derivation command does not reach
`cli/src/lib/clipboard.ts`, which uses `clipboardy`, and misses
`extension/src/popup/components/MatchList.tsx` whose clear interval is user-configurable), F9 (C10 reds
on day one — no test-file exclusion), F14/T8 (sibling-test set: stated 18, enumerated 19, actual 22 —
and they *stub `CopyButton` away*, so the audit inspects the set that cannot be affected), F15/T5
(Class B not re-derived after C9: `password-generator.tsx:171` and `recovery-key-dialog.tsx:160` are
members 13 and 14), T1 (C8's premise refuted), T2 (C7's mock set omits the `PasswordList` stub it must
remove), T3 (C5's keys have no test that can fail — parity proves alignment, not existence), T4
(`PasswordCard.networkError` is not in `NS_PUBLIC_SHARE`/`NS_ADMIN_ALL`, so `SOURCE_FAILED` renders a
missing message on `/s/` and admin routes), T9 (`recovery-key-dialog.render.test.tsx:62` mocks `sonner`
without `error`), T10 (C10 is "registered" in the meta-gate but never wired into `scripts/pre-pr.sh`,
so it never runs), S6 (C10 omits `execCommand("copy")`, `clipboardData.setData`,
`navigator["clipboard"]`).

**Minor (11)** — F10-F13, T11-T15, S7-S9, S11.

## Round tally and the convergence judgement

| Round | Contracts | Critical | Major |
|---|---|---|---|
| 1 | 5 | 1 | 15 |
| 2 | 10 | 4 | 19 |

Finding count is not converging, and the character has shifted: **all four round-2 Criticals target
contracts introduced in round 2** (C6 ×3, C5's INV-5.3 ×1). No Critical in either round has targeted
the original fix — removing the silent `catch {}` and reporting the outcome.

Saturation is NOT met: criterion 3 (no finding against the design itself) fails outright — C6's shape
is unlocked, C1's signature cannot express INV-9.3, and the guard's axis (field vs surface) is
undecided. But the growth pattern is the one the plan-phase guidance warns about: each round adds
prose, prose is reviewable surface, and the additions are generating the defects.

**Recommendation recorded for the user's decision: split the work.** C6 is not a bolt-on to a
feedback fix. It sits on a pre-existing Critical (team fail-open) that this change did not create and
would not have fixed, it needs a per-field guard table, a request-keyed `pending` queue, an
async-widened `createGuardedGetter`, and a mount point for `repromptDialog` on the list surface. That
is a security change with its own design, and reviewing it inside a UI-feedback PR is what produced
four rounds of shape churn.

---

# Review round: 3

Date: 2026-08-21

## Changes from Previous Round

Plan rev 3 applied all 34 round-2 findings: C6 retargeted to the overview row, guard axis moved to
`(entryType, field)`, request-keyed pending, `InlineDetailData.requireReprompt` made required,
`copySecretWithoutClear` as a separate export, `clientLogError` instead of `console.error`, C10's
pattern set widened and wired, C8's technique rewritten, P1/P2 prerequisite gate rows added.

## Round 3 findings: 5 Critical, 20 Major, 9 Minor

**Critical**

- **F1 / T16 (converged, both red-proven with the repo's own `tsc`)** — INV-6.3's enforcement
  mechanism does not exist. For `interface D { requireReprompt: boolean }`, the expression
  `d.requireReprompt ?? false` compiles **exit 0**; `@typescript-eslint/no-unnecessary-condition` is
  not configured. Making the property required errors at **construction** sites only (one production:
  `build-team-get-detail.ts:77`; twelve fixtures) and surfaces **zero** of the gating reads. The
  orchestrator asserted a verification mechanism without executing it — the third such error this
  session. The stated figure is also wrong: 30 across 8 files (`data.requireReprompt ?? false`), or 48
  across 19 for the bare spelling — not "26 across 9".
- **F2 / S1 (converged)** — C6 leaves the **accordion layout** unguarded. `PasswordCard` renders the
  same `EntryActionsMenu` (`:578`) from its own raw fetchers (`:586-592`) and its own eleven handlers
  (`:345-458`), and never calls `useEntryActions`. `use-layout-mode.ts:20` returns `"accordion"` below
  1024 px **and** `:27` returns it for every server/first-client render. So C6's declared "enforceable
  boundary" is fail-open for narrow viewports and the team accordion. `EntryCardData.requireReprompt`
  is optional (`entry-card.ts:30`), defaulted at `password-card.tsx:209`, and delivered through
  `entry as unknown as EntryCardData` (`entry-list-view.tsx:812`) — so no compile step can catch it.
- **F3** — INV-6.2's `(entryType, field)` key is **not computable** at two of the three call sites it
  names. `use-entry-actions.ts`'s `DisplayEntryLike` is `{ id, username }` and has no `entryType`;
  `entry-actions-menu.tsx` has `entryType` (`:28`) but neither `id` nor `requireReprompt`. With
  deny-by-default an unresolvable key denies, so copying a public SSH fingerprint would demand a
  passphrase — what INV-6.2 forbids. Verified feasible fix: adding `entryType` + `requireReprompt` to
  `DisplayEntryLike` and `requireReprompt` to `PasswordRowEntry` compiles clean repo-wide (exit 0).
- **S2** — INV-6.2's two clauses specify **opposite** fail-safe defaults. "One exported table holds the
  **guarded set**" + "a pair absent from the table **denies**" cannot both hold; the only shippable
  reading (absent ⇒ unguarded) is fail-open, and it bites immediately because
  `InlineDetailData.entryType` is optional and the emergency page coerces it.
- **T17 (measured)** — `userEvent.setup()` installs its own clipboard stub over `navigator.clipboard`.
  RT-3's password-card leg therefore records `toast.success: 1` with `writeText: []`. Measured working
  order: `vi.useFakeTimers({ shouldAdvanceTime: true })` → `userEvent.setup({ advanceTimers })` →
  install the descriptor → click. RT-3 is P1, the gate on C1/C4.

**Major (20)** — F4/S3 (the guarded set is keyed by runtime discriminators the static table cannot
hold: HIDDEN custom fields share a label with TEXT ones; TOTP's guard arrives through an optional
`wrapCopyGetter` prop whose default is unguarded), F5 (INV-6.5 states its obligation but does not
discharge it — no owner, no mount point, no resolution of the INV-C2.3 conflict, and two `useReprompt`
instances would have divergent cache lifetimes), F6/T22 (`COPY_GETVALUE_TIMEOUT_MS` has no value, no
home, and a post-timeout verification toasts failure **and still caches the entry as verified** — a
fail-open produced by the timeout added to close a silence), F7 (INV-6.6 spends `CANCELLED` on
supersession, reinstating the silence requirement 1 forbids), F8/T19 (Class B's derivation returns 36
matches, omits `copy-button.tsx:79` — the archetype — and its spelling cannot match its own declared
member `:351`), F9/S7 (C10 reds day one on `share-password-gate.tsx:39`, a paste **read**; narrow to
`clipboardData.setData`), F10 (INV-4.3's `reportCopyOutcome(outcome, t)` cannot express both the
`CopyButton` and `PasswordCard` namespaces C5 requires), F11 (requirement 5's "vault secret"
definition excludes two members C9 scopes in), S4 (the guard table has no derivation anchor and the
change destroys the `sections/*` source it derives from — the repo already solves this shape with
manifest + ts-morph gates), S5, S6 (TOTP optional-prop delivery), S8 (C10's inversion does not close
the class; an aliased `navigator` evades all six spellings — use ts-morph binding resolution),
S9 (C1's bypass list wrongly claims unmount/navigation kill the clear timer; "fixing" it would create
the bypass), S10 (INV-5.5 changes an existing ICU signature at 13 call sites and parity compares key
names, not placeholders), T18 (**measured**: the CI binary is `chromium_headless_shell`, where a
no-grant context reports `prompt` and `writeText` **rejects**; and `grantPermissions(["clipboard-read"])`
denies write in *both* binaries — so `WRITE_FAILED` is reachable in a real browser with no boundary
double, and rev 3's recorded permission block is wrong), T20 (the fixture-leak set is 8 install sites,
5 in blast radius; `password-generator.test.tsx` is an RT-5 target named in neither P2 nor the teardown
paragraph), T21 (C6 asserts on `isCacheValid`, which `useReprompt` does not return), T23 (C7's mock set
is derived from a truncated range and is silent on nine modules `entry-list-view.test.tsx` mocks,
including `MasterDetailShell`, `PasswordDetailPane`, `useEntryActions`), T24 (**neither** designated
real-render observer mocks `sonner` — C2's success toast has an assertion point in exactly one file).

**Minor (9)** — F12-F15, S11-S15, T25, T26.

## Round tally

| Round | Contracts / gate rows | Critical | Major | Criticals attributable to C6 |
|---|---|---|---|---|
| 1 | 5 | 1 | 15 | 1 of 1 |
| 2 | 10 | 4 | 19 | 3 of 4 |
| 3 | 12 | 5 | 20 | 4 of 5 |

C1–C4 — the contracts that fix the reported bug — have produced **zero** Criticals in three rounds.
Every Critical has been C6 or its supporting machinery, except round 2's INV-5.3 sink, now closed.

Saturation is not met and is not approaching: criterion 3 (no finding against the design) fails
outright each round. The design that keeps failing is C6's, and each round's accepted remedy has
generated the next round's Critical — the guard table's key is uncomputable where it is needed (F3),
cannot express two live members (F4/S3), has no derivation anchor once it replaces its own source
(S4), spans two layouts with different components (F2/S1), and its fail-safe default is stated in two
contradictory ways (S2).

Round 3 also produced executable findings against the **core** fix's test design (T17, T18, T19, T24)
that are being crowded out by C6's churn.

---

# Review round: 4

Date: 2026-08-21

## Changes from Previous Round

C6 was **redesigned**, not patched: the hand-authored guard table became a checked-in manifest
generated by a ts-morph gate from the pre-refactor tree (gate row P3), keyed `(entryType, fieldKind)`
with a closed vocabulary, stated as an **allow** list so absence denies, extended to the accordion
surface, with a 7th outcome `SUPERSEDED`, a timeout scoped to unguarded getters, and C10 split into
two ts-morph gates.

## Round 4 findings: 7 Critical, 19 Major, 8 Minor

### Three-way convergence on one Critical

**S1 / F1 / T27 — the manifest generator would freeze the original bypass as a certified ALLOW entry.**
All three experts derived this independently. On the pre-refactor tree the same `(entryType, fieldKind)`
key has **both** a guarded and an unguarded site:

| key | guarded | unguarded |
|---|---|---|
| LOGIN / PASSWORD | `login-section.tsx:62` | `entry-actions-menu.tsx:145`, `password-card.tsx:354` |
| CREDIT_CARD / CARD_NUMBER | `credit-card-section.tsx:49` | `entry-actions-menu.tsx:147`, `password-card.tsx:365` |
| IDENTITY / ID_NUMBER | `identity-section.tsx:160` | `entry-actions-menu.tsx:148`, `password-card.tsx:449` |
| PASSKEY / CREDENTIAL_ID | `passkey-section.tsx:75` | `entry-actions-menu.tsx:149`, `password-card.tsx:389` |
| BANK_ACCOUNT / ACCOUNT_NUMBER | `bank-account-section.tsx:84` | `entry-actions-menu.tsx:150`, `password-card.tsx:401` |
| SOFTWARE_LICENSE / LICENSE_KEY | `software-license-section.tsx:56` | `entry-actions-menu.tsx:151`, `password-card.tsx:413` |

INV-6.1 states no reduction rule. As an ALLOW-list generator ("recorded ⇒ may copy without
verification"), the natural reduction emits `(LOGIN, PASSWORD)` as **exempt** — the round-1 Critical,
laundered into a reviewed, frozen, machine-derived artifact after which CI reports green forever.
Measured by Testing: 41 `<CopyButton>` sites under `src/components/passwords/**`, **14** guarded, so
**27** would be emitted as ALLOW — including all seven `entry-actions-menu.tsx` accelerators (the
bypass itself), the secure-note body, the detail-pane header, and TOTP. C10's gate checks only
*presence* and *staleness*, never a verdict's **value**, so no test can fail. And the derivation
function is destroyed by the change it gates: after C6 lands, "flows through `createGuardedGetter`" is
no longer a signal, so the verdicts can never be re-derived.

### Other Criticals

- **S3 / F2 — the coverage authority structurally cannot see the surfaces the guard exists for.**
  `check-clipboard-guard-coverage.mjs` scans `<CopyButton getValue=…>` renders. The ⋮ menu items are
  `DropdownMenuItem onSelect={onCopyPassword}` (no `<CopyButton>` anywhere), `password-card.tsx`'s 11
  handlers are plain async functions (the file contains no `<CopyButton>` at all), and
  `use-entry-actions.ts` is outside the scan root. The gate certifies the one surface that was never
  broken. Compounding it, `--write` **cannot infer getter provenance by AST**: `entry-actions-menu.tsx:145`
  is `getValue={fetchPassword}`, a bare prop whose origin is four JSX hops away through a
  `{...callbacks}` spread ending in a higher-order function's returned closure; `totp-field.tsx:98` is a
  ternary on an optional prop supplied two components up; `login-section.tsx:177` is one JSX site with
  two verdicts. And no gate in this repo parses JSX —
  `rg -l "JsxAttribute|JsxOpeningElement" scripts/checks/*.mjs src/__tests__` → **zero**.
- **F3 / T32 — INV-1.1's guarded/unguarded timeout split is inexpressible in C1's signature.** C1
  declares two exports each taking an opaque `getValue`, and explicitly forecloses a discriminating
  parameter. Under the only shippable reading (the timeout applies to everything), 15 s races a human
  typing a passphrase: the timeout fires, `SOURCE_FAILED` toasts, the dialog is still open, the user
  finishes, and `handleVerified` calls `markVerified` **unconditionally** — the entry is cached as
  verified for 30 s with nothing on the clipboard, so the next copy skips the gate. INV-6.8's
  "abandoning must not call `markVerified`" does not reach this: a timeout is not an abandonment.
- **S2 / F9 — the secure-note body is unguarded at every surface and absent from every enumeration.**
  `secure-note-section.tsx:59`, `password-card.tsx:334-343`, `use-entry-actions.ts:136`. INV-6.5's
  cited range `:345-458` starts one handler late and cuts off `handleCopyContent`; INV-6.2's list of
  today's unguarded pairs omits it; INV-6.3's `fieldKind` vocabulary has no `CONTENT`. Per S1 the
  generator would record it as ALLOW.

### Major (19)

S4/F6 (both list adapters produce the row guard's flag, are outside `readRequireReprompt`, and are
outside the gate's roots; the personal one falls back onto the **decrypted overview blob** for a
security-policy flag), S5 (INV-5.4's production-emission rationale misstates the precedent — the same
closed `{ code }` payload, whose comment says "Keep this gate"; the conclusion holds, the reason does
not), S6 (SUPERSEDED's stated trigger is blocked by the modal overlay; its *reachable* trigger is a
pre-paint double-click on one button, which would emit `toast.success` **and** an error toast for one
successful copy; and the shared dialog keeps the typed passphrase across a subject swap while a stale
`onVerified` can `markVerified` a superseded entry), S7/F7/T33 (Class B's stated anchor of 36
measures 59; the filter names 10-11 of 43 drops and its stated rule retains ten non-silent catches),
S8 (the list-scoped instance widens a **per-entry, not per-field** verification to 30 s across every
surface — one passphrase releases CVV, note body, hidden custom fields, history and TOTP; and the
INV-C2.3 amendment reads as retiring the prohibition rather than narrowing it), F4 (`PasswordCard` is
made a guard consumer but has no adjudicator at its second render site,
`emergency-access/[id]/vault/page.tsx:355`), F5 (the cast removal needs INV-6.4 to compile and reds an
unenumerated `EntryCardData` producer at `page.tsx:174`), **F8 (796 lines of untracked sub-agent probe
files left under `src/`, inside both mandatory checks, invisible to the diff-scoped hygiene gate —
removed by the orchestrator on receipt)**, T28 (the shared-label acceptance row is unqueryable by
accessible name; its only writable form binds to DOM order — the phantom-match trap), T29 (C7's mock
set is provenance-complete but **does not mount**: three further modules are required and a crashed
tree fails with the same observable as an unwired button), T30 (the sonner rationale is contradicted
by the code — both observers *do* mock sonner, into unasserted sinks — and the remedy list excludes
the two files it describes), T31 (C10's `requireReprompt ??` regex cannot match `password-card.tsx:209`'s
destructuring default, a member INV-6.5 removes by hand; the plan condemns regex for the sibling gate
in the adjacent paragraph), T34 (RT-4's axes omit cache expiry, so the branch that deletes
`use-reprompt.test.ts` loses the only TTL-boundary coverage, and `CACHE_TTL_MS` is module-private),
T35 (`handleCopyContent` and `handleCopyPassword` have no empty guard — they `writeText("")` then
`toast.success`, the false-success archetype — and are correctly outside Class B's "silent" definition,
so no RT-5 case covers the two highest-traffic handlers whose behaviour changes), T38 (C6's VC ledger
says "on Chromium, C8 covers it"; C8 has no re-prompt case and `requireReprompt` is not seedable —
`rg -n 'requireReprompt' e2e/` → zero).

### Verified-correct dispositions (executed)

RT-3's mandated fixture order **works** — measured `writeText: [["alice"]]`, identity assertion true,
clear fired at +31 s; the naive order reproduces T17 exactly. C8's permission table **re-measured on
both binaries and every cell reproduces**; `grantPermissions(["clipboard-read"])` rejects `writeText`
with `NotAllowedError` on both. P2's 8-file / 5-file member set is exact. INV-6.7's red count
reproduces exactly (1 production + 12 fixtures). Requirement 6, Class A, the Toaster and namespace
claims, and `clipboardData\s*\.\s*setData` matching zero times all reproduce.

## Trajectory

| Round | Contracts / gate rows | Critical | Major | Criticals traceable to C6 or its verifier |
|---|---|---|---|---|
| 1 | 5 | 1 | 15 | 1 of 1 |
| 2 | 10 | 4 | 19 | 3 of 4 |
| 3 | 12 | 5 | 20 | 4 of 5 |
| 4 | 13 | **7** | 19 | **7 of 7** |

Criticals rise monotonically. C1–C4 — the contracts that fix the reported bug — have produced **zero**
Criticals in four rounds.

Round 4 is qualitatively different from rounds 1-3. Earlier Criticals were omissions in C6's coverage,
each closable by naming the missed member. Round 4's are defects in the **verification mechanism
introduced to close round 3's** — and the headline one is that the mechanism would certify the original
bypass. Three independent experts derived it separately. That is the signal that the approach, not the
detail, is wrong: C6's guard must span four surfaces, two layouts, runtime-discriminated fields,
getters delivered through four hops of JSX spread, and three hook instances with independent caches.
That is a refactor project with its own design phase, not an invariant that can be added to a
feedback fix.

Saturation remains unmet and is diverging, not converging.
