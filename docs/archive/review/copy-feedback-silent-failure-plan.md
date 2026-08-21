# Plan: copy-feedback-silent-failure

Date: 2026-08-20 (rev 5 — 2026-08-21, scope split after review round 4)
Branch: `fix/copy-feedback-silent-failure`

Four review rounds are recorded in
[copy-feedback-silent-failure-review.md](./copy-feedback-silent-failure-review.md). Rev 5 splits the
work: this plan fixes the reported bug. The re-prompt bypass (former C6) moves to its own plan — see
**Split-out** below.

## The bug

[copy-button.tsx:79-81](../../../src/components/passwords/shared/copy-button.tsx) wraps the value
fetch and the clipboard write in one `try` and swallows every failure:

```ts
} catch {
  // Clipboard access denied
}
```

A fetch error, a decrypt failure, a rejected `writeText`, and a permission denial all produce the same
observable as a dead button. The report framed this as a difference between the left-menu パスワード
view and a folder view; that framing does not survive measurement. `/ja/dashboard` and
`/ja/dashboard/folders/[id]` both render `PasswordDashboard view="all"`, differing only in which prop
is set, and a throwaway component test mounted both shapes with the real
row → menu → button chain, clicked the ⧉, and both passed (2/2). There is no view-dependent code — a
failure is simply invisible, so one succeeding click and one failing click look like a view difference.

`GET /api/passwords/[id]` is not step-up gated (`src/app/api/passwords/[id]/route.ts:331` is
`method:DELETE`), so no server-side work is in scope.

## Requirements

1. Every terminal outcome of a copy is reported, except a deliberate user cancellation.
2. A copy that put nothing on the clipboard is never reported as success.
3. The row ⧉, the ⋮ menu, the detail pane and the accordion card converge on one feedback behaviour.
4. The 30-second clipboard auto-clear keeps its current observable behaviour, including the
   unconditional fallback write when read-back is unavailable.
5. Clipboard writes of a value whose exposure this product bounds in time — vault-blob and overview
   values, the generated password, the recovery key — go through one module in `src/`.
6. No regression at existing `CopyButton` call sites:
   `rg -c "<CopyButton" src --glob '*.tsx' --glob '!*.test.*'` → **58 / 22 non-test files**; with tests
   → **62 / 23**, the delta being `copy-button.test.tsx`.

## Member sets (R42)

**Class A — `src/` code writing an in-class value to the clipboard.**
`rg -n "navigator\.clipboard" src --glob '!*.test.*'` → 10 files. In scope: `copy-button.tsx`,
`use-entry-actions.ts`, `password-card.tsx` (clear at `:147-164`, import `:145`),
`recovery-key-dialog.tsx:156-163`, `password-generator.tsx:164-175`. Out: `share-dialog.tsx`,
`send-dialog.tsx` (SC2); `create-grant-dialog.tsx`, `grant-card.tsx`,
`team-invite-by-email-section.tsx` (SC3). No `navigator["clipboard"]`, no destructured `clipboard`, no
`execCommand` in `src/`.

**Class B — copy paths that terminate without user-visible output.** Two steps.
1. Mechanical, over the five in-scope files:
   `rg -n "if \(!.*\) return;|catch\s*\{\s*(\}|//|$)|await navigator\.clipboard\.writeText" <files>`
   → **59** raw matches (measured; an earlier revision said 36 and was wrong).
2. Filter: keep matches inside a copy handler whose enclosing block produces no user-visible output.
   Drops: the four nested best-effort catches inside the clear routines (`copy-button.tsx:67,72`;
   `password-card.tsx:154,159`); the ten `catch { toast.error(t("networkError")) }` in
   `password-card.tsx:340,360,372,384,396,408,420,432,444,456`; the unrelated catches at
   `recovery-key-dialog.tsx:81,128,170` and `password-card.tsx:470,612,622`; and every
   `await writeText` whose handler already reports.

**Members (16)** — `copy-button.tsx:79`; `use-entry-actions.ts:81, 138`;
`password-card.tsx:346, 351, 368, 380, 392, 404, 416, 428, 440, 452`; `password-generator.tsx:171` and
`:164-168` (`copyHistory`, an unguarded `await writeText` whose rejection is terminal with no output);
`recovery-key-dialog.tsx:160`.

**Class B′ — false-success paths** (a *wrong* output, so outside Class B's definition but in scope for
requirement 2): `password-card.tsx:334-343` (`handleCopyContent`) and `:354-363`
(`handleCopyPassword`) have no empty guard — on `""` they `writeText("")` then
`toast.success(tCopy("copied"))`, the same archetype as `copy-button.tsx:56`.

**Toaster.** `rg -ln "Toaster" src/app` → `[locale]/layout.tsx:61`, `s/layout.tsx:22`; all 22 host files
render under one. `CopyButton` is in `NS_DASHBOARD_CORE:29`, `NS_ADMIN_ALL:97`, `NS_PUBLIC_SHARE:109`;
**`PasswordCard` is only at `:30`**, which is why every `CopyButton` string lives in the `CopyButton`
namespace.

## Contracts

### C1 — the clipboard primitive (`src/lib/clipboard/`)

`copy-secret.ts` carries `"use client"`; no `navigator` at module scope. `copy-cancelled-error.ts` is a
**leaf** module (no imports) so the sentinel never drags the dialog/vault graph into `CopyButton`,
which renders on the unauthenticated `/s/` route.

```ts
// copy-cancelled-error.ts
export class CopyCancelledError extends Error { readonly name = "CopyCancelledError"; }

// copy-secret.ts
export const COPY_OUTCOME = {
  OK: "ok", EMPTY: "empty", CANCELLED: "cancelled",
  UNAVAILABLE: "unavailable", SOURCE_FAILED: "source_failed", WRITE_FAILED: "write_failed",
} as const;
export type CopyOutcome = (typeof COPY_OUTCOME)[keyof typeof COPY_OUTCOME];

export async function copySecretToClipboard(getValue: () => Promise<string> | string): Promise<CopyOutcome>;
export async function copySecretWithoutClear(getValue: () => Promise<string> | string): Promise<CopyOutcome>;
```

The no-clear variant is a separate named export rather than an option flag, so a future audit can grep
one identifier instead of reasoning about a boolean reachable from 58 call sites.
`isClipboardAvailable` is module-private.

**Invariants**

- **INV-1.1** — never throws; every path returns a `CopyOutcome`.
- **INV-1.2 (ordering)** — the availability check runs first. Clipboard absent ⇒ `UNAVAILABLE`,
  `getValue` **not called**: no secret is decrypted, and no re-prompt is demanded, on a path that
  structurally cannot consume the result.
- **INV-1.3 (classification)** — `EMPTY` when the returned value is `""` or trims to empty, decided
  before any write. `CANCELLED` **only** when `err instanceof CopyCancelledError` — never by
  `err.name`, `err.code`, or message text, so a duck-typed impostor classifies `SOURCE_FAILED`.
  `SOURCE_FAILED` for any other rejection, a non-`Error` throw, or a non-string resolution.
  `WRITE_FAILED` when `writeText` rejects. `OK` only when `writeText` resolved for a non-empty value.
  `CANCELLED` is reachable today: `createGuardedGetter` (`use-reprompt.ts:46-59`) wraps the detail
  pane's getters and rejects when the user declines the passphrase dialog. `use-reprompt.ts:55` changes
  from `new Error("cancelled")` to `new CopyCancelledError()` so C1 can discriminate by type.
- **INV-1.4 (byte fidelity)** — trimming decides emptiness only; `writeText` gets the value untrimmed.
- **INV-1.5 (clear)** — scheduled only on `OK` by `copySecretToClipboard`, using
  `CLIPBOARD_CLEAR_TIMEOUT_MS` from `@/lib/constants`. Reads the clipboard back and overwrites only on
  exact `===` match; **when `readText()` rejects it overwrites unconditionally.** That fallback is the
  dominant path on Firefox (no page-script `readText`) and WebKit (permission-gated) and is kept
  deliberately: bounding a decrypted secret's residency outranks preserving an unrelated clipboard
  value. Accepted consequence — copying a secret then copying something else within 30 s loses the
  second value on those engines. `copySecretWithoutClear` schedules nothing.
- **INV-1.6 (the timer is not React state)** — the clear is scheduled outside component lifecycle and
  **must not** be cancelled on unmount or on client-side navigation. Today neither
  `copy-button.tsx:61-76` nor `password-card.tsx:147-164` registers cleanup and the timer fires after
  unmount; that is correct and is preserved.

**No timeout.** An earlier revision bounded `getValue` with a timer. That was introduced to close a
never-settling guarded getter, and it cannot be built safely without the re-prompt work: the timeout
fires, the dialog is still open, and a later verification caches the entry as verified with nothing on
the clipboard — a worse failure than the one it closes. A never-settling getter therefore still yields
no outcome, exactly as today. Recorded as a known limit, owner: the split-out plan.

**Control class** — **detection/audit only** for the outcome, plus a **best-effort tripwire** for the
30 s clear. Tripwire bypasses, exhaustively: `readText` unavailable (handled by the unconditional
fallback); both writes rejecting; a backgrounded/unfocused document; tab close, reload or process exit
(*not* unmount, *not* in-app navigation — INV-1.6); OS-level clipboard history (`Win+V`, macOS
Universal Clipboard, Android), which no in-page clear reaches. The change's one fail-closed element is
INV-2.1.

**Acceptance** — one case per outcome, each asserting outcome **and** mutation: clipboard absent ⇒
`UNAVAILABLE` + `getValue` not called; `""` / `"   "` ⇒ `EMPTY` + no write; `"  p  "` ⇒ `OK` +
`writeText("  p  ")` exactly; `CopyCancelledError` ⇒ `CANCELLED` + no timer;
`Object.assign(new Error("x"), { name: "CopyCancelledError" })` ⇒ `SOURCE_FAILED`; plain rejection ⇒
`SOURCE_FAILED` + no write; `writeText` rejects ⇒ `WRITE_FAILED` + no timer; resolve ⇒ `OK` + exactly
one timer at `CLIPBOARD_CLEAR_TIMEOUT_MS` (imported, never re-typed); `copySecretWithoutClear` +
resolve ⇒ `OK` + **zero** timers; unmount after `OK` ⇒ the clear still fires (INV-1.6). Clear
behaviour: read-back matches ⇒ one `writeText("")`; differs ⇒ **no** write; rejects ⇒ one
`writeText("")`; both writes reject ⇒ no throw escapes.

**Consumer-flow walkthrough** — `CopyButton` (C2), `useEntryActions` (C3), `PasswordCard` (C4) read the
`CopyOutcome`; C3/C4 additionally need the source/write split to preserve their existing `networkError`
text. `password-generator` (C5b) reads it and keeps its 2 s `copiedGenerated` state on `OK`.
`recovery-key-dialog` (C5b) calls `copySecretWithoutClear` and keeps `t("recoveryKeyCopySuccess")`. All
five need only the outcome value; the no-clear consumer is served by the second export, so the shape is
complete.

### C2 — `CopyButton` reports every outcome

`CopyButtonProps` unchanged; all 58 production sites keep compiling. No production site passes `label`,
so `aria-label` is the observable everywhere.

- **INV-2.1** — `copied` (green check + `aria-label="copied"`) only on `OK`. The change's one
  fail-closed element: it removes today's false positive where `writeText("")` succeeds and the check
  appears.
- **INV-2.2** — `OK` ⇒ `toast.success(t("copied"))`. `EMPTY`, `UNAVAILABLE`, `SOURCE_FAILED`,
  `WRITE_FAILED` ⇒ `toast.error` with their own `CopyButton`-namespace key. **`CANCELLED` raises
  nothing** — a deliberate decline is not a failure, and "try again" after a refused passphrase trains
  users to click through a security control.
- **INV-2.3** — `CopyButton` never calls `copySecretWithoutClear`: the `copied` string promises
  clearing.

### C3 — `useEntryActions` consumes C1

- **INV-3.1** — both silent guards go (`:81`, `:138`); both report `EMPTY`.
- **INV-3.2** — `scheduleClearClipboard` (`:67-76`) deleted; clearing comes from C1 alone.
- **INV-3.3** — `SOURCE_FAILED` keeps `toast.error(tCard("networkError"))`.

### C4 — `PasswordCard` consumes C1

- **INV-4.1** — all 11 handlers (`:334-459`) route through `copySecretToClipboard`; the private
  `scheduleClearClipboard` (import `:145`, function `:147-164`) is deleted with its import.
- **INV-4.2** — this file's Class B members are removed (`:346`, `:351`, and the eight
  `if (!x) return;` at `:368, 380, 392, 404, 416, 428, 440, 452`), and Class B′ is closed:
  `handleCopyContent` and `handleCopyPassword` stop reporting success on an empty value.
- **INV-4.3** — **one** shared `reportCopyOutcome(outcome, { tCopy, tCard? })`, exhaustively switched
  over `CopyOutcome` with a `never`-typed default. `SOURCE_FAILED` renders `tCard("networkError")` when
  supplied and falls back to `tCopy("copySourceFailed")` when not — which is what `CopyButton` needs on
  `/s/` and admin routes, where the `PasswordCard` namespace is not loaded. All ten non-silent handlers
  already emit the identical `t("networkError")`, so eleven duplicated switches would buy nothing, and
  `use-entry-actions.ts:20-22` / `entry-actions-menu.tsx:83-84` both forbid that duplication. Adding an
  outcome member must be a compile error at the reporter.
- **INV-4.4** — `handleCopyUsername` reads `username` from the overview (`:346`) and must not gain a
  fetch.

### C5 — i18n

Add to `messages/{en,ja}/CopyButton.json`:

| Key | en | ja |
|---|---|---|
| `copyEmpty` | `Nothing to copy — this field is empty` | `コピーする内容がありません（項目が空です）` |
| `copyUnavailable` | `Clipboard unavailable in this browser context` | `このブラウザ環境ではクリップボードを利用できません` |
| `copyWriteFailed` | `Couldn't reach the clipboard — check the browser's clipboard permission` | `クリップボードに書き込めませんでした。ブラウザのクリップボード権限をご確認ください` |
| `copySourceFailed` | `Couldn't load this item — try again` | `項目を読み込めませんでした。もう一度お試しください` |

- **INV-5.1 (parity)** — `src/i18n/messages-consistency.test.ts:63` iterates `NAMESPACES` and must stay
  green. It compares **key names only**.
- **INV-5.2 (existence + placeholders)** — parity is green when a key is missing from *both* locales,
  and every component test echo-mocks `useTranslations`, so `t("copyEmpty")` returns `"copyEmpty"`
  regardless. A test reads the real JSON with `readFileSync` + `JSON.parse` (the
  `src/__tests__/i18n/audit-log-keys.test.ts:6-13` pattern — ENOENT must throw, never yield `{}`),
  asserts the four keys in both locales, **and** asserts placeholder-set equality across locales for
  every touched key, since INV-5.4 changes an existing ICU signature and parity cannot see that.
- **INV-5.3 (disclosure)** — no toast interpolates caught-error text, `Error.message`, a response body,
  or the copied value. `build-personal-get-detail.ts:64` runs `JSON.parse` on the **decrypted vault
  blob** and V8 embeds an input prefix in `SyntaxError.message`. The diagnostic sink is
  `clientLogError(CLIENT_LOG_EVENT.CLIPBOARD_COPY_FAILED, { code: toClientErrorCode(err) })`, **never**
  `console.*`: `eslint.config.mjs:105` sets `no-console: "error"` over `src/**` with two sanctioned
  sinks, and `sentry-scrub.ts:166-197` scrubs breadcrumb `data`/`url` but not `message`, where
  `@sentry/browser`'s console integration puts formatted arguments. `toClientErrorCode`
  (`src/lib/logger/client-events.ts:154-180`) branches on `instanceof` and `DOMException.name` only,
  never reading `message` or `cause`, so the payload is closed by construction. It is emitted in
  production; `use-password-entry-detail.ts:74-83` gates the *same* closed payload to development, so
  that inconsistency is recorded rather than silently inherited — owner: follow-up.
- **INV-5.4 (constant coupling)** — `copied` hardcodes "30s" / "30秒" while `CLIPBOARD_CLEAR_TIMEOUT_MS`
  lives at `src/lib/constants/timing.ts:7`, and INV-2.2 promotes that string from an incidental tooltip
  to a toast at 58 sites. Interpolate the seconds from the constant in both locales, and reword to state
  the attempt rather than a guarantee C1 declares best-effort. This changes an existing ICU signature at
  13 call sites: `copy-button.tsx:51`, `use-entry-actions.ts:83`,
  `password-card.tsx:338,349,358,370,382,394,406,418,430,442,454`.

### C5b — `recovery-key-dialog` and `password-generator` consume C1

- **INV-5b.1** — `recovery-key-dialog.tsx:156-163` calls `copySecretWithoutClear`;
  `password-generator.tsx:164-175` (**both** `copyHistory` and `copyGenerated`) calls
  `copySecretToClipboard`. The `catch { // Fallback: select text }` at `:160`, which performs no such
  fallback, is removed.
- **INV-5b.2** — each keeps its own success feedback on `OK` (`t("recoveryKeyCopySuccess")`; the 2 s
  `copiedIdx` / `copiedGenerated` state). `copyGenerated`'s `if (!generated) return;` (`:171`) reports
  `EMPTY`; `copyHistory` gains a failure path where it has none today.
- **INV-5b.3** — the recovery key opts out of the 30 s clear because the user is told to store it
  permanently; the generated password does not.

## Testing strategy

- **P1 — RT-3 characterization, green on current code, BEFORE C1 lands.** The clear routines at
  `copy-button.tsx:61-76` and `password-card.tsx:147-164` have no coverage today, so requirement 4 is
  otherwise unverifiable over two thirds of the collapse. Four cases: read-back matches / differs /
  rejects / both writes reject.
  **Fixture order is part of the contract**, measured: `vi.useFakeTimers({ shouldAdvanceTime: true })` →
  `userEvent.setup({ advanceTimers })` → install the `navigator.clipboard` descriptor → click.
  `userEvent.setup()` installs **its own** clipboard stub, so the naive order records
  `toast.success: 1` with `writeText: []`; plain `vi.useFakeTimers()` with `userEvent` times out at 10 s
  because the Radix menu never opens. Every such test asserts
  `expect(navigator.clipboard.writeText).toBe(writeText)` immediately before the click, so "user-event
  clobbered the stub" fails loudly and separately from "the handler did not run".
  `password-card.test.tsx` installs no `navigator.clipboard` today and must.
- **P2 — fixture-leak fix**, registered at acquisition, in every file this change extends:
  `use-entry-actions.test.tsx:84`, `copy-button.test.tsx:14`, `password-generator.test.tsx:33`,
  `totp-field.test.tsx:27`, `password-detail-pane.test.tsx:322` (the last installs inside an `it()`, so
  its teardown registers per-test). `use-entry-actions.test.tsx:136/:152` has no `try`/`finally`, so a
  failing assertion leaves the rest of that file under fake timers; `src/__tests__/setup.ts:28-36`
  restores neither timers nor globals. Paired positive: one test asserting `navigator.clipboard` is
  `undefined` at the start of a fresh case — which RT-2's `UNAVAILABLE` case needs anyway.
- **RT-1** (`copy-secret.test.ts`) — C1's acceptance cases, outcome **and** mutation.
- **RT-2** (`copy-button.test.tsx`) — the six outcomes → `aria-label` + toast + `writeText` called/not.
  The false-success red-proof lives on **`EMPTY`** (reds on today's code, which calls `writeText("")`
  and shows the check); `SOURCE_FAILED` reds on today's silent `catch {}`. The **`CANCELLED` case is
  green before and after** — today's `catch {}` produces the same observable — and carries a comment
  saying so; it still earns its place by redding against an implementation that classifies cancel as
  `SOURCE_FAILED`. Assert via `getByRole("button", { name })`, never `getByText` (`stateLabel` renders
  at `:94` and `:105`).
- **RT-5** — one case per Class B member (16), plus a paired set for Class B′: for each of
  `handleCopyContent` and `handleCopyPassword`, `""` ⇒ `copyEmpty` toast + `writeText` **not** called +
  zero timers, and `"x"` ⇒ `toast.success` + one `writeText("x")` + one timer. The deny clause must be
  red-proven against current `password-card.tsx`, where it calls `writeText("")` and
  `toast.success` — record that as the P1 baseline. `use-entry-actions.test.tsx:123` ("no-op when entry
  has no username") has its assertion **moved** to `toastError(copyEmpty)`, not deleted.

**Sonner assertion points.** `toast` is asserted in one file today (`use-entry-actions.test.tsx:86-87`,
via `vi.spyOn`). `password-dashboard.test.tsx:92-94` and `entry-list-view.test.tsx:235-237` mock
`sonner` into **unasserted** sinks. Every file rendering a component this change touches gains a
`sonner` mock **or** a spy plus one assertion that uses it: `copy-button.test.tsx`,
`password-card.test.tsx`, `entry-actions-menu.test.tsx`, `password-generator.test.tsx`,
`totp-field.test.tsx`, `password-detail-pane.test.tsx`, `recovery-key-dialog.render.test.tsx` — whose
mock at `:62-63` is `{ toast: { success } }` with **no `error`**, which C5b adds, so the first test
reaching the new failure path would throw `toast.error is not a function`. Assert
`vi.isMockFunction(toast.error)` in setup so an incomplete mock fails as "mock incomplete".

**Sibling stub holders.** `rg -ln 'vi.mock\(.*copy-button' src` → **22 paths** (21 `*.test.tsx` + the
shared helper `src/components/__tests__/webhook-card-test-factory.tsx`, which a test-glob audit misses).
These stub `CopyButton` away and will not observe C2's toast. `CopyButtonProps` is unchanged, so this is
a read, not an edit — recorded as the twin-drift surface.

New-key assertions are echo-mock phantoms at the component layer; INV-5.2's real-JSON test is what
proves the keys and their placeholders.

## Split-out: the re-prompt bypass

Rounds 1-4 established, by execution, a **pre-existing** client-side authorization defect that this
change does not create and does not fix. It is recorded here so the split is auditable, and it owns its
own plan.

- `createGuardedGetter` (`use-reprompt.ts:46`) reaches `CopyButton` only via
  `password-detail-inline.tsx:49` → `sections/*` (15 of 32 sites). The row ⧉ and ⋮
  (`entry-actions-menu.tsx:145-152`, `use-entry-actions.ts:135-148`) and `PasswordCard`'s eleven
  handlers pass raw getters.
- `secure-note-section.tsx:59` copies the note body — the whole secret of a SECURE_NOTE — with a raw
  getter, while declaring `createGuardedGetter` in `SectionProps:17` and never using it.
- **The team vault is fail-open today**: `build-team-get-detail.ts` never sets `requireReprompt`,
  `InlineDetailData.requireReprompt` is optional (`src/types/entry.ts:23`), and 30 gating reads across
  8 files coalesce absence to `false`.
- `use-layout-mode.ts:27` returns `"accordion"` for every server and first-client render, so
  `PasswordCard`'s surface is not a narrow-viewport edge case.

Why it is not in this PR: the guard spans four surfaces, two layouts, runtime-discriminated fields
(`login-section.tsx:177` decides on `field.type === HIDDEN`, and custom-field labels are user-authored
so two fields on one entry can share a label), getters delivered through four hops of JSX spread ending
in a higher-order function's closure, and three `useReprompt` instances with independent caches. Four
rounds produced seventeen Criticals against successive designs for it, the last being that the
verification mechanism itself would freeze the bypass as a reviewed artifact. It needs its own design
phase. *Worst case if deferred*: unchanged from today — `requireReprompt` does not protect the row, the
⋮ menu, the accordion, secure notes, or any team entry. *Likelihood*: certain, and present now.
*Cost of doing it here*: demonstrated over four rounds.

**This PR does touch one line of it**: `use-reprompt.ts:55` rejects with `CopyCancelledError` instead of
`new Error("cancelled")`, so C1 can tell a declined passphrase from a failure (INV-1.3). Without that,
C2 would show "Couldn't load this item — try again" to a user who deliberately clicked Cancel.

## Also deferred

- **SC2** — `share-dialog.tsx`, `send-dialog.tsx`. Share/send URLs are out of requirement 5's class; the
  **access passwords** at `:457` / `:236` are in class and excluded on cost. *Worst case*: an access
  password the user believes is on the clipboard is not, with no clear. *Likelihood*: low. Owner:
  follow-up issue filed with this PR.
- **SC3** — `create-grant-dialog.tsx`, `grant-card.tsx`, `team-invite-by-email-section.tsx`: invite URLs,
  out of class. Same argument, lower worst case. Owner: same issue.
- **SC4 — E2E coverage.** No E2E asserts the copy path (`rg -rn "clipboard|Copied|コピー" e2e/` → two
  `grantPermissions` lines and a comment). Measured and ready for whoever picks it up: the CI binary is
  `chromium_headless_shell` (no `channel` in `e2e/playwright.config.ts`), where a no-grant context
  **rejects** `writeText`; `grantPermissions(["clipboard-read"])` denies write on **both** binaries, so
  `WRITE_FAILED` needs no stub; the success case needs `clipboard-read` **and** `clipboard-write`
  because `readText` rejects without it; an authenticated vault-unlocked session is reachable via
  `e2e/tests/favorites.spec.ts:15-25`. *Cost*: the local E2E stack has six prerequisites and cannot be
  run here, so a spec written now would ship unexecuted (R41). Owner: follow-up issue.
- **SC5** — the same secret-copy-with-clear contract in three other runtimes:
  `cli/src/lib/clipboard.ts` (uses **`clipboardy`**, so a `navigator.clipboard` grep misses it; own
  `CLEAR_TIMEOUT_MS` at `:12`), `extension/src/background/clipboard.ts` + `extension/public/offscreen.js`
  (`execCommand("copy")`), `extension/src/popup/components/MatchList.tsx:58-62` (user-configurable
  `clipboardClearSeconds`, no read-back), `ios/Shared/Clipboard/SecureClipboard.swift`. They cannot
  import a `"use client"` module. *Worst case*: four definitions of the interval, one user-settable.
  Owner: follow-up issue.
- **SC6 — a CI gate forbidding `navigator.clipboard` outside the primitive.** Wanted, but it belongs
  with the split-out work, which needs it more: it must resolve `navigator.clipboard` by ts-morph
  binding (a spelling list inverts only over what it enumerates), must exclude `*.test.*`, must narrow
  to `clipboardData\s*\.\s*setData` (the bare token matches `share-password-gate.tsx:39`'s paste read),
  and needs both a `scripts/__tests__/` self-test and a `queue_step` line in `scripts/pre-pr.sh` — a
  gate with a self-test and no `queue_step` passes the meta-gate and never runs.
- **The view-parity pin.** Mounting `PasswordDashboard` with the real
  `PasswordList`→`EntryListView`→`PasswordRow` chain was measured not to mount without three further
  mocks (`VAULT_DATA_CHANGED_EVENT` on the `@/lib/events` mock, `next-auth/react` for
  `Favicon`, `TeamVaultProvider` for the pane) plus `fetchApi` shapes for the pane's `/attachments` and
  `/history` sub-requests, and a crashed tree fails with the same observable as an unwired button. The
  measurement it would pin is recorded in **The bug** above and in the review artifact. *Cost* exceeds
  its value: it is green before and after the change.
- **M23 (question)** — `rg -n "isSecureContext" src` → 0, so `isClipboardAvailable() === false` is in
  practice the app's only detector of a non-secure origin, and `http://<tailscale-host>:3001` is exactly
  such an origin. *What would settle it*: whether an unconditional HTTPS redirect covers both the
  production and the developer/verification access paths.

## User operation scenarios

1. Row ⧉ on a healthy LOGIN entry → check icon + success toast; clipboard cleared after 30 s.
2. Row ⧉ on an entry whose blob fails to decrypt → `copySourceFailed` toast, no check icon.
3. Row ⧉ over a non-HTTPS origin → "clipboard unavailable"; the secret is never fetched.
4. Row ⧉ on a LOGIN entry with an empty password → "nothing to copy", nothing written.
5. ⋮ → パスワードをコピー on the same empty entry → the same toast.
6. Detail pane, a `requireReprompt` entry: decline the passphrase dialog → nothing happens and nothing
   is shown (today's behaviour, preserved deliberately).
7. Secure note with an empty body, accordion card → "nothing to copy" instead of a green check.
8. Recovery-key dialog copy fails → an error toast where today nothing appears; the key is shown once,
   so a silent failure there is unrecoverable.
9. Detail pane: copy username, password, TOTP in quick succession → three success toasts.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| P1 | RT-3 characterization green on current code, measured fixture order | pending |
| P2 | Fixture-leak fix in the five extended test files | pending |
| C1 | clipboard primitive: 6-member union, two exports, leaf error module | pending |
| C2 | `CopyButton` reports every outcome | pending |
| C3 | `useEntryActions` consumes C1 | pending |
| C4 | `PasswordCard` consumes C1 via one shared reporter; Class B′ closed | pending |
| C5 | i18n: four keys, existence + placeholder test, disclosure sink, constant coupling | pending |
| C5b | recovery-key + generator consume C1 | pending |
