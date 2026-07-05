# Code Review: bypass-rls-tx-callback-form

Date: 2026-07-05
Review rounds: 3 (Round 1 findings → fixed; Round 2 found a 6th TOCTOU site + 4 more →
fixed; Round 3 found the final 7 → fixed + mechanized with a CI guard → CONVERGED)

## Summary

What began as "fix 2 non-fatal pre-pr WARNs" surfaced (via the user's instinct + adversarial
review) a **confirmed pre-existing TOCTOU race class of 17 count-then-create cap sites**, plus
a 41-callback RLS-form hardening. The primary security fix: per-user/tenant/team/entry
`pg_advisory_xact_lock` serializing every `count/aggregate → check cap → create` sequence.

## The TOCTOU class (17 sites, member-set derived from the primitive)

Root cause: `withRls(prisma, ... count()) ; if (n >= MAX) reject ; withRls(prisma, ... create())`
in separate txs (or one tx without a lock) → two concurrent requests both read `n < MAX`, both
create, exceeding the cap. The seed instance (`auth-adapter` session limit) even *tried*
Serializable but the Prisma-proxy `$transaction` fold silently dropped the isolationLevel
(proven: ran at read committed).

The member-set expanded across rounds because early enumeration anchored on a *symptom*
(`isolationLevel` grep) rather than the *primitive* (`count()+create()+cap`). Rounds:
1→5 (Round-1 S2), →6 (Round-2 api-keys), →10 (Round-2 four per-tenant), →17 (Round-3 exhaustive
sweep: webhooks ×2, audit-delivery-targets, attachments ×2, reset-vault, mcp-register).

**All 17 now serialize with an advisory lock.** Fix is the codebase's own idiom (7 prior
precedents like attachments/vault-rotate-key); NOT Serializable (which needs 40001-retry the
codebase lacks → would turn a silent over-count into a login 500 — Round-1 S1).

## Mechanized completeness (the durable fix)

`scripts/checks/check-count-then-create-lock.mjs` — a static guard flagging any RLS-wrapped
`count/aggregate → cap-check → create` file lacking `pg_advisory_xact_lock`, with a reviewed
soft-cap allowlist (resource-quotas.ts) + stale-exemption anti-drift. Mutation-verified +
self-tested (4 cases). Wired into pre-pr.sh / the static-checks CI job. This prevents the
member-set from silently regrowing.

## Callback-form hardening (41 sites, behavior-preserving)

`check-bypass-rls.mjs` mandates `(tx) => tx.x` (robust under DI/raw-client); eslint flagged the
unused `tx`. Buckets: B_RAW_SQL (9, prisma.$→tx.$), C_HELPER_DB (4, db:prisma→db:tx),
A_NESTED_TX (13, drop redundant inner $transaction), F_DELEGATE (15: F1 drop static SCIM
wrappers, F2 thread tx through helpers, F3 documented eslint-disable for the unthreadable
public fn(tenantId) contract). tx-unused: 41 → 0. All whitespace-verified behavior-preserving.

## Verification
- Full suite: 933 files, 11,988 tests pass.
- pre-pr.sh: 43/43 (the new guard is +1).
- Real-DB integration test proves the race is real WITHOUT the lock (count > cap) and closed
  WITH it (count == cap), for bridge-code + api-keys — mutation-killing, DATABASE_URL-gated.
- Per-site mutation-kill unit assertions (expectAdvisoryLockAcquired) at every lock site.
- Empirically confirmed: `pg_advisory_xact_lock` serializes concurrent same-key txns (412ms
  serialized vs 156ms concurrent); the Prisma proxy drops nested $transaction isolationLevel.

## Recurring Issue Check
- **R42 (member-set completeness)**: THE central lesson — the class was re-derived from the
  primitive each round; a CI guard now mechanizes it (per feedback_triangulate_enumerate_completeness).
- **RS2 (fail-open)**: advisory lock blocks-then-proceeds (no 40001/500), the correct posture
  vs. Serializable-without-retry.
- **RS3 (dataflow/TOCTOU)**: all 17 count→create races closed in one locked tx each.
- **RT (mutation-resistance)**: integration test + per-site unit assertions both mutation-kill;
  the guard itself is mutation-verified and self-tested.
- **Process note**: two sub-agent rounds left `/* lock removed */` placeholders (from mutation-
  testing the T2 assertions) — caught by the orchestrator's post-delegation lock cross-check.
  Always grep for placeholders + `pg_advisory_xact_lock` count after delegating lock edits.

## Resolution Status
All Round-1/2/3 findings resolved. Class complete (17/17 locked), mechanized (guard), and
regression-proofed (integration + unit + guard self-test). CONVERGED.
