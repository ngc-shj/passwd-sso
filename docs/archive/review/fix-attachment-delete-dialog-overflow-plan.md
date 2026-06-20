# Plan: Fix attachment delete dialog filename overflow

## Project context

- **Type**: web app (Next.js 16 App Router + React + Tailwind 4 + shadcn/ui)
- **Test infrastructure**: unit + integration (vitest) + E2E (Playwright) + CI/CD
- **Verification environment constraints**: none blocking. The change is a CSS/markup-only
  fix in two client components; visually verifiable in local dev. No paid-tier APIs,
  external services, or hardware paths involved.

## Objective

When an attachment with a long filename is deleted, the confirmation dialog
("添付ファイルの削除") renders the filename without wrapping. Long unbroken tokens
(e.g. a 64-char hex name `a4b76f1e34aa...1090a26.jpg`) overflow horizontally out of
the dialog box. Constrain the filename so it wraps within the dialog bounds.

## Root cause

`AlertDialogDescription` (`src/components/ui/alert-dialog.tsx:118-129`) carries only
`text-muted-foreground text-sm` — no overflow handling. The filename is interpolated
into the i18n string as plain text:

```tsx
{t("confirmDeleteDescription", { filename: deleteTarget?.filename ?? "" })}
```

The default CSS `overflow-wrap: normal` only breaks at whitespace/hyphens. A continuous
hex filename has no break opportunity, so it overflows the `max-w-[calc(100%-2rem)]`
(mobile) / `sm:max-w-lg` (desktop) dialog content box.

## Technical approach

Scope the line-breaking to the **filename token only**, not the whole description.
A blanket `break-all` on the shared `AlertDialogDescription` component would affect
45 files / 116 call sites and force mid-word breaks on ordinary prose in unrelated
dialogs — rejected.

Use next-intl `t.rich` to render the filename inside a `<span className="break-all">`.
This matches the established codebase pattern for user-controlled long strings
(URLs, usernames) which already use `break-all`:
- `src/components/passwords/detail/sections/login-section.tsx:105,141` (URL, field value)
- `src/components/passwords/detail/password-detail-pane.tsx:260` (username)

`t.rich` is already used in the codebase (`src/app/[locale]/privacy-policy/page.tsx:63`).

## Contracts

### C1 — i18n message converts `{filename}` placeholder to a `<filename>` rich tag

Both locale files, key `confirmDeleteDescription` (`messages/ja/Attachments.json`,
`messages/en/Attachments.json`).

- ja: `「{filename}」を削除してもよろしいですか？この操作は元に戻せません。`
  → `「<filename>{name}</filename>」を削除してもよろしいですか？この操作は元に戻せません。`
- en: `Are you sure you want to delete "{filename}"? This action cannot be undone.`
  → `Are you sure you want to delete "<filename>{name}</filename>"? This action cannot be undone.`

- **Invariant** (app-enforced): the literal corner brackets `「」` (ja) and straight
  quotes `"…"` (en) stay OUTSIDE the tag, exactly as today, so wrapping the inner
  text does not change the punctuation rendering.
- **Forbidden patterns**:
  - pattern: `confirmDeleteDescription.*\{filename\}` — reason: old placeholder form must be fully replaced by the `<filename>` tag in both locales.
- **Acceptance**: `t.rich("confirmDeleteDescription", { filename: (chunks) => <span className="break-all">{chunks}</span> })` renders the filename as a breakable span and the surrounding text unchanged.
- **Consumer-flow walkthrough**: Consumer = the two attachment-section components
  (`attachment-section.tsx`, `team-attachment-section.tsx`). Each reads
  `deleteTarget.filename` and passes it as `{ name: deleteTarget?.filename ?? "" }`
  plus the `filename` chunk renderer to `t.rich`. No other consumer reads this key
  (grep `confirmDeleteDescription` → only these two files + locale files).

### C2 — both attachment-section call sites switch `t(...)` → `t.rich(...)`

Files:
- `src/components/passwords/entry/attachment-section.tsx:457-459`
- `src/components/team/forms/team-attachment-section.tsx:345-347`

Replace:
```tsx
{t("confirmDeleteDescription", { filename: deleteTarget?.filename ?? "" })}
```
with:
```tsx
{t.rich("confirmDeleteDescription", {
  name: deleteTarget?.filename ?? "",
  filename: (chunks) => <span className="break-all">{chunks}</span>,
})}
```

- **Invariant**: both call sites stay byte-identical to each other (parallel
  personal/team implementations — see project memory on commonizing personal/team UI).
- **Acceptance**: long hex filename wraps within the dialog; short filename renders
  identically to before.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | i18n `confirmDeleteDescription` → rich `<filename>` tag (ja+en) | locked |
| C2 | both call sites use `t.rich` with `break-all` span | locked |

## Testing strategy

- Manual visual check in local dev (`:3001`): upload an attachment, rename/use a long
  hex filename, open the delete dialog, confirm the filename wraps inside the box on
  both narrow (mobile) and `sm` widths.
- No new automated test: this is a presentational CSS fix; the project has no visual
  regression harness and a unit test asserting a Tailwind class on interpolated markup
  would be decorative (asserting implementation detail). Existing E2E attachment-delete
  flows remain green (dialog text content unchanged; only markup structure differs).
- `npx vitest run` + `npx next build` per CLAUDE.md mandatory checks.

## Considerations & constraints

- **SC1** (out of scope): the global `AlertDialogDescription` overflow gap across the
  other 114 call sites — deliberately NOT touched here to avoid regressing prose
  dialogs. If a future audit wants a global guard, it belongs in a separate PR that
  reviews each call site. Owner: future issue.
- `break-all` chosen over `break-words`/`overflow-wrap-anywhere` because the failing
  input is a single unbroken token with no break opportunities; `break-words` does not
  break inside such a token. `break-all` is already the codebase convention for
  user-controlled long strings.

## User operation scenarios

1. Attachment with 64-char hex filename (the reported case) → wraps to 2-3 lines inside dialog.
2. Attachment with normal filename `invoice.pdf` → single line, unchanged from today.
3. Filename with mixed spaces and a long token → spaces break naturally, long token breaks via `break-all`.
4. Narrow mobile viewport (`max-w-[calc(100%-2rem)]`) → wraps within the reduced width.
