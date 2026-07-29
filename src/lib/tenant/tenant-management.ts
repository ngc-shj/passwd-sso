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
): Promise<{ id: string } | null> {
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
    // Returning null here (not falling through to create) is what keeps a
    // revoked row from being resurrected — creating would hit P2002 on
    // tenant_claims_claim_key.
    return row.revokedAt === null ? { id: row.tenantId } : null;
  }

  // Release-1 externalId fallback (D1), same raw-claim semantics as
  // resolveTenantByClaim.
  const byExternalId = await db.tenant.findUnique({
    where: { externalId: tenantClaim },
    select: { id: true },
  });
  if (byExternalId) return byExternalId;

  const parsed = storableClaimSchema.safeParse(claim);
  if (!parsed.success) return null;

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
  return created;
}
