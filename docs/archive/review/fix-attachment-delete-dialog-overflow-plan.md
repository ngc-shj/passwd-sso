# Plan: Fix delete-confirmation dialog long-token overflow

## Project context

- **Type**: web app (Next.js 16 App Router + React + Tailwind 4.1 + shadcn/ui)
- **Test infrastructure**: unit + integration (vitest) + E2E (Playwright) + CI/CD
- **Verification environment constraints**: none blocking. CSS-only fix in one shared
  shadcn component; visually verifiable in local dev. No paid-tier APIs, external
  services, or hardware paths involved.

## Objective

When an attachment with a long filename is deleted, the confirmation dialog
("添付ファイルの削除") renders the filename without wrapping. Long unbroken tokens
(e.g. a 64-char hex name `a4b76f1e34aa...1090a26.jpg`) overflow horizontally out of
the dialog box. The same overflow class affects sibling delete dialogs that interpolate
user-controlled long strings (webhook URLs, folder/tag names). Constrain such content
to wrap within the dialog bounds — once, in the shared component.

## Root cause

`AlertDialogDescription` (`src/components/ui/alert-dialog.tsx:118-129`) carries only
`text-muted-foreground text-sm` — no overflow handling. The default CSS
`overflow-wrap: normal` only breaks at whitespace/hyphens, so a continuous hex filename
(or URL) has no break opportunity and overflows the dialog content box
(`max-w-[calc(100%-2rem)]` mobile / `sm:max-w-lg` desktop).

The attachment dialog is the reported instance; the same shared component is rendered
at ~42 `<AlertDialogDescription>` sites across ~44 files, several of which interpolate
equally-unbreakable user-controlled values:
- `src/components/settings/developer/base-webhook-card.tsx:297` — raw `{w.url}` (a URL; the canonical overflow case, worse than a filename)
- `src/components/layout/sidebar.tsx:236` (`folderDeleteConfirm`, folder name), `:257` (`tagDeleteConfirm`, tag name)
- `src/components/passwords/entry/attachment-section.tsx:457-459` (the reported case)
- `src/components/team/forms/team-attachment-section.tsx:345-347` (team mirror)

## Technical approach

Add `wrap-anywhere` (Tailwind 4.1 utility → `overflow-wrap: anywhere`) to the shared
`AlertDialogDescription` default className.

Why `wrap-anywhere` and not `break-all` or a per-call-site fix:
- `overflow-wrap: anywhere` breaks at normal word boundaries FIRST and only breaks
  inside a token when the token alone would overflow. It therefore does NOT damage
  ordinary prose in the other ~114 dialog descriptions — unlike `break-all`, which
  breaks every line mid-character. This makes it safe to apply at the shared default.
- A per-call-site fix (wrapping each interpolated value in a `<span class="break-all">`
  via `t.rich`) would leave the same bug latent in every dialog not touched by this PR,
  and is the R8 inconsistency the review flagged. Fixing the shared component once
  removes the whole class.
- `overflow-wrap: anywhere` (vs `word-break: break-word`) also lets the element shrink
  below its longest-token width in flex/grid contexts, which the dialog header
  (`AlertDialogHeader` is a CSS grid, `alert-dialog.tsx:78`) relies on to honour
  `max-w`.

`wrap-anywhere` is provided by tailwindcss 4.1.18 (confirmed present in the installed
package). No config change needed.

## Contracts

### C1 — `AlertDialogDescription` default className gains `wrap-anywhere`

File: `src/components/ui/alert-dialog.tsx:125`

```tsx
className={cn("text-muted-foreground text-sm", className)}
```
→
```tsx
className={cn("text-muted-foreground text-sm wrap-anywhere", className)}
```

- **Invariant** (app-enforced): callers that already pass a `className` keep their
  overrides — `cn()` (twMerge) merges, caller classes win on conflict. `wrap-anywhere`
  sets `overflow-wrap`, a property no current caller sets; grep confirms no
  `AlertDialogDescription` call site passes any `break-/wrap-/overflow-/whitespace`
  class (in fact none pass a `className` at all). No conflict possible.
- **Forbidden patterns**:
  - pattern: `t\.rich\(.*confirmDeleteDescription` — reason: the i18n message and call sites must NOT be converted to rich-text; the fix is CSS-only at the shared component. No message-shape change.
  - pattern: `break-all` (added in this diff to `alert-dialog.tsx`) — reason: must use `wrap-anywhere`, not `break-all`, to avoid mid-word breaks in prose descriptions.
- **Acceptance**: a long unbroken filename/URL in any AlertDialog description wraps
  inside the dialog; ordinary multi-word descriptions wrap at word boundaries exactly
  as before (no visual change for short/prose content).
- **Consumer-flow walkthrough**: this contract changes a presentational default on a
  shared component; it produces no data shape consumed by code. All 116 consumers read
  the rendered text only — none read a className or DOM structure. The two attachment
  components, the webhook card, and the sidebar folder/tag dialogs are the
  user-controlled-value consumers that benefit; all other consumers render prose and
  are unaffected because `anywhere` is a no-op when normal word-break opportunities
  exist.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | `AlertDialogDescription` default className gains `wrap-anywhere` | locked |

## Testing strategy

- Manual visual check in local dev (`:3001`):
  1. Attachment delete dialog with a 64-char hex filename → wraps inside the box on
     both narrow (mobile) and `sm` widths.
  2. Webhook delete dialog (`base-webhook-card.tsx`) with a long URL → wraps.
  3. A prose AlertDialog description (e.g. folder/tag delete with a short name, or any
     warning dialog) → renders identically to before (word-boundary wrap, no
     mid-word breaks).
- No new automated test: presentational CSS change on a shared component; the project
  has no visual-regression harness, and a unit test asserting a Tailwind class would be
  decorative (asserts implementation detail — violates project testing rules). The
  message shape is unchanged, so no existing `getByText`/i18n test is affected (the
  earlier `t.rich` approach would have split text nodes — this approach does not, which
  is an additional reason to prefer it).
- `npx vitest run` + `npx next build` per CLAUDE.md mandatory checks.

## Considerations & constraints

- **SC1** (out of scope, intentionally): per-call-site truncation/ellipsis styling
  (e.g. `font-mono`, max-line clamping) for filenames/URLs. The wrap fix solves the
  reported overflow; further typographic polish is a separate concern with no current
  request. Owner: future issue if raised.
- `wrap-anywhere` vs `break-all`: `break-all` rejected because it would break ordinary
  words mid-character across all ~114 prose descriptions (R8 regression). `wrap-anywhere`
  only engages when a single token would overflow.

## User operation scenarios

1. Attachment with 64-char hex filename (the reported case) → wraps to 2-3 lines inside dialog.
2. Webhook delete dialog with a long `https://…` URL → wraps inside dialog.
3. Folder/tag delete with a normal short name → single line, unchanged.
4. Any warning/confirmation dialog with a full prose sentence → word-boundary wrap, visually unchanged from today.
5. Narrow mobile viewport (`max-w-[calc(100%-2rem)]`) → content wraps within the reduced width.
