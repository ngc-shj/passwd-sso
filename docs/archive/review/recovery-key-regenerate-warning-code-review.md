# Code Review: recovery-key-regenerate-warning-wording

Date: 2026-05-31
Review round: 1 (standalone Phase 3)
Branch: fix/recovery-key-regenerate-warning-wording

## Changes from Previous Round

Initial review. Scope: i18n wording fix — the recovery-key dialog reused the
"generating a new one will invalidate the previous key" warning even when the
key was *already* invalidated by a vault key rotation (the state the banner
links from), contradicting the banner's "already invalidated" message.

Diff (`git diff main...HEAD`):
- `messages/en/Vault.json`, `messages/ja/Vault.json` — add key `recoveryKeyRegenerateInvalidatedWarning`.
- `src/components/vault/recovery-key-dialog.tsx` — select the invalidated-state
  message when `recoveryKeyInvalidated` is true, else the generic regenerate warning.
- `src/components/vault/recovery-key-dialog.render.test.tsx` — new render test (3 cases).

## Functionality Findings

No findings.

- Server makes the two flags mutually exclusive on rotation: `rotate-key-server.ts`
  sets `recoveryKeySetAt: null` + `recoveryKeyInvalidatedAt: new Date()`;
  `api/vault/status/route.ts:64,68` maps them to `hasRecoveryKey=false` /
  `recoveryKeyInvalidated=true`. After rotation only the invalidated branch fires.
  Ternary precedence (tests `recoveryKeyInvalidated` first) is correct even in a
  hypothetical both-true state.
- i18n completeness: only `en` and `ja` locales exist; both updated. Banner
  (`recovery-key-banner.tsx:57-59`) uses the identical predicate, so dialog and
  banner are now semantically aligned.
- No other consumer renders the warning block; no parallel fix needed.

## Security Findings

No findings.

- `recoveryKeyInvalidated` is server-sourced (`api/vault/status/route.ts:68`,
  RLS-scoped behind `checkAuth`), consumed (never set) by the client
  (`vault-context.tsx:197`). A forged client value would only swap which of two
  warning strings shows — it cannot make an invalid key usable.
- New message is truthful (past-tense invalidation) and strictly better than the
  prior wording, which could have lulled the user into thinking a valid key remained.
- No `dangerouslySetInnerHTML`; next-intl `t()` returns escaped text; new strings
  are static literals with no interpolation; no secrets/identifiers.

## Testing Findings

No findings.

- Regression guard present: the invalidated-state test asserts both the positive
  (`getByText("recoveryKeyRegenerateInvalidatedWarning")`) AND the critical negative
  (`queryByText("recoveryKeyRegenerateWarning")).toBeNull()`).
- Test independence: `beforeEach` resets both flags + `vi.clearAllMocks()`.
- Mock-reality consistency: the `useVault` mock provides exactly the 5 fields the
  component destructures (`recovery-key-dialog.tsx:104`). Translation keys are not
  substrings of each other, so exact-match `getByText` is unambiguous.
- All three gate branches covered (invalidated / has-key / neither).
- i18n key-parity test `src/i18n/messages-consistency.test.ts` exists and passes
  with the new key present in both locales.

## Resolution Status

No findings to resolve. All three experts returned "No findings" in Round 1.
Loop terminated.

Verification: `npx eslint`, `npx vitest run` (10767 passed), `npx next build`
all green on this diff (run during the test-gen pass; diff unchanged since).
