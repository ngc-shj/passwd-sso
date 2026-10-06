import { Prisma } from "@prisma/client";
import { prisma, type TxOrPrisma } from "@/lib/prisma";
import { slugifyTenant } from "@/lib/tenant/tenant-claim";
import { randomBytes } from "node:crypto";
import { SLUG_MAX_LENGTH } from "@/lib/validations/common";
import { advisoryXactLock } from "@/lib/tenant-rls";
import { normalizeTenantClaim, storableClaimSchema } from "@/lib/tenant/tenant-claim-registry";
import { claimRefusal, type ClaimRefusalDiagnosis } from "@/lib/tenant/claim-refusal";
import {
  recordTenantClaimEvent,
  SIGNIN_ACTOR_LABEL,
  TENANT_CLAIM_EVENT_OPERATION,
} from "@/lib/tenant/tenant-claim-event";

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
 * Outcome of `resolveTenantByClaim`.
 *
 * Discriminated for the third time on this branch, and for the third time for
 * the same reason (round-4 F1). `{ id } | null` collapsed "a revoked row owns
 * this claim" and "nothing owns this claim" into one value. No consumer read
 * that `null` as an ALLOW — the fail-open really was closed — but one consumer
 * read it as "no owner exists" and therefore filed its denial under the USER's
 * tenant while the same lockout, reached through the no-membership path, was
 * filed under the CLAIM's owner. `tenant-domain unmapped` groups by
 * `(tenant_id, claim)`, so one incident arrived as two groups, one of them
 * naming a tenant the operator cannot act on — and the `count(*)` that D-33
 * relies on to distinguish one confused user from a locked-out tenant was
 * split between them.
 *
 * Rounds 1, 3 and 4 each produced a finding against a nullable return on this
 * path. This is the last one.
 */
export type ClaimLookup =
  | { kind: "tenant"; id: string }
  /** A revoked `tenant_claims` row owns the claim (D2). The owner is carried. */
  | { kind: "revoked"; tenantId: string }
  /**
   * The claim cannot be stored at all (`storableClaimSchema` — SC9's ASCII
   * narrowing). Nobody owns it and nobody can: `tenant-domain add` would
   * refuse it too.
   *
   * Round-5 F3. Without this arm the resolver answered `unregistered` for an
   * unstorable claim while `findOrCreateTenantForClaim` — the SAME predicate,
   * one call path away — answered `claim_invalid`. The two produced different
   * audit reasons for one input, and after round 4 gave the operator report
   * two different remedies: an unstorable claim was printed under
   * "run `tenant-domain add`", a command guaranteed to refuse it. R48, and the
   * fix is one adjudicator rather than two that agree by convention.
   *
   * Carries the DIAGNOSIS (round-6 F1). `tenant-domain unmapped` buckets on
   * whether `metadata.claimRefusal` is set, so an unstorable claim that carried
   * no diagnosis was reported as "registered to a DIFFERENT tenant → move it
   * with `add --from`" — a remedy for a claim that is registered nowhere, and
   * that `add` refuses on the same predicate that produced this arm. The
   * discriminator has to be a FIELD, not text inside `claim`; that is D-41's
   * argument, applied to the population it did not cover.
   */
  | { kind: "unstorable"; refusal: ClaimRefusalDiagnosis }
  /** No claim row — nobody owns this claim. */
  | { kind: "unregistered" };

/**
 * Resolve a raw IdP-supplied claim to its tenant through the claim registry.
 *
 * A revoked claim row (D2) returns `{ kind: "revoked" }`: the row still
 * occupies its slot in `UNIQUE(claim)` and needs an operator decision. It
 * carries the owning tenant, because the caller has to file its denial under
 * the tenant whose claim this is (round-4 F1).
 *
 * Never writes (I5). The schema check runs only after the lookup has missed,
 * so an ordinary sign-in does not pay for it.
 *
 * Caller must already be inside a `withBypassRls` context.
 */
export async function resolveTenantByClaim(
  tenantClaim: string,
  db: TxOrPrisma = prisma,
): Promise<ClaimLookup> {
  const claim = normalizeTenantClaim(tenantClaim);
  const row = await findClaimRow(db, claim);
  if (row) {
    return row.revokedAt === null
      ? { kind: "tenant", id: row.tenantId }
      : { kind: "revoked", tenantId: row.tenantId };
  }

  // From here the claim resolves to nothing. The schema check is the same one
  // `findOrCreateTenantForClaim` applies, so the two answer "can it be
  // registered at all?" the SAME way.
  const parsed = storableClaimSchema.safeParse(claim);
  if (!parsed.success) {
    return { kind: "unstorable", refusal: unstorableRefusal(parsed.error) };
  }

  return { kind: "unregistered" };
}

/**
 * The refusal diagnosis for a claim `storableClaimSchema` rejects.
 *
 * Derived from the schema's own issue rather than written out here, so the two
 * cannot disagree about WHICH rule the value broke — and so a later refinement
 * added to the schema is described correctly without anyone remembering to come
 * back. Reachable from sign-in only through SC9's printable-ASCII narrowing:
 * the ingest boundary already caps the length, rejects the empty string and
 * normalises, so the other refinements are defensive.
 *
 * Machine-generated by construction (every message is a fixed string in
 * `tenant-claim-registry.ts` or a Zod built-in), which is what lets it satisfy
 * `ClaimRefusalDiagnosis` — see `@/lib/tenant/claim-refusal`.
 */
function unstorableRefusal(error: { issues: { message: string }[] }): ClaimRefusalDiagnosis {
  return claimRefusal(error.issues[0]?.message ?? "not storable as a claim");
}

/**
 * The `findOrCreateTenantForClaim` refusal that a `ClaimLookup` refusal already
 * determines.
 *
 * Round-6 F5. `src/auth.ts` used to answer a non-`tenant` lookup by CALLING
 * `findOrCreateTenantForClaim`, which re-took the advisory lock and re-ran all
 * four reads only to reach the arm the lookup had already named. Two
 * adjudicators for one question is the shape rounds 1, 3, 4 and 5 each produced
 * a finding against on this path; this makes the second one derive from the
 * first instead of re-deciding. `unregistered` is deliberately absent from the
 * signature — it is the ONE arm that still has to go to the creator, because
 * creating is what it asks for.
 */
export function refusalFromLookup(
  lookup: Exclude<ClaimLookup, { kind: "tenant" } | { kind: "unregistered" }>,
): Exclude<ClaimTenantResolution, { kind: "tenant" }> {
  switch (lookup.kind) {
    case "revoked":
      return { kind: "claim_taken", tenantId: lookup.tenantId };
    case "unstorable":
      return { kind: "claim_invalid", tenantId: null, refusal: lookup.refusal };
  }
}

/**
 * The refusal diagnosis a resolution arm carries, where its arm has one.
 *
 * Exported and hosted here, next to the arms it reads, rather than kept private
 * in `src/auth.ts`: `tenant-domain unmapped` buckets on whether this field is
 * set, so the CLI's own bucket guard has to be able to ask production the same
 * question the dispatch asks (round-6 F1 was an arm that stopped answering it).
 */
export function claimRefusalOf(
  refusal: Exclude<ClaimTenantResolution, { kind: "tenant" }>,
): ClaimRefusalDiagnosis | null {
  switch (refusal.kind) {
    case "claim_invalid":
      return refusal.refusal;
    case "claim_taken":
      return null;
  }
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
 * `logAuditAsync`'s `resolveTenantId` can only find a tenant through
 * `params.tenantId`, the team, or a `users` row — the sentinel matches none.
 *
 * This used to say the denial then DEAD-LETTERS, writing neither an
 * `audit_logs` nor an `audit_outbox` row and leaving `tenant-domain unmapped`
 * (which groups by `tenant_id` on both tables) showing nothing. That is no
 * longer true: `resolveTenantId` returns `SYSTEM_TENANT_ID` for the
 * unattributable case, so the row is written and `unmapped` shows it under
 * `__system__` rather than not at all.
 *
 * Carrying the tenant still matters, and now for the sharper reason: an arm
 * that knows its owning tenant must say so, or its denial is filed under
 * "no owning tenant" when one exists. `claim_taken` already knows its owning
 * tenant at the point it is constructed, so it carries it out rather than
 * making the caller re-query. `claim_invalid` is `null` because no
 * tenant owns an unregistrable claim — spelled explicitly so a future arm has
 * to state which case it is rather than inheriting an `undefined`.
 */
export type ClaimTenantResolution =
  | { kind: "tenant"; id: string }
  // A revoked `tenant_claims` row owns the claim (D2). The slot in
  // UNIQUE(claim) is taken and needs an operator decision, not a silent
  // resurrection — callers report this as `tenant_claim_unmapped`, the reason
  // `tenant-domain unmapped` filters on.
  | { kind: "claim_taken"; tenantId: string }
  // The normalised claim fails `storableClaimSchema` (SC9's ASCII narrowing).
  // Nothing is registrable, so registering a claim is not the remedy — and no
  // tenant owns it, so this is the one arm that cannot carry a tenantId.
  //
  // It DOES carry a diagnosis (round-6 F1): `tenant-domain unmapped` buckets on
  // whether `metadata.claimRefusal` is set, so without one this population was
  // printed under "registered to a DIFFERENT tenant — move it with `add --from`"
  // for a claim that is registered nowhere and that `add` refuses on this very
  // predicate.
  | { kind: "claim_invalid"; tenantId: null; refusal: ClaimRefusalDiagnosis };

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
      // audit row that resolveTenantId() binds to the RIGHT tenant. Without
      // it, a first-ever sign-in has no user row, the lookup on
      // SYSTEM_ACTOR_ID finds nothing, and the row is filed under
      // SYSTEM_TENANT_ID — so `tenant-domain unmapped`, which groups by
      // tenant_id, shows the denial under the sentinel rather than under the
      // tenant it is about, which is the whole point of distinguishing this
      // refusal. (Before the encoding landed the emit dead-lettered and the
      // denial was invisible entirely.)
      : { kind: "claim_taken", tenantId: row.tenantId };
  }

  const parsed = storableClaimSchema.safeParse(claim);
  // No tenant exists for an unstorable claim — nothing to bind an audit row
  // to, so this arm stays tenant-less by construction. The diagnosis is what
  // keeps the denial out of the "move it with `add --from`" bucket (round-6 F1).
  if (!parsed.success) {
    return { kind: "claim_invalid", tenantId: null, refusal: unstorableRefusal(parsed.error) };
  }

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
        name: tenantClaim,
        slug: `${tenantSlug.slice(0, SLUG_MAX_LENGTH - suffix.length - 1)}-${suffix}`,
        claims: { create: { claim, createdBy: "signin" } },
      },
      select: { id: true },
    });
  }
  await db.$executeRaw`RELEASE SAVEPOINT tenant_claim_create`;

  // Routing history (SC11 / #743), in THIS transaction, so the event and the
  // claim row it describes commit together or not at all.
  //
  // Placed after RELEASE SAVEPOINT and keyed on the surviving tenant id
  // deliberately. Both `tenant.create` calls above are mutually exclusive
  // alternatives of ONE logical registration — the second runs only after
  // ROLLBACK TO SAVEPOINT has undone the first — so a write inside each arm
  // would either double-emit or leave an event for a tenant that no longer
  // exists. One call, after the retry has settled, is the only placement that
  // is correct for both arms.
  //
  // This is the writer whose events an incident responder most needs and the
  // one a `tenantClaim.create` grep does not return: the claim row is created
  // through a NESTED relation write inside `tenant.create`, not through the
  // `tenantClaim` delegate.
  //
  // Failure here aborts the sign-in. That direction is deliberate and is a
  // stated availability cost: a broken tenant_claim_events table denies
  // first-ever sign-ins rather than silently losing the evidence.
  await recordTenantClaimEvent(db, {
    claim,
    operation: TENANT_CLAIM_EVENT_OPERATION.REGISTER,
    oldTenantId: null,
    newTenantId: created.id,
    oldRevokedAt: null,
    newRevokedAt: null,
    actorLabel: SIGNIN_ACTOR_LABEL,
  });

  return { kind: "tenant", id: created.id };
}
