# Coding Deviation Log: security-review-followups

Recorded manually by the orchestrator (deviations enumerated at each per-contract commit; Ollama delta generation skipped in favor of direct recording — the deviation set was small and fully known).

## D1 — C4 AC2: leading-`\n` round-trip case uses `splitCsvRows`, not the `it.each` scaffold
- Plan said: extend the round-trip scaffold at `password-import-parsers.test.ts:204` with both the leading-space and leading-newline cases.
- Actual: `"  =2+5"` was added to the existing `it.each` array; `"\n=cmd"` got a dedicated `it()` using `splitCsvRows` (the file's own RFC-4180-aware row splitter) because the scaffold locates its data row via a naive `csv.split("\n")[1]`, which breaks a quoted cell containing a literal embedded newline (verified via a standalone node repro). Same real producer (`formatExportCsv`) and consumer (`parseCsvLine`); AC2's intent (actual output through actual parser, byte equality) fully satisfied.
- Contract: C4. Disposition: accepted — mechanically necessary; arguably more correct.

## D2 — C3 detector: two false positives suppressed inline (plan-anticipated disposition)
- Plan AC1 said: any detector hit on the current tree is either a real gap (fix) or a false positive (refine detector or suppress with reason; record per case).
- Case 1: `src/components/settings/security/tenant-reset-history-dialog.tsx` — the `/approve` call builds its path on the same `apiPath.tenantMemberResetVault` base helper as `reset-vault-post`'s bare call, but it IS the (already-marked) `reset-vault-approve` route, not the initiate POST. Suppressed `@stepup-path-ok id:reset-vault-post` with that reason.
- Case 2: `src/hooks/team/use-team-entry-mutations.ts` — soft-delete (trash) DELETE without `?permanent=true`; not the step-up-gated permanent-delete call site (which lives in `team-vault-list-adapter.ts` and is marked). Suppressed `@stepup-path-ok id:team-password-id-delete-permanent` with that reason.
- Contract: C3. Disposition: accepted — detector kept strict; both suppressions carry ≥10-char reasons enforced by the guard.

## D3 — C1: no env-var fallback seam needed
- Plan allowed an env-var override if the 5,000-request fill loop exceeded ~5 s. Measured: full test file runs in ~0.4 s. No seam added; `MAX_CACHE_ENTRIES` stays module-private.
- Contract: C1. Disposition: plan's primary path taken; fallback unused.

## D4 — C7: no deployment.md cross-reference added
- Plan made the `docs/operations/deployment.md` cross-ref conditional on that doc discussing network restriction. Grep shows it does not (zero Tailscale/CIDR/access-restriction mentions), so only `docs/security/policy-enforcement.md` was extended.
- Contract: C7. Disposition: conditional branch resolved to "not applicable", per plan.

## D5 — C5: audit-chain-verify-worker runs as `passwd_app` (fact, recorded in manifest)
- During manifest authoring, the worker's own header comment + absence of any `set-*-password.sh`/dedicated compose env confirmed it connects with the standard app role, unlike the other three workers' least-privilege roles. Recorded as `dbRole: "passwd_app"` in the manifest — this is discovered governance data, not a code change; a least-privilege role for it is potential future work (not in this PR's scope; the manifest now makes the asymmetry visible, which is C5's purpose).
- Contract: C5. Disposition: no deviation from contract; noteworthy finding surfaced by the manifest work.

## Process note — mutation-proof mishap (orchestrator, C1)
- The C1 AC2 revert-mutation proof used `git checkout --` to restore, which also reverted the then-uncommitted FIFO fix; the fix was immediately re-applied and re-verified green before commit. No residue (verified by diff grep). Lesson: commit first or restore from a scratch copy.

## Process note 2 — piped exit codes masked a real guard failure (orchestrator)
- Both the initial guard run and the first `pre-pr.sh` run were piped to `head`/`tail`, so the reported exit code was the pipe tail's `0`, not the check's. The step-up guard was actually failing `BROWSER_REDIRECT_RECOVERY_MISSING` on `mcp/authorize/route.ts` (marker 7 lines from the redirect, outside the ±5 anchor window) — the exact condition the C2 proximity check exists to catch, proving it fires on real code, not only fixtures. Fixed by moving the marker into the conversion block (`84e57d24`); guard and pre-pr re-run WITHOUT pipes. Lesson: never read a gate's result through a pipe; capture the command's own exit code.
