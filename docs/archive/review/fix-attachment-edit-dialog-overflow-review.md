# Plan Review: fix-attachment-edit-dialog-overflow
Date: 2026-07-20
Review round: 1

## Changes from Previous Round
Initial review.

## Functionality Findings

Root-cause analysis confirmed CORRECT. Full ancestor chain traced on both personal and
team paths. `[&>*]:min-w-0` on the DialogContent grid correctly targets the grid ITEMS:
- Personal (personal-password-edit-dialog.tsx:262-278): form + `border-t pt-4 mt-2`
  wrapper are sibling JSX children → direct grid items.
- Team (team-login-form.tsx etc.): form returns a React Fragment `<>`, so `<form>` and
  the `border-t pt-4` wrapper both become separate direct grid-item children.
No deeper `min-w-0` propagation needed — the `space-y-*` blocks are ordinary block
containers (already `min-width:0`); the only nested flex (the row) already has `min-w-0`
on its child. No form wide-content regression (only one `font-mono` block, uses
`break-all whitespace-pre-wrap`). `overflow-y-auto` interaction safe. Member-set complete:
personal + team + all 8 entry types via the shared shell; the `new` dialog shares the
shell but has no attachment section pre-creation (harmlessly covered).

**F1 — Minor**: Plan cites `personal-password-edit-dialog.tsx:271` without its full path.
Actual: `src/components/passwords/dialogs/personal-password-edit-dialog.tsx`. Team count
of 8 confirmed correct. No effect on the fix (fix only touches entry-dialog-shell.tsx);
doc accuracy only. → Correct the path in Root cause + Forbidden-patterns sections.

## Security Findings

**No findings.** Presentational CSS-only change.
- Truncation homograph/extension-spoofing: NOT a new risk — `truncate` pre-exists on the
  filename `<p>`; long deceptive names could already clip under narrow viewports. Security
  boundary does not rest on the visual label — downloads use `att.id`
  (attachment-section.tsx:422), not the rendered string. No spoofing-to-action path.
- Escaping unchanged: `{att.filename}` is React JSX text interpolation (auto-escaped);
  change touches only a className string. No XSS surface change.
- No security-critical control in the entry dialog depends on `min-width:auto`; header
  wraps rather than clips.
- Filename is non-secret user-attached metadata; ellipsis crosses no confidentiality
  boundary. Blast radius correctly bounded to the entry-dialog shell (not global
  ui/dialog.tsx).

## Testing Findings

Testing strategy confirmed CORRECT. jsdom truly cannot validate this layout fix (no
layout engine — `scrollWidth`/`clientWidth` = 0). A class-presence assertion would be
decorative per common/testing.md. The canonical E2E `scrollWidth <= clientWidth` probe is
the right shape but NO entry-attachment E2E fixture exists (only CSV-import
`setInputFiles`); building one for client-side-encrypted blobs is disproportionate for a
one-class CSS fix. Existing unit suites are layout-blind but provide the narrow
markup-regression guard the plan claims (I3). No cheap fail-before/pass-after test exists →
not Critical.

**T1 — Minor**: Convert the Phase-2 E2E hedge into a recorded decision (Anti-Deferral):
"no entry-attachment E2E fixture exists; adding one is out of scope for this CSS-only fix;
verification is manual-visual per scenarios + build/lint."

**T2 — Minor**: Prose says "vitest/jsdom" but the global vitest env is `node`; the
component tests opt into jsdom via a per-file `// @vitest-environment jsdom` pragma.
Conclusion (no layout engine) unchanged — wording precision only.

Also (informational): manual verification MUST use a long UNBROKEN filename (200-char, no
whitespace) or the bug won't reproduce and the check false-passes.

## Adjacent Findings
- [Adjacent] Security (usability): a `title`/tooltip showing the full filename on
  hover/focus would help users read truncated names. Plan explicitly scopes it out. Not a
  security finding; noted for possible future UX enhancement.

## Quality Warnings
None.

## Recurring Issue Check

### Functionality expert
- R8 shared-component-consistency: PASS (single shared EntryDialogShell)
- Incomplete member-set coverage: PASS (8 team forms + personal all route through shell)
- Blast-radius / global-primitive regression: PASS (scoped to shell, not ui/dialog.tsx)
- Ancestor-chain completeness: PASS
- Effective-default / distributed-contract: N/A

### Security expert
- project_no_store_secret_response_class: clear (non-secret metadata)
- feedback_body_cast_not_schema_validation: N/A
- XSS / raw-HTML sink: clear (auto-escaped, no dangerouslySetInnerHTML)
- feedback_child_model_parent_fk_scoping: N/A (no data-access code)
- Spoofing-to-action via truncated display: clear (download uses att.id)
- feedback_close_defect_class_not_instances: clear (shell covers personal+team+all types)

### Testing expert
- Decorative test: OK (plan refuses class-presence test)
- Anti-Deferral / decision-not-recorded: flagged T1
- fail-before/pass-after rigor: OK
- Coverage-gap-with-cheap-test (Critical trigger): not Critical (no cheap test exists)
- Test env misstatement: T2 minor wording
