# Sentinel tenant membership

The `__system__` tenant (`00000000-0000-4000-8000-000000000002`) is the encoding
of "no owning tenant" for audit rows that cannot be attributed — a first-ever
sign-in denial, a claim refusal, a pre-auth emission. See the
[`audit-dead-letter`](./alerts.md#audit-dead-letter) section for how to read
those rows.

**It must have zero members.** That is not a convention; it is what keeps every
unattributable audit row in the deployment out of every tenant's view. All three
tenant resolvers key on `tenant_members`, and the RLS policies on `audit_logs`
and `audit_outbox` gate on `app.tenant_id`, which is only ever set from those
resolvers. A single membership row is a read grant over the lot.

Since `20260901090000_forbid_system_tenant_membership`, the database enforces
this with a CHECK constraint (`tenant_members_not_system_tenant`). This page is
for the one case that constraint cannot fix by itself: a deployment where a
membership row already existed when the migration ran.

## The migration failed to apply

`prisma migrate` reports a check-constraint violation on `tenant_members`. The
constraint is validated against existing rows at `ALTER TABLE`, so this means the
row this control exists to prevent is already there.

**Do not** add `NOT VALID` to make the migration apply. That grandfathers the row
and leaves the deployment in exactly the state the constraint was written to
detect, with the migration reporting success.

Work the steps below in order.

### 1. Capture

Both queries, before anything else. The second is the one people skip, and it is
the one that explains the first: a **claim** exists before any member does. An
operator who registers a domain against the sentinel creates the claim; the
member row appears only at the next SSO sign-in from that domain. A deployment
that reads zero members but holds a claim is not clean — it is early.

```sql
SELECT id, user_id, role, created_at
FROM tenant_members
WHERE tenant_id = '00000000-0000-4000-8000-000000000002';

SELECT claim, created_by, created_at
FROM tenant_claims
WHERE tenant_id = '00000000-0000-4000-8000-000000000002'
  AND revoked_at IS NULL;
```

If either query **errors** rather than returning zero rows, the answer is
*unknown*, not *zero*. Fix the connection and re-run before continuing.

### 2. Interpret — the severity depends on `role`

| `role` | What the holder can read | Notes |
|---|---|---|
| `OWNER` / `ADMIN` | Every unattributable audit row in the deployment, through `/api/tenant/audit-logs` | `AUDIT_LOG_VIEW` is granted to these roles |
| `MEMBER` | RLS scope on the sentinel tenant, and their sign-ins are misrouted into it | `AUDIT_LOG_VIEW` is not granted to `MEMBER` |

A claim-driven membership is created as `MEMBER`, and nothing can promote it:
promotion requires an existing admin **of that tenant**, and the sentinel has
none. So an `OWNER`/`ADMIN` row did not arrive through the claim path and wants a
separate explanation.

### 3. Contain

```sql
UPDATE tenant_members
SET deactivated_at = now()
WHERE id = '<the id from step 1>';
```

Both membership resolvers filter on `deactivated_at IS NULL`, so this removes the
read path immediately. It destroys no evidence: the row, its `role` and its
`created_at` all survive for the investigation.

Confirm both halves — the access is gone **and** the record is still there:

```sql
SELECT count(*) FROM tenant_members
WHERE id = '<the id>' AND deactivated_at IS NULL;   -- expect 0

SELECT count(*) FROM tenant_members WHERE id = '<the id>';  -- expect 1
```

### 4. Containment does not unblock the rollout

The CHECK adjudicates `tenant_id` and does not look at `deactivated_at`, so the
migration still fails after step 3. That is deliberate. Containment buys time for
the escalation; it is not the resolution, and treating it as one leaves a
deployment that believes it has applied a constraint it has not.

### 5. Escalate, then revoke the claim

**No `DELETE` without sign-off.** The row is the evidence of how this happened.

Revoke the claim through the CLI rather than by hand, so the action is recorded:

```bash
MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- remove \
  --tenant 00000000-0000-4000-8000-000000000002 \
  --domain <claim from step 1> \
  --by <your label>
```

`remove` is a **soft** revoke that appends a `tenant_claim_event`, and it is left
working against the sentinel on purpose — `add` is refused, `remove` is not,
because this is the path that undoes the mistake. `list` and `history` also work
against the sentinel, for the same reason.

Once the claim is revoked and the membership row is dispositioned with sign-off,
re-run the migration.

## Preventing it

`tenant-domain add --tenant <sentinel>` now refuses, keyed on the resolved tenant
id rather than the spelling — the sentinel's slug and `externalId` reach the same
tenant, and a check on the ref string would pass for two of the three ways to
name it.

The UUID in this page, in `src/lib/constants/app.ts`, and in the two migrations
that spell it are tied together by
`scripts/checks/check-sentinel-tenant-literal-parity.mjs`, which runs in
`scripts/pre-pr.sh`. If they ever diverge, the queries above would count rows for
a tenant nothing writes to and report a reassuring zero.
