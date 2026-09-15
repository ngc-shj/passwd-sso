# Design note: the three findings that outlived the review rounds

Branch `fix/audit-tenant-adjudicator`. Written after round 3, because F6, F3 and
Q11 are not three findings — they are one fact seen from three sides, and none
of them is decidable by the reviewer who raised it.

## The fact

Two invariants are asserted by code and enforced by nothing:

- **(A)** `User.tenantId` names the tenant of the user's active membership.
- **(B)** A user has at most one active `TenantMember`.

(A) is what this branch's adjudicator works around: readers scope by the
membership, several writers read the column, and the branch made them agree.
That is a *symptom* fix — correct and worth having, because writer and reader
now cannot disagree however the two come apart, but it does not stop them
coming apart.

(B) is asserted by three readers with three different behaviours —
`resolveUserTenantIdFromClient` throws, `getTenantMembership` picks arbitrarily,
`resolveOwningTenantIdFromClient` takes the oldest — and enforced by four
application guards this branch added, one per writer.

## The producer of (A)'s violation

`src/auth.ts`'s tenant-claim handler, on its **no-membership** branch
(`existingTenantId === null`):

```ts
await tx.tenantMember.upsert({
  where: { tenantId_userId: { tenantId: target.id, userId } },
  create: { tenantId: target.id, userId, role: TENANT_ROLE.MEMBER },
  update: {},
});
return { ok: true };
```

Its sibling MIGRATION branch moves everything — `user.update`, `account`,
`passwordEntry`, `tag`, `folder`, `session` — into the target tenant. The
no-membership branch moves nothing.

So: a user released by tenant B (SCIM deactivate or delete leaves the column and
the data untouched), signing in through tenant A's IdP, ends with the column and
all their vault data on B and their only active membership on A.

Verified by reading both branches. `auth.ts`'s own comment at the claim handler's
catch already distinguishes "the `tenantMember.upsert` on the no-membership path"
from "the `user.update` on the migration path" — the distinction was written
down before this review found it mattered.

## Why F6 is the consequence, not a separate finding

`users_tenant_isolation` is `bypass_rls='on' OR tenant_id = app.tenant_id`. For a
divergent user, a read inside their membership tenant cannot see their own
`users` row. Thirteen routes read it under `withUserTenantRls` and take their
not-found arm: vault unlock reports the vault as not set up, vault setup returns
`unauthorized()`, bridge-code returns `unauthorized()`, and so on.

Round 2 recorded F6 as conditional on a producer existing. Round 3 found the
producer. The condition is met.

Note what the adjudicator work does and does not do for this. It fixes the half
where the *column* is stale: once the column follows the membership, the `users`
row is visible again. It does nothing for the user's `passwordEntry` / `tag` /
`folder` rows, which stay in the tenant they were written in.

## The decision this needs, which is not the reviewer's

When a user with no active membership signs in through a new tenant's IdP, and
their column and data still name the tenant that released them:

1. **Migrate** — do what the migration branch does: move the user row, the
   account rows and every tenant-scoped table into the claimed tenant. Their
   vault follows them. The releasing tenant loses the data. This is the option
   that makes (A) hold and leaves the user working.
2. **Refuse** — reject the sign-in and require an operator to resolve it. (A)
   holds because the state is never created. A user released by one tenant and
   invited by another cannot sign in until someone acts.
3. **Move the column only** — the adjudicators agree and the `users` row becomes
   visible, but the vault data stays in the old tenant and is unreachable. This
   is the smallest change and the one the branch's own logic points at; it is
   also the one that leaves a user signed in to an empty vault.

Option 1 moves customer data across a tenant boundary as a side effect of a
sign-in. Option 2 turns a supported flow into an operator ticket. Option 3 is
silent data loss from the user's point of view. None of them is a defect fix;
each is a product statement about what "joining a new tenant" means.

### DECIDED: option 3, made loud

Taken 2026-09-11, after checking each option against the code rather than
against this note. Two of the three descriptions above were wrong:

**Option 1 cannot reuse the migration branch.** Three of its movers —
`passwordEntryHistory`, `emergencyAccessKeyPair`, `shareAccessLog` — filter by
`tenantId` alone, and that is sound only because `assertBootstrapSingleMember`
runs first and a bootstrap tenant has one member. The tenant releasing a user
here is a real SSO tenant. With two or more active members the assert throws and
the sign-in dies; with exactly one (somebody else), it PASSES and that person's
history, emergency key pair and share-access logs move into the joining tenant.
Option 1 therefore means a new user-scoped mover — `passwordEntryHistory` via
`entryId -> PasswordEntry.userId`, `shareAccessLog` via `shareId ->
PasswordShare.createdById` — and `emergencyAccessKeyPair` has no user column at
all, so it cannot move with a user under any scoping.

**Option 3 does not lock the user out, and destroys nothing.** The key material
(`accountSalt`, `encryptedSecretKey`, the KDF parameters, `vaultSetupAt`) is all
on the `users` row, which the column move brings into the joined tenant. So
`/api/vault/status` reports the vault as set up, unlock succeeds — `VaultKey`
carries only the verification artifact, and the unlock route already tolerates
its absence — and what the user sees is an EMPTY vault rather than a broken one.
Nothing prompts a re-setup, so the `@@unique([userId, version])` collision that
would follow one never arises. The entries are intact with the wrong
`tenantId`, which is reversible at any later date.

**Option 2 has no tooling.** `scripts/` has `tenant-domain` (the claim registry)
and nothing that moves a user between tenants, so "operator resolution" means
hand-written SQL today.

So: the column follows the membership, the rows stay, and the state is
REPORTED — `USER_TENANT_REALIGNED`, filed under the tenant the user has joined,
carrying how many entries, tags and folders were left behind. That is what keeps
option 3 from being the silent loss this note calls it: an operator who can see
the number can act on it, and the data is still there to act on.

`realignOwningTenantColumn` lives in `tenant-context.ts` beside the adjudicator,
because reading the raw column is precisely what
`check-owning-tenant-adjudicator` refuses everywhere else — correctly, since
everywhere else the question is "which tenant owns this user" and only here it is
"what does the denormalized copy currently say".

F6 is closed by this: the divergent user's `users` row is visible to their own
requests again. F3 (backfill) still needs the production measurements below —
what it repairs is now bounded to rows written BEFORE this change.

## Measurements, so the decision rests on numbers

Run on the development database, 2026-09-09 — all three are **0**:

```sql
-- (1) divergent: column != the single active membership
SELECT count(*) FROM users u
JOIN LATERAL (
  SELECT tm.tenant_id, count(*) OVER () AS n
  FROM tenant_members tm
  WHERE tm.user_id = u.id AND tm.deactivated_at IS NULL
  ORDER BY tm.created_at ASC LIMIT 1
) m ON true
WHERE m.n = 1 AND m.tenant_id <> u.tenant_id;

-- (2) more than one active membership — blocks the partial unique index below
SELECT count(*) FROM (
  SELECT user_id FROM tenant_members WHERE deactivated_at IS NULL
  GROUP BY user_id HAVING count(*) > 1
) t;

-- (3) zero active memberships — the producer's precondition
SELECT count(*) FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM tenant_members tm
  WHERE tm.user_id = u.id AND tm.deactivated_at IS NULL
);
```

**Dev being 0 is not evidence that production is.** (3) being 0 on dev means the
producer's precondition has never held here, which is why nothing has diverged —
not that it cannot. These must be run against production before either the
backfill (F3) or the index (Q11) is scheduled.

## Q11 — the one piece that is decidable now

Invariant (B) can be enforced where no RLS context, writer or interleaving can
evade it:

```sql
CREATE UNIQUE INDEX CONCURRENTLY tenant_members_one_active_per_user
  ON tenant_members (user_id) WHERE deactivated_at IS NULL;
```

This is independent of the (A) decision above, and it closes more than it looks:

- the four application guards this branch added become a nicety rather than the
  enforcement — they still give a clean 409 instead of a constraint error, but
  they are no longer the only thing standing between the system and the state;
- the SCIM guard's TOCTOU window closes, because unique-index enforcement sits
  below RLS and does not care that the guard ran in a different context;
- `resolveUserTenantIdFromClient`'s `MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED`
  throw — which the proxy auth gate reaches on every request — becomes
  unreachable rather than merely unlikely, which removes the cross-tenant
  session-invalidation vector round 2 filed as S6/F2.

Costs, stated rather than elided:

- **It fails loudly on existing duplicates.** Query (2) must be 0 in production
  first. That is the right failure mode, but it is a blocked deploy if unmet.
- **Every writer must map SQLSTATE 23505 on this index to its current 409.**
  `pgErrorCode` is already the single SQLSTATE parser in this tree, so there is
  one place to teach it.
- **It forecloses multi-tenant membership permanently.** `CLAUDE.md` describes
  "one active tenant per user (`User.tenantId`), multi-tenant access via
  `TenantMember`" — the second half reads like an intent this index would
  contradict. Nothing in the code implements it today (all three adjudicators
  refuse or arbitrarily pick), but the index converts a behavioural assumption
  into a schema commitment, and that is worth stating before it ships.

## What is NOT deferred

The symptom fix is complete and enforced: thirteen sites route through one
adjudicator, a mutation-verified gate keeps a fourteenth from joining silently,
and the four reactivation writers are guarded. Nothing above is required for that
work to be correct — it is required for the class to stop being reachable.
