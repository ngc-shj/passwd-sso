# Code Review: extension-shortcut-defaults

Date: 2026-07-12
Review round: 1 (converged — all experts returned No findings)

## Scope

Standalone Phase 3 review (no Phase 1 plan — small user-approved change).
Diff source: uncommitted working tree (`git diff HEAD`), files:

- `extension/manifest.config.ts` — `_execute_action` suggested_key `Ctrl/Cmd+Shift+A` → `Ctrl/Cmd+Shift+X`; `copy-password` / `copy-username` suggested_key removed (commands remain, unbound by default); `trigger-autofill` (`Ctrl/Cmd+Shift+F`) and `lock-vault` (unbound) unchanged
- `docs/extension-store-listing.md` — shortcut list updated; Japanese short/detailed description added (added mid-round by user request; orchestrator-verified: ja shortcut list matches new manifest, vault → 保管庫, no internal jargon)
- `docs/architecture/feature-gap-analysis.md` — X-4 paragraph updated

Rationale: old defaults collided with Edge built-ins — A = tab search (Win/Mac), P = system print dialog (Win), U = Read Aloud (Win/Mac). Verified against Microsoft Edge keyboard shortcuts support page. New scheme follows 1Password precedent (activate = Shift+Cmd+X) and the "minimal defaults" pattern (1Password/KeePassXC ship most commands unbound).

Out of review scope: `.claude/settings.json` (session permission record, left uncommitted).

## Changes from Previous Round

Initial review.

## Functionality Findings

No findings.

Verification: feature-gap-analysis.md "5 Chrome `commands`" matches the 5 manifest entries; store listing matches manifest exactly; no stale old-shortcut references outside docs/archive; suggested_key count = 2 (within Chromium's 4-slot auto-assign cap); `chrome.commands.onCommand` listener (extension/src/background/index.ts:929) dispatches by command-name string independent of suggested_key — no orphaned handler; manually-bound commands still trigger.

## Security Findings

No findings.

Verification: diff touches only `commands.*.suggested_key`; permissions / optional_host_permissions / CSP / web_accessible_resources unchanged (grep-confirmed zero matches in diff). Vault-unlock gate for copy commands (index.ts:960-962) and clipboard auto-clear (index.ts:1020) untouched. R43 boundary-widening check negative — the change is a narrowing/no-op on the security surface. `edge://extensions/shortcuts` reference is docs prose, no injection surface.

## Testing Findings

No findings.

Seed disposition: Ollama seed [Major] "mock-reality misalignment in test suites" REJECTED with evidence — App.test.tsx stubs `chrome.commands.getAll()` with arbitrary display fixture data (options page renders runtime API values, never reads manifest.config.ts); background-commands.test.ts dispatches by CMD_* constants, not shortcut strings; no test imports manifest.config.ts; 899/899 pass with the new manifest.

Informational note (not a finding): no regression net catches a future colliding suggested_key or a 5th suggested_key. Literal-string pinning would be low-value; if ever wanted, prefer a structural invariant test (`count of commands with suggested_key ≤ 4`).

## Adjacent Findings

None.

## Quality Warnings

None.

## Recurring Issue Check

### Functionality expert
R1-R43: all N/A or OK. Notable OK: R23 (suggested_key 2/4 cap), R34 (CMD_* already const exports, pre-existing), R35/R37 (user-facing wording clean), R36 (no stale shortcut refs outside docs/archive), R39 (no orphaned handler), R42 (fixed enumerable set of 5 commands — no broader class).

### Security expert
R1-R43 + RS1-RS6: all N/A or OK. Notable OK: R3 (all 3 surfaces consistent), R18 (manifest allowlists unchanged, grep-confirmed), R30 (chrome:///edge:// prose only), R41 (onCommand handles all declared commands; manual rebinding path real), R43 (negative — narrowing), RS4 (no PII in new doc text).

### Testing expert
R1-R43 + RT1-RT9: all N/A or OK. Notable OK: R7 (no E2E references extension shortcuts), R19/RT1 (App.test.tsx fixture display-only, no mock-reality divergence), RT3 (fixture string arbitrary, not duplicated production constant), RT9 (dist/manifest.json generated from single source, post-build verified).

## Environment Verification Report

N/A — no environment constraints declared (no Phase 1). Verification executed:
- `verified-local` — `cd extension && npm run build` (pass; dist/manifest.json inspected: commands match intent)
- `verified-local` — `cd extension && npx vitest run` (899 pass / 0 fail)
- Root `npx next build` / root vitest intentionally skipped: diff contains no files that enter the Next.js build graph (extension/ + docs/*.md only).

## Resolution Status

No findings to resolve. Round 1 converged; loop terminated per Step 3-8 ("all agents return No findings").

Known limitation (disclosed to user, not a finding): Chromium assigns suggested_key at install time only — existing installs keep the old A/P/U bindings; release notes should mention the change.
