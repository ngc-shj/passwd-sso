import { Prisma } from "@prisma/client";
import { prisma, type TxOrPrisma } from "@/lib/prisma";
import { slugifyTenant } from "@/lib/tenant/tenant-claim";
import { randomBytes } from "node:crypto";
import { SLUG_MAX_LENGTH } from "@/lib/validations/common";
import { advisoryXactLock } from "@/lib/tenant-rls";
import { normalizeTenantClaim, storableClaimSchema } from "@/lib/tenant/tenant-claim-registry";

/**
 * The single `tenantClaim.findUnique` call site in the codebase — every
 * other reader goes through `resolveTenantByClaim` /
 * `findOrCreateTenantForClaim`. A bare `tenantClaim.findUnique` anywhere
 * else in the repo is a forbidden pattern (plan D2).
 *
 * Looks up by the already-normalised claim and includes revoked rows —
 * callers decide what a revoked row means (D2): the resolver denies it, the
 * creator refuses to shadow it.
 */
async function findClaimRow(
  db: TxOrPrisma,
  claim: string,
): Promise<{ tenantId: string; revokedAt: Date | null } | null> {
  return db.tenantClaim.findUnique({
    where: { claim },
    select: { tenantId: true, revokedAt: true },
  });
}

/**
 * Is the free `UNIQUE(claim)` slot for `claim` already spoken for by an
 * existing tenant's `external_id`, under the SAME fold the registry uses
 * (`lower(btrim(x) COLLATE "C")`, matching the C1 CHECK, the backfill and
 * `tenant-domain preflight`)?
 *
 * Reached only after the exact-match `externalId` fallback has already
 * missed, so a hit here means the raw spellings differ but the folded forms
 * collide — the round-2 F-A shape.
 *
 * Bound parameter, no interpolation: the claim is IdP-supplied. The `COLLATE
 * "C"` and the column name are the only literal SQL.
 */
async function findFoldedExternalIdOwner(
  db: TxOrPrisma,
  claim: string,
): Promise<string | null> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id
      FROM tenants
     WHERE external_id IS NOT NULL
       AND lower(btrim(external_id) COLLATE "C") = ${claim}
     LIMIT 1`;
  return rows[0]?.id ?? null;
}

/**
 * Resolve a raw IdP-supplied claim to its tenant.
 *
 * Release-1 semantics (D1 — expand-and-contract): when no `tenant_claims`
 * row matches, falls back to `Tenant.externalId` (exact match on the RAW,
 * un-normalised claim — today's exact behaviour). `scripts/deploy.sh` is
 * migration-first, so old code — still writing only `externalId`, no claim
 * row — is live during the roll; without this fallback a claim first
 * presented during that window would deny `tenant_claim_unmapped`
 * permanently. SC10 (release 2) removes this fallback once no live code
 * reads or writes `externalId`.
 *
 * A revoked claim row (D2) returns `null` with NO fallback: the row still
 * occupies its slot in `UNIQUE(claim)` and needs an operator decision, not a
 * silent resurrection through `externalId`.
 *
 * Never writes (I5). Returns `null` rather than throwing when the claim
 * fails `storableClaimSchema` — an IdP may send anything. Ordering
 * consequence: because the fallback is reached on the "no row" path, a claim
 * that fails `storableClaimSchema` (e.g. non-ASCII) still resolves through
 * `externalId` in release 1, exactly as it does today. That is deliberate
 * (keeps NF2 true for this release) — SC10/release 2 removes it.
 *
 * Caller must already be inside a `withBypassRls` context, same contract as
 * the function this replaces.
 */
export async function resolveTenantByClaim(
  tenantClaim: string,
  db: TxOrPrisma = prisma,
): Promise<{ id: string } | null> {
  const claim = normalizeTenantClaim(tenantClaim);
  const row = await findClaimRow(db, claim);
  if (row) {
    return row.revokedAt === null ? { id: row.tenantId } : null;
  }

  return db.tenant.findUnique({
    where: { externalId: tenantClaim },
    select: { id: true },
  });
}

/**
 * Outcome of `findOrCreateTenantForClaim`.
 *
 * Deliberately NOT `{ id } | null` (round-1 M1/M2): the two refusals below
 * are operator-actionable in different ways, and a bare `null` let one caller
 * (`auth-adapter.createUser`) read them as "no claim was presented" and grant
 * a fresh bootstrap tenant with OWNER — so a deliberately revoked claim
 * bought a silent first sign-in. Each refusal is now its own arm and every
 * caller has to name which one it is handling.
 *
 * Every arm carries a `tenantId`, including the one where it is `null`. That
 * is not decoration: on a first-ever sign-in there is no user row, so
 * `emitAuthLoginFailure` runs with `userId = SYSTEM_ACTOR_ID`, and
 * `logAuditAsync`'s `resolveTenantId` (src/lib/audit/audit.ts:167) can only
 * find a tenant through `params.tenantId`, the team, or a `users` row — the
 * sentinel matches none, so the denial DEAD-LETTERS: no `audit_logs` row, no
 * `audit_outbox` row, and `tenant-domain unmapped` (which groups by
 * `tenant_id` on both tables) shows nothing. Both refusals that HAVE an owning
 * tenant already know it at the point they are constructed, so they carry it
 * out rather than making the caller re-query. `claim_invalid` is `null`
 * because no tenant owns an unregistrable claim — spelled explicitly so a
 * future arm has to state which case it is rather than inheriting an
 * `undefined`.
 */
export type ClaimTenantResolution =
  | { kind: "tenant"; id: string }
  // A revoked `tenant_claims` row owns the claim (D2). The slot in
  // UNIQUE(claim) is taken and needs an operator decision, not a silent
  // resurrection — callers report this as `tenant_claim_unmapped`, the reason
  // `tenant-domain unmapped` filters on.
  | { kind: "claim_taken"; tenantId: string }
  // No `tenant_claims` row owns the claim, but an existing tenant's
  // `external_id` FOLDS onto it (round-2 F-A). Distinct from `claim_taken`:
  // there is no row for `tenant-domain list` to show and nothing to
  // un-revoke, so the operator's diagnosis starts at `tenant-domain
  // preflight` (which reports exactly this population) and ends at an
  // explicit `add` naming the tenant that should own the claim. Kept a
  // separate arm rather than folded into `claim_taken` for the same reason
  // round-1 M1/M2 split that one out of a bare `null`: a third trigger
  // wearing a second trigger's name is how the wrong remedy gets applied,
  // and a test asserting the shared arm could not tell which branch fired.
  | { kind: "claim_collision"; tenantId: string }
  // The normalised claim fails `storableClaimSchema` (SC9's ASCII narrowing).
  // Nothing is registrable, so registering a claim is not the remedy — and no
  // tenant owns it, so this is the one arm that cannot carry a tenantId.
  | { kind: "claim_invalid"; tenantId: null };

/**
 * Find or create a tenant for an IdP-supplied claim, registering the claim
 * atomically with the tenant it creates. Replaces `findOrCreateSsoTenant`.
 *
 * `db` is REQUIRED, deliberately with no `= prisma` default: calling this on
 * the global proxy outside a transaction would run `advisoryXactLock`'s
 * `pg_advisory_xact_lock` in autocommit mode, where it releases immediately
 * after the statement — a silently disarmed lock. Both real call sites
 * already pass a `tx`; this makes the requirement a compile error instead of
 * a latent footgun (round-4 N10/N4, deferred to Phase 2 by that round —
 * fixed here by making the parameter required).
 */
export async function findOrCreateTenantForClaim(
  tenantClaim: string,
  db: TxOrPrisma,
): Promise<ClaimTenantResolution> {
  const claim = normalizeTenantClaim(tenantClaim);

  // Serialises concurrent creation for the same claim BEFORE the resolve, so
  // a second concurrent caller observes the first's committed row at the
  // findClaimRow() below instead of racing into a P2002 on
  // tenant_claims_claim_key — which would abort the whole enclosing
  // withBypassRls transaction with no recovery (round-4 CR9 / round-3
  // CR8+S3-2). Keyed on the NORMALISED claim: two spellings of the same
  // claim must take the SAME lock.
  await advisoryXactLock(db, `tenant-claim:${claim}`);

  const row = await findClaimRow(db, claim);
  if (row) {
    // Revoked (D2): the claim is taken and needs an operator decision.
    // Refusing here (not falling through to create) is what keeps a revoked
    // row from being resurrected — creating would hit P2002 on
    // tenant_claims_claim_key.
    return row.revokedAt === null
      ? { kind: "tenant", id: row.tenantId }
      // The owning tenant rides on the refusal so the caller can emit an
      // audit row that resolveTenantId() can actually bind. Without it the
      // emit dead-letters: a first-ever sign-in has no user row, so
      // logAuditAsync -> resolveTenantId falls back to a users lookup on
      // SYSTEM_ACTOR_ID, finds nothing, and returns without enqueuing —
      // leaving the denial invisible to `tenant-domain unmapped`, which is
      // the whole point of distinguishing this refusal.
      : { kind: "claim_taken", tenantId: row.tenantId };
  }

  // Release-1 externalId fallback (D1), same raw-claim semantics as
  // resolveTenantByClaim.
  const byExternalId = await db.tenant.findUnique({
    where: { externalId: tenantClaim },
    select: { id: true },
  });
  if (byExternalId) return { kind: "tenant", id: byExternalId.id };

  const parsed = storableClaimSchema.safeParse(claim);
  // No tenant exists for an unstorable claim — nothing to bind an audit row
  // to, so this arm stays tenant-less by construction.
  if (!parsed.success) return { kind: "claim_invalid", tenantId: null };

  // Round-2 F-A. Round-1 M3 made the backfill exclude EVERY side of a fold
  // collision, so tenants A (`external_id = 'acme.com'`) and B (`'ACME.COM'`)
  // hold no claim row and keep resolving through the exact-match `externalId`
  // fallback above — correct, but it leaves the `UNIQUE(claim)` slot for
  // `acme.com` FREE. Without this probe a third spelling (`'Acme.com'`) that
  // neither tenant stores verbatim misses the registry, misses the exact-match
  // fallback, and creates a NEW tenant C that registers `acme.com` — after
  // which the claim row outranks the fallback and A's and B's existing members
  // are denied while their new members are created inside C.
  //
  // Refusing to create is the fix: the free slot belongs to whichever of the
  // colliding tenants the operator names with `tenant-domain add`, not to
  // whoever asks first with a third spelling. The refusal is loud and
  // diagnosable — `src/auth.ts` emits it as `tenant_claim_unmapped`, the reason
  // `tenant-domain unmapped` filters on, and `preflight` already reports the
  // collision itself.
  const foldedOwner = await findFoldedExternalIdOwner(db, claim);
  if (foldedOwner) return { kind: "claim_collision", tenantId: foldedOwner };

  const tenantSlug = slugifyTenant(tenantClaim);

  // SAVEPOINT before the statement that may abort (round-4 N6 — a savepoint
  // issued after an aborting statement cannot recover it). withBypassRls is
  // a single Prisma interactive transaction with no per-statement
  // savepoints of its own: a P2002 here leaves the session in ERROR and
  // every following statement returns 25P02 unless we have already opened
  // one. The residual P2002 this can hit is `tenants_slug_key`, not
  // `tenant_claims_claim_key` — slugifyTenant collapses `[^a-z0-9]+`, so
  // `alias.example` and `alias-example` both slugify to `alias-example`,
  // and the advisory lock above is keyed on the claim, so it does not
  // serialise that collision.
  await db.$executeRaw`SAVEPOINT tenant_claim_create`;
  let created: { id: string };
  try {
    created = await db.tenant.create({
      data: {
        externalId: tenantClaim,
        name: tenantClaim,
        slug: tenantSlug,
        claims: { create: { claim, createdBy: "signin" } },
      },
      select: { id: true },
    });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") {
      throw e;
    }
    // Recover the aborted session, then retry once with a random-hex slug
    // suffix, as today. A second failure here (P2002 or otherwise) is not
    // caught — it propagates, and the enclosing withBypassRls transaction
    // rolls back entirely, which is a safe outcome regardless of the
    // session's savepoint state.
    await db.$executeRaw`ROLLBACK TO SAVEPOINT tenant_claim_create`;
    const suffix = randomBytes(4).toString("hex");
    created = await db.tenant.create({
      data: {
        externalId: tenantClaim,
        name: tenantClaim,
        slug: `${tenantSlug.slice(0, SLUG_MAX_LENGTH - suffix.length - 1)}-${suffix}`,
        claims: { create: { claim, createdBy: "signin" } },
      },
      select: { id: true },
    });
  }
  await db.$executeRaw`RELEASE SAVEPOINT tenant_claim_create`;
  return { kind: "tenant", id: created.id };
}
