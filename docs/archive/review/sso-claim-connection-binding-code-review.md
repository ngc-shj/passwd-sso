# Code Review: sso-claim-connection-binding
Date: 2026-10-25
Review round: 1

## Changes from Previous Round
Initial review. Local LLM seeds were unavailable (the server returned HTTP 400 on the full
diff), so all three experts reviewed the full diff.

## Functionality Findings
- F1 Major — `cmdRemove`'s revoke CAS omitted `provider` while its event recorded the
  pre-prompt provider; a `bind` committed during the confirmation prompt left a stale provider
  in the append-only history.
- F2 Major — a deployment that ran the legacy provider with Jackson's `dummy` or an encoded
  client id, `AUTH_REDIRECT_PROXY_URL`, and two or more connections has every SAML account at
  `saml-jackson`; after the upgrade only one connection keeps that id and the others' users are
  locked out, with no in-app recovery (a raw `UPDATE` breaks the token AAD).
- F3 Minor — a CRLF or BOM bind file was refused with a misleading control-character error.
- F4 Minor — the new binding flags were silently ignored outside `bind`.
- A1 [Adjacent] Minor — `--out`'s worktree check is decided on a path that `openSync` resolves
  again (R51).

## Security Findings
- S1 Critical (escalate: true) — Auth.js calls `signIn` before its account-link check, and the
  callback chose the user by the IdP-asserted email. An IdP admin behind one connection, asserting
  a victim's email together with their own bound claim, had the victim's membership and data moved
  into their tenant; Auth.js refused the session only after those writes had committed. The
  connection binding attests the connection, not the user, so it did not close this.
- S2 [Adjacent] Minor — a stored NULL claim beginning with `#` was written as a data line that the
  bind-file parser skips as a comment.
- R51 (`--out`) and R49 (`emitAuthLoginFailure`'s optional binding) re-examined, not raised.

## Testing Findings
- T1 Major — the Jackson image drift test did not run on PRs changing only its inputs (tfvars
  re-tags, the probe matrix).
- T2 Major — the existing CLI integration suite passed only when the developer's `.env`
  configured no claim provider; the provider-env key list was hand-written three times.
- T3 Minor — existing-user allow assertions held before the sign-in ran; no real-DB
  existing-user × unregistered-claim cell.
- T4 Minor — D7's B2 red proofs had no unmutated baseline and no test names.
- T5 Minor — `jackson-probe` had no timeout and no record of registering it as a required check.
- T6 Minor — one unknown-ref unit test could pass without a real ref.
- T7 Minor — grid strict cells presented a provider the env did not configure.

## Adjacent Findings
- A1 (functionality, R51 `--out`): the security expert re-examined the same point independently
  and did not raise it.
- S2 (security → functionality): fixed with the bind-file findings.

## Quality Warnings
None. Every finding carried file, line and evidence.

## Recurring Issue Check
### Functionality expert
R2 clean; R3 F1; R6 N/A; R17 clean; R34 F1; R41 F2; R48 clean; R51 F1, A1; R57 clean.
R1, R5, R7, R9, R12, R14, R15, R16, R18, R19, R24, R25, R29, R31, R33, R35, R36, R37, R42, R55
clean per the Phase 2 self-check, not re-run.

### Security expert
R1/R2/R17 clean; R3 S1; R5/R9 clean; R14 clean; R24 clean; R25 clean; R29 clean; R31 clean;
R42 claim-path member set complete, the user-identity path was the omitted member (S1);
R43/R52 S1; R47/R48 clean; R49 S1 (README strict-mode guarantee); R51 noted; R55/R57 clean.
RS1 clean; RS2 N/A; RS3 clean; RS4 clean; RS5 N/A; RS6 clean.

### Testing expert
R1/RT3 T2; R16 T2; R29 T4; R33 T1; R42 pass; R50 partial (T5); R3, R12, R14, R18, R19, R24,
R35, R36, R48, R55 clean per the self-check.
RT1 pass; RT2 pass; RT3 T2; RT4 pass; RT5 pass; RT6 pass; RT7 mostly pass (T4); RT8 pass;
RT9 pass; RT10 pass; RT11 partially mitigated.

## Environment Verification Report
N/A — no environment constraints declared in Phase 1. The browser sign-in through two live
connections is covered by `sso-claim-connection-binding-manual-test.md`, not yet executed.

## Resolution Status
### S1 Critical — sign-in subject chosen by the asserted email before Auth.js's link check
- Action: an OAuth/OIDC sign-in resolves its subject through the adapter's `getUserByAccount`
  first. It follows an email match only where `allowsDangerousEmailAccountLinking` holds (Google
  with a domain restriction; the same predicate builds the Google provider). Otherwise it refuses
  with `account_not_linked` before any write. Real-DB deny and allow cells; red proofs S1a–S1d in
  D7.
- Modified file: `src/auth.ts` (`resolveOAuthSignInSubject`, the `signIn` callback),
  `src/auth.config.ts` (`allowsDangerousEmailAccountLinking`), `src/lib/audit/auth-failure.ts`.

### F1 Major — `remove` CAS without provider
- Action: the revoke CAS includes `provider: existing.provider`; a concurrent rebind is refused
  and writes no event.
- Modified file: `scripts/tenant-domain.ts` (`cmdRemove`).

### F2 Major — multi-connection legacy upgrade lockout
- Action: the user chose to document this as a breaking consequence in this PR and to file the
  account re-key command as a follow-up issue. The README upgrade section (en/ja) opens with
  the known lockout: who is affected, what happens, why a raw `UPDATE` is not a recovery, to
  leave those `bind --from-members` lines empty, and the two options (stay on the previous
  version, or re-provision). Plan C6 records it, and D9 records the decision.
- Modified file: `README.md`, `README.ja.md`, the plan's C6.

### T1 Major — drift test not run on input-only PRs
- Action: `jackson-probe` runs the drift test after `npm ci`, and the `app` filter gains
  `ci-integration.yml` and `infra/terraform/**/terraform.tfvars.example`.
- Modified file: `.github/workflows/ci-integration.yml`, `.github/workflows/ci.yml`.

### T2 Major — CLI suite depended on the developer's provider env
- Action: one shared `stubClaimProviderEnv` (its key list is compile-time complete against
  `jackson-providers.ts`) asserts the derived mode; all three suites use it. Red-proved by
  running the pre-fix suite under an exported Google + Jackson + strict env (30/102 red).
- Modified file: `src/__tests__/helpers/tenant-claim-fixtures.ts` and the three suites.

### Minor findings
- F3: a CRLF or BOM bind file is refused up front with a message naming it.
- F4: per-subcommand accepted-flag sets; `--accept-unused-provider` with `--unbound` refused.
- S2: a claim starting with `#` is listed under a "Not written" note instead of a data line.
- T3: delta assertions and existing-user × unregistered-claim cells.
- T4: B2 re-run with baselines and test names. M7 (`PROVIDER_REF_INFO` changed) had survived;
  a recorded vector now catches it.
- T5: `timeout-minutes: 15`; the manual-test file gains the required-check registration step.
- T6: the test asserts the mapping kind and the ref shape first.
- T7: strict uses connections alpha and bravo, off uses alpha alone.

### A1 [Adjacent] Minor — `--out` path re-resolved by `openSync` — Skipped
- **Anti-Deferral check**: acceptable risk.
- **Justification**:
  - Worst case: a local principal who can write to a directory the operator named swaps the
    parent between the check and the open, so the bind file lands inside the git worktree.
  - Likelihood: low. It needs write access on the operator's own host, to a path the operator
    chose. `O_EXCL` already refuses an existing file or symlink at the final component.
  - Cost to fix: an `openat`-style descriptor walk, which Node does not expose.
  - The check exists to keep the file out of git, not to defend against a local adversary. The
    security expert re-examined it independently and did not raise it.
- **Orchestrator sign-off**: the worktree refusal is a guard against operator error, and both
  experts agree the residual race needs local write access.

### Discovered during the fixes — bootstrap migration (rows 6 / 9a) fails on a real DB
The migration creates the target's active membership while the bootstrap one is still active,
which `tenant_members_one_active_per_user` refuses. This is pre-existing on `main` and is
recorded in D8.
- Action: the migration deletes the bootstrap membership, then `create`s the target one in the
  same transaction. A membership row the user already holds in the target can only be a
  deactivated one. The migration is refused before any write with `tenant_mismatch`, filed
  under the target tenant, so the user keeps the bootstrap tenant. This mirrors the established
  policy that a sign-in never reactivates a membership (row 4's `update: {}`, `tenant-domain
  realign`'s `REALIGN_WARNING`, and R6-S2 and F-R7-2 in
  `audit-tenant-adjudicator-code-review.md`). Real-DB cells cover rows 9a, 6 and 6b and the
  deactivated row. Red proofs R2-M1 to R2-M2c are in D7.
- Modified file: `src/auth.ts` (`claimedTenantMembership`).
