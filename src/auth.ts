import NextAuth from "next-auth";
import type { Account } from "next-auth";
import { createCustomAdapter } from "@/lib/auth/session/auth-adapter";
import { logAuditAsync } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { prisma, type TxOrPrisma } from "@/lib/prisma";
import { extractTenantClaimValue } from "@/lib/tenant/tenant-claim";
import { sessionMetaStorage } from "@/lib/auth/session/session-meta";
import { SESSION_ABSOLUTE_TIMEOUT_MAX } from "@/lib/validations/common";
import { tenantClaimStorage } from "@/lib/tenant/tenant-claim-storage";
import {
  resolveTenantByClaim,
  findOrCreateTenantForClaim,
  refusalFromLookup,
  claimRefusalOf,
  type ClaimTenantResolution,
  type ClaimLookup,
} from "@/lib/tenant/tenant-management";
import type { ClaimRefusalDiagnosis } from "@/lib/tenant/claim-refusal";
import { invalidateCachedSessions } from "@/lib/auth/session/session-cache-helpers";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { resolveUserTenantId, resolveUserTenantIdFromClient } from "@/lib/tenant-context";
import { getLogger } from "@/lib/logger";
import {
  emitAuthLoginFailure,
  type AuthLoginFailureReason,
} from "@/lib/audit/auth-failure";
// Shared with the adapter's first-ever-sign-in refusal site, which classifies
// the same refusal arms (see that module's header for why it is not hosted in
// either of the two files that use it).
import {
  CLAIM_REFUSAL_REASON,
  toAuditProvider,
} from "@/lib/audit/auth-failure-mapping";
import authConfig from "./auth.config";
import { TENANT_ROLE } from "@/lib/constants/auth/tenant-role";
import { errorLogFields } from "@/lib/logger/error-fields";

function getAuthRouteBasePath(): string {
  const basePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
  return `${basePath}/api/auth`;
}

// Exported for unit testing; must be called inside a Prisma transaction.
export async function assertBootstrapSingleMember(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  tenantId: string,
): Promise<void> {
  const activeCount = await tx.tenantMember.count({
    where: { tenantId, deactivatedAt: null },
  });
  if (activeCount > 1) {
    getLogger().error(
      { tenantId, activeCount, reason: "expected 1 active member" },
      "auth.bootstrap.migration_blocked",
    );
    throw new Error(
      `Bootstrap migration aborted: tenant ${tenantId} has ${activeCount} active members (expected 1)`,
    );
  }
}

// Discriminated result so a denial can carry which reason to audit-emit
// without emitting from inside this function. Emitting here would run
// logAuditAsync -> resolveTenantId -> withBypassRls NESTED inside the
// bootstrap-migration prisma.$transaction below — an R9 pool-exhaustion
// shape. The reason is instead carried out of withBypassRls (it is generic
// over the callback's return, src/lib/tenant-rls.ts:54) and
// emitAuthLoginFailure stays at the signIn callback, post-transaction.
export type SignInTenantResult =
  | { ok: true }
  | {
      ok: false;
      reason: Extract<AuthLoginFailureReason, "tenant_mismatch" | "tenant_claim_unmapped">;
      tenantId: string | null;
      /** The value the IdP asserted, or null when it asserted nothing usable. */
      claim: string | null;
      /**
       * A machine-generated description of why this deployment refused the
       * asserted value — never the value, and never operator- or
       * IdP-supplied. Two producers, both at a REFUSAL adjudicator: the ingest
       * boundary (`extractTenantClaimValue`) and `storableClaimSchema`
       * (round-6 F1, the population the round-5 field split left out).
       *
       * Its own field, not a prefix on `claim` (round-5 S2). Round 4 wrote
       * `refused: …` into `claim` and both READMEs told the operator to key
       * their remedy on that prefix — but `refused: contains U+200B` is
       * printable ASCII under the length cap, so an actor who controls the
       * asserted attribute can assert it verbatim and manufacture a row the
       * runbook says to trust. That is this branch's own recurring class (one
       * representation, two meanings, one of them trusted) reproduced in the
       * audit schema while being fixed in the code. A separate key cannot be
       * forged from the value side at all — and since round 6 the TYPE says so:
       * `ClaimRefusalDiagnosis` is branded and `claimRefusal()` is its only
       * producer, so "written by us" is checked by `tsc` rather than promised in
       * a comment (SEC-R6-3).
       */
      claimRefusal: ClaimRefusalDiagnosis | null;
    };

/**
 * Which tenant a claim refusal is filed under (round-3 F7).
 *
 * One lockout used to be attributed to three different tenants depending on
 * which site observed it: the adapter's first-ever-sign-in refusal filed it
 * under the claim's owning tenant (`TenantClaimUnusableError.tenantId`), row
 * 8b filed it under `null`, and the bootstrap branch filed it under the user's
 * EXISTING tenant. `tenant-domain unmapped` groups by tenant_id, so the same
 * incident arrived as three unrelated groups — two of them pointing at tenants
 * the operator cannot act on, and the `null` one not arriving at all
 * (logAuditAsync dead-letters a tenant-less emit).
 *
 * The refusal's own tenant wins wherever it exists, because it is the tenant
 * that OWNS the contested claim and therefore the one the operator's
 * `tenant-domain add` has to name. The user's existing tenant is the fallback:
 * it binds the row so the denial is at least recorded, which matters most for
 * `claim_invalid`, the one arm that has no owning tenant by construction.
 *
 * `tenantId` is REQUIRED, not optional (round-5 F5/S4/T10). Round 4 widened
 * this parameter to `{ tenantId?: string | null }` so a hand-built literal
 * would type-check, which erased the only property that made it a *refusal*
 * helper: with the field optional, an arm that forgets its attribution
 * silently inherits the fallback — the exact defect round-3 F7 and round-4 F1
 * both reported. Every arm must state where its denial is filed.
 *
 * Residual, considered and accepted (round-3 S3-2): the tenant these rows land
 * on is chosen by the CLAIM the caller presented, so someone who can complete
 * an IdP authentication can add AUTH_LOGIN_FAILURE rows to a tenant they do
 * not belong to. Per-(tenant, claim) write-time dedupe was rejected, and not
 * for cost: `tenant-domain unmapped` GROUPs BY exactly that pair and reports
 * `count(*)`, which is how an operator distinguishes one confused user from a
 * whole tenant locked out. Collapsing duplicates would delete the number the
 * report exists to show. The volume is bounded by completed IdP
 * authentications rather than by unauthenticated requests, the payload is
 * capped at MAX_TENANT_CLAIM_LENGTH, and retention GC ages the rows out.
 */
function refusalTenantId(
  refusal: { tenantId: string | null },
  existingTenantId: string | null,
): string | null {
  return refusal.tenantId ?? existingTenantId;
}

/**
 * Everything a refusal contributes to the audit row, derived from the ARM.
 *
 * Round-6 F5 collapsed three parallel enumerations of `ClaimLookup` — owner,
 * reason, diagnosis — into one: `refusalFromLookup` maps a refusing lookup onto
 * the corresponding `findOrCreateTenantForClaim` arm, and everything below reads
 * that one mapping. D-42 claimed round 4's closure worked because "the compiler
 * enumerated every consumer", and round 5 answered that the compiler enumerates
 * consumers, not attribution SOURCES. Three sources is how `collision` came to
 * be missing from one of them; one source is the fix.
 */
function lookupOwnerId(lookup: ClaimLookup): string | null {
  if (lookup.kind === "tenant" || lookup.kind === "unregistered") return null;
  return refusalFromLookup(lookup).tenantId;
}

/**
 * The audit reason for a lookup that did not produce a tenant.
 *
 * Single adjudicator with `CLAIM_REFUSAL_REASON` (round-5 F3): rows 7/9b used
 * to decide this inline with a truthiness test, so an unstorable claim was
 * reported as `tenant_claim_unmapped` — and `tenant-domain unmapped` then
 * printed it under "run `tenant-domain add`", a command that must refuse it.
 */
function lookupRefusalReason(
  lookup: Exclude<ClaimLookup, { kind: "tenant" }>,
): Extract<AuthLoginFailureReason, "tenant_mismatch" | "tenant_claim_unmapped"> {
  // The reported production bug: the IdP is sending a claim this deployment has
  // not registered, and registering it IS the remedy. Every other arm reads the
  // shared table through the shared mapping.
  if (lookup.kind === "unregistered") return "tenant_claim_unmapped";
  // No narrowing needed for `store_unavailable`'s `provider_error`: no lookup
  // arm maps to it, and the indexed access proves that — this return type is
  // narrower than the table's value union because `refusalFromLookup`'s own
  // return type is narrower than `ClaimRefusalKind`.
  return CLAIM_REFUSAL_REASON[refusalFromLookup(lookup).kind];
}

/** The diagnosis a refusing lookup carries, where its arm has one. */
function lookupRefusalDiagnosis(
  lookup: Exclude<ClaimLookup, { kind: "tenant" }>,
): ClaimRefusalDiagnosis | null {
  if (lookup.kind === "unregistered") return null;
  return claimRefusalOf(refusalFromLookup(lookup));
}

/**
 * Rows 4/8 and 6/9a: the tenant this sign-in should join, or the refusal that
 * stops it.
 *
 * Only `unregistered` reaches `findOrCreateTenantForClaim` (round-6 F5). Before
 * this, every non-`tenant` lookup did — taking the advisory lock and re-running
 * four reads to arrive at the arm `resolveTenantByClaim` had already named one
 * statement earlier, and giving the same question two adjudicators that agreed
 * only by convention.
 */
async function resolveTargetTenant(
  lookup: ClaimLookup,
  tenantClaim: string,
  db: TxOrPrisma,
): Promise<ClaimTenantResolution> {
  if (lookup.kind === "tenant") return { kind: "tenant", id: lookup.id };
  if (lookup.kind === "unregistered") return findOrCreateTenantForClaim(tenantClaim, db);
  return refusalFromLookup(lookup);
}

export async function ensureTenantMembershipForSignIn(
  userId: string,
  account?: Account | null,
  profile?: Record<string, unknown> | null,
): Promise<SignInTenantResult> {
  const extraction = extractTenantClaimValue(account, profile);
  if (extraction.kind !== "claim") {
    // "The IdP asserted nothing" and "the IdP asserted something this
    // deployment refuses" must not arrive here as the same value: the branch
    // below is an ALLOW (rows 1-3), so collapsing them turns a denial into a
    // sign-in. That collapse is round-3 M1 — measured against round 2, an
    // existing member of tenant A presenting `beta.example` + U+200B went
    // from denied to allowed, and the precondition is only control of the
    // asserted attribute.
    //
    // Both arms still need the user's current tenant: the allow to validate
    // single-tenancy (unchanged), the refusal to BIND its audit row —
    // emitAuthLoginFailure without a tenantId dead-letters (CR-3), which
    // would make the new denial invisible rather than merely unobserved.
    // Carried into BOTH exits below. Round-4 F8/T1: the MULTI_TENANT exit used
    // to drop it, so a multi-tenant user whose IdP was mangling the claim got
    // a bare `tenant_mismatch` with no indication of why — and the two exits
    // were indistinguishable in a test, which is how one of round 3's new
    // tests came to assert a path it never took.
    const diagnosis = extraction.kind === "malformed" ? extraction.diagnosis : null;

    let existingTenantId: string | null = null;
    try {
      existingTenantId = await resolveUserTenantId(userId);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED"
      ) {
        return {
          ok: false,
          reason: "tenant_mismatch",
          tenantId: null,
          claim: null,
          claimRefusal: diagnosis,
        };
      }
      throw error;
    }

    if (diagnosis !== null) {
      return {
        ok: false,
        reason: CLAIM_REFUSAL_REASON.claim_malformed,
        tenantId: existingTenantId,
        // No claim: the ingest boundary refused the asserted value, so there
        // is no value this deployment is willing to record as a claim. The
        // reason it refused goes in its own field, where the IdP cannot
        // imitate it (round-5 S2).
        claim: null,
        claimRefusal: diagnosis,
      };
    }

    // Allow first-time sign-in without tenant claim.
    // Membership bootstrap is handled by the auth adapter createUser flow.
    return { ok: true };
  }
  const tenantClaim = extraction.value;

  return withBypassRls(prisma, async (tx) => {
    // Both lookups run inside this single withBypassRls callback, in this
    // order, and neither may move. Resolving before creating is D2: the old
    // findOrCreateSsoTenant committed a tenants row before the denial check
    // below ever ran, so a claim that was going to be denied still left a
    // tenant behind. Reading the claim's tenant AND the user's existing
    // tenant before any write is what lets every deny branch below skip
    // findOrCreateTenantForClaim entirely.
    //
    // resolveUserTenantIdFromClient is called with the GLOBAL `prisma` proxy,
    // not `tx` — this mirrors the pre-existing call shape and is required,
    // not accidental. src/lib/prisma.ts's Proxy consults
    // getTenantRlsContext() and rebinds every call to the active transaction
    // while withBypassRls's AsyncLocalStorage context is live, so this still
    // reads inside the bypass tx. Hoisting this call ABOVE withBypassRls
    // would instead run it as `passwd_app` under FORCE ROW LEVEL SECURITY
    // with no app.tenant_id set: tenantMember.findMany would return zero
    // rows and every deny below would silently become an allow — a
    // cross-tenant fail-open.
    const lookup = await resolveTenantByClaim(tenantClaim, tx);
    const existingTenantId = await resolveUserTenantIdFromClient(prisma, userId);
    // The claim's owner where the lookup knows one — derived from the arms,
    // not from the one arm a finding happened to name (round-5 F2). `revoked`
    // and `collision` both know an owner; round 4 read only the first, so a
    // fold collision was still filed under the claim's owner on one path and
    // the user's tenant on the other.
    const claimOwnerId = lookupOwnerId(lookup);

    if (existingTenantId === null) {
      // Rows 4 / 8: no existing membership. Join the claimed tenant,
      // creating it first if this is the first sign-in to see this claim.
      const target = await resolveTargetTenant(lookup, tenantClaim, tx);
      if (target.kind !== "tenant") {
        // Row 8b: the claim is unusable, so there is no tenant to join. The
        // reason distinguishes the refusals (see CLAIM_REFUSAL_REASON) —
        // the storableClaimSchema arm is reachable from sign-in only through
        // SC9's ASCII narrowing (the ingest boundary already rejects the
        // other unstorable shapes), the revoked-row and fold-collision arms
        // are operator- and data-reachable.
        return {
          ok: false,
          reason: CLAIM_REFUSAL_REASON[target.kind],
          tenantId: refusalTenantId(target, null),
          claim: tenantClaim,
          claimRefusal: claimRefusalOf(target),
        };
      }

      await tx.tenantMember.upsert({
        where: { tenantId_userId: { tenantId: target.id, userId } },
        create: { tenantId: target.id, userId, role: TENANT_ROLE.MEMBER },
        update: {},
      });
      return { ok: true };
    }

    if (lookup.kind === "tenant" && existingTenantId === lookup.id) {
      // Row 5: already a member of the claimed tenant.
      await tx.tenantMember.upsert({
        where: { tenantId_userId: { tenantId: lookup.id, userId } },
        create: { tenantId: lookup.id, userId, role: TENANT_ROLE.MEMBER },
        update: {},
      });
      return { ok: true };
    }

    // existingTenantId names a tenant other than the one the claim resolves
    // to (or the claim did not resolve at all). The only remaining allow
    // path is a one-time bootstrap-tenant migration; everything else denies.
    const existingTenant = await tx.tenant.findUnique({
      where: { id: existingTenantId },
      select: { isBootstrap: true },
    });
    const isBootstrapTenant = !!existingTenant?.isBootstrap;

    if (!isBootstrapTenant) {
      // Rows 7 / 9b — same shape (existing tenant, not bootstrap, not the
      // claimed tenant), different operator-facing reason:
      //   - the claim resolved (row 7): this user belongs somewhere else,
      //     a tenant this deployment already knows -> tenant_mismatch.
      //   - it did not (row 9b, the reported production bug): the IdP is
      //     sending a claim this deployment has not registered ->
      //     tenant_claim_unmapped. Distinct because the operator action
      //     differs (register the claim vs. investigate the user).
      //
      // The TENANT the row is filed under differs too (round-4 F1). When a
      // revoked row owns the claim, the operator's decision is about THAT
      // tenant, and the no-membership path above already files it there via
      // `claim_taken` — so filing it under the user's tenant here split one
      // lockout across two `tenant-domain unmapped` groups. For row 7 and for
      // a genuinely unregistered claim there is no other owner, and the
      // user's tenant is both the only thing known and the right place to
      // look.
      return {
        ok: false,
        reason:
          lookup.kind === "tenant" ? "tenant_mismatch" : lookupRefusalReason(lookup),
        tenantId: refusalTenantId({ tenantId: claimOwnerId }, existingTenantId),
        claim: tenantClaim,
        claimRefusal: lookup.kind === "tenant" ? null : lookupRefusalDiagnosis(lookup),
      };
    }

    // Bootstrap tenant: eligible for one-time migration. Resolve (or, row
    // 9a, create) the target tenant now — creating here is on an ALLOW path,
    // which does not conflict with D2 (D2 is about writes on paths that go
    // on to deny). Row 9a is load-bearing (round-3 CR10): denying whenever
    // the claim is unresolved would regress the primary bootstrap->SSO
    // onboarding path (a magic-link user's first Google sign-in) into a hard
    // denial of the same NF2 shape as the bug this PR fixes.
    const target = await resolveTargetTenant(lookup, tenantClaim, tx);
    if (target.kind !== "tenant") {
      // Same refusal dispatch as row 8b, reached via the bootstrap branch.
      return {
        ok: false,
        reason: CLAIM_REFUSAL_REASON[target.kind],
        tenantId: refusalTenantId(target, existingTenantId),
        claim: tenantClaim,
        claimRefusal: claimRefusalOf(target),
      };
    }

    // Rows 6 / 9a: migrate.
    // Captured inside the tx for cache invalidation after commit (R3 site
    // #10 — Session.tenantId is cached in SessionInfo, so the migration
    // updateMany would otherwise leave stale cache entries up to TTL).
    let migratedSessionTokens: string[] = [];
    await prisma.$transaction(async (tx) => {
      await assertBootstrapSingleMember(tx, existingTenantId); // row 6b throw

      // Migrate user and account rows
      await tx.user.update({
        where: { id: userId },
        data: { tenantId: target.id },
      });

      await tx.account.updateMany({
        where: { userId },
        data: { tenantId: target.id },
      });

      // Migrate all tenant-scoped data tables
      await tx.passwordEntry.updateMany({
        where: { userId, tenantId: existingTenantId },
        data: { tenantId: target.id },
      });
      await tx.tag.updateMany({
        where: { userId, tenantId: existingTenantId },
        data: { tenantId: target.id },
      });
      await tx.folder.updateMany({
        where: { userId, tenantId: existingTenantId },
        data: { tenantId: target.id },
      });
      // Capture sessionTokens before mutating tenantId so the cache
      // invalidation after $transaction can reach the now-migrated rows.
      const migratedSessions = await tx.session.findMany({
        where: { userId, tenantId: existingTenantId },
        select: { sessionToken: true },
      });
      migratedSessionTokens = migratedSessions.map((s) => s.sessionToken);
      await tx.session.updateMany({
        where: { userId, tenantId: existingTenantId },
        data: { tenantId: target.id },
      });
      await tx.extensionToken.updateMany({
        where: { userId, tenantId: existingTenantId },
        data: { tenantId: target.id },
      });
      await tx.passwordEntryHistory.updateMany({
        where: { tenantId: existingTenantId },
        data: { tenantId: target.id },
      });
      await tx.vaultKey.updateMany({
        where: { userId, tenantId: existingTenantId },
        data: { tenantId: target.id },
      });
      // C13: audit_logs UPDATE is revoked from passwd_app; route through
      // the SECURITY DEFINER procedure so this privileged tenant-merge
      // path retains its audit history continuity.
      await tx.$executeRaw`CALL audit_log_tenant_migrate(${userId}::uuid, ${existingTenantId}::uuid, ${target.id}::uuid)`;
      // not a state transition — tenantId reassignment, see ../auth/email-uniqueness-design.md
      await tx.emergencyAccessGrant.updateMany({
        where: { ownerId: userId, tenantId: existingTenantId },
        data: { tenantId: target.id },
      });
      // emergencyAccessKeyPair/shareAccessLog have no userId column;
      // safe because bootstrap tenants are single-user by design.
      await tx.emergencyAccessKeyPair.updateMany({
        where: { tenantId: existingTenantId },
        data: { tenantId: target.id },
      });
      await tx.passwordShare.updateMany({
        where: { createdById: userId, tenantId: existingTenantId },
        data: { tenantId: target.id },
      });
      await tx.shareAccessLog.updateMany({
        where: { tenantId: existingTenantId },
        data: { tenantId: target.id },
      });
      await tx.attachment.updateMany({
        where: { createdById: userId, tenantId: existingTenantId },
        data: { tenantId: target.id },
      });
      await tx.notification.updateMany({
        where: { userId, tenantId: existingTenantId },
        data: { tenantId: target.id },
      });
      await tx.apiKey.updateMany({
        where: { userId, tenantId: existingTenantId },
        data: { tenantId: target.id },
      });
      await tx.webAuthnCredential.updateMany({
        where: { userId, tenantId: existingTenantId },
        data: { tenantId: target.id },
      });

      // Create membership in new tenant and remove old
      await tx.tenantMember.upsert({
        where: {
          tenantId_userId: {
            tenantId: target.id,
            userId,
          },
        },
        create: {
          tenantId: target.id,
          userId,
          role: TENANT_ROLE.MEMBER,
        },
        update: {},
      });

      await tx.tenantMember.deleteMany({
        where: { userId, tenantId: existingTenantId },
      });
    });

    // R3 site #10: Session.tenantId is part of cached SessionInfo;
    // tombstone the migrated tokens so the proxy stops serving the
    // stale (pre-migration) tenantId for up to SESSION_CACHE_TTL_MS.
    if (migratedSessionTokens.length > 0) {
      await invalidateCachedSessions(migratedSessionTokens);
    }

    return { ok: true };
  }, BYPASS_PURPOSE.AUTH_FLOW);
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  basePath: getAuthRouteBasePath(),
  adapter: createCustomAdapter(),
  session: {
    strategy: "database",
    // Outer cookie/session ceiling. Matches the policy ceiling
    // SESSION_ABSOLUTE_TIMEOUT_MAX (in minutes) converted to seconds.
    // Authoritative expiry is DB session.expires, computed per user by the
    // custom adapter via `resolveEffectiveSessionTimeouts`. See
    // docs/security/session-timeout-design.md.
    maxAge: SESSION_ABSOLUTE_TIMEOUT_MAX * 60,
    // Throttle how often `updateSession` runs. Not a scheduled heartbeat.
    updateAge: 30,
  },
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    async signIn(params) {
      const provider = params.account?.provider;
      const emailForAudit = params.user?.email ?? null;
      // C11 (OWASP A09-1): map Auth.js provider strings to our audit enum.
      const auditProvider = toAuditProvider(provider);

      const baseSignIn = authConfig.callbacks?.signIn;
      if (baseSignIn) {
        const baseResult = await baseSignIn(params);
        if (!baseResult) {
          await emitAuthLoginFailure({
            email: emailForAudit,
            provider: auditProvider,
            reason: "provider_error",
          });
          return false;
        }
      }

      // Reject nodemailer for SSO tenant users.
      // Magic Link is for individual (bootstrap tenant) users only.
      // Prevents bypassing SSO policy via direct API calls.
      // Note: WebAuthn sign-in uses a custom route (/api/auth/passkey/verify)
      // that has its own SSO tenant guard, bypassing Auth.js entirely.

      // Propagate provider to the adapter via sessionMetaStorage so
      // createSession can record Session.provider for AAL3 enforcement.
      // The meta object is the one established by withSessionMeta at the
      // route handler entry; AsyncLocalStorage returns the same reference
      // throughout the async chain, so mutating it is the intended pattern.
      const meta = sessionMetaStorage.getStore();
      if (meta) meta.provider = provider ?? null;
      if (provider === "nodemailer") {
        // Nodemailer requires email by definition. Block null-email as a safeguard.
        if (!params.user?.email) {
          await emitAuthLoginFailure({
            email: null,
            provider: "nodemailer",
            reason: "provider_error",
          });
          return false;
        }

        const existingUser = await withBypassRls(prisma, async (tx) =>
          tx.user.findUnique({
            where: { email: params.user.email! },
            select: {
              id: true,
              tenant: { select: { isBootstrap: true, id: true } },
            },
          }),
        BYPASS_PURPOSE.AUTH_FLOW);
        // Existing user in a non-bootstrap (SSO) tenant → reject
        if (existingUser?.tenant && !existingUser.tenant.isBootstrap) {
          await emitAuthLoginFailure({
            email: emailForAudit,
            tenantId: existingUser.tenant.id,
            provider: "nodemailer",
            reason: "tenant_mismatch",
            userId: existingUser.id,
          });
          return false;
        }
      }

      // Always verify user exists in DB — Auth.js may provide a pre-generated
      // id before the user row is actually inserted (new OAuth sign-in).
      let userId: string | null = null;
      const lookupEmail = params.user?.email;
      if (lookupEmail) {
        const existing = await withBypassRls(prisma, async (tx) =>
          tx.user.findUnique({
            where: { email: lookupEmail },
            select: { id: true },
          }),
        BYPASS_PURPOSE.AUTH_FLOW);
        userId = existing?.id ?? null;
      }

      // First-ever sign-in can reach this callback before user row is persisted.
      // Store the tenant claim so createUser can place the user directly
      // into the SSO tenant instead of creating a bootstrap tenant.
      if (!userId) {
        const extraction = extractTenantClaimValue(
          params.account,
          (params.profile ?? null) as Record<string, unknown> | null,
        );
        // The second half of round-3 M1, and the more damaging one. A refused
        // claim used to arrive here as the same `null` an absent one does, so
        // it fell through to createUser with no pending claim — which is the
        // bootstrap-tenant path, granting the user role OWNER of a brand-new
        // tenant, invisibly, with the row-6/9a absorption armed for their next
        // sign-in. Refusing HERE rather than in createUser is deliberate: the
        // adjudicator is the ingest boundary, nothing has been written yet,
        // and a claim this deployment refuses must never become a *pending*
        // claim.
        //
        // Observability limit, stated rather than assumed (CR-3's lesson):
        // there is no user row and no tenant here, so this emit resolves no
        // tenantId and logAuditAsync DEAD-LETTERS it — the synchronous
        // structured log line is the durable record, not an audit_logs row.
        // That is inherent to a refusal with no tenant (claim_invalid has the
        // same limit), not an oversight: there is nothing to bind to. The
        // existing-user path above does bind, because there the user's tenant
        // is known.
        if (extraction.kind === "malformed") {
          await emitAuthLoginFailure({
            email: emailForAudit,
            provider: auditProvider,
            reason: CLAIM_REFUSAL_REASON.claim_malformed,
            claimRefusal: extraction.diagnosis,
          });
          return false;
        }

        // Round-4 S4 — the FOURTH site of the same class, and the one nobody
        // had looked at. `store === undefined` means "this deployment could
        // not propagate the claim", which is not "no claim was asserted": the
        // old `if (store && …)` conflated them, so a perfectly valid claim was
        // dropped and createUser took the bootstrap path, granting the user
        // OWNER of a fresh tenant with nothing denied and nothing audited —
        // round-1 M1's outcome reached through a third route. Unreachable
        // today (tenantClaimStorage.run() wraps both Auth.js handlers, and
        // there is no other entry point), and the previous test pinned the
        // fall-through as intended behaviour, which is precisely how the next
        // entry point would have inherited it.
        //
        // Round-6 F3/SEC-R6-1: the reason now comes from the shared table
        // instead of a literal spelled here. The CONSUMER end of this same
        // signal (createUser, D-44) was emitting `claim_invalid`'s
        // `tenant_mismatch` for the identical condition — two judgement words
        // for one predicate (R48), and the wrong one, since `claim_invalid`
        // means "the claim failed storableClaimSchema" and on this path no
        // resolution runs at all.
        const store = tenantClaimStorage.getStore();
        if (extraction.kind === "claim") {
          if (!store) {
            await emitAuthLoginFailure({
              email: emailForAudit,
              provider: auditProvider,
              reason: CLAIM_REFUSAL_REASON.store_unavailable,
            });
            return false;
          }
          store.tenantClaim = extraction.value;
        }
        return true;
      }

      try {
        const result = await ensureTenantMembershipForSignIn(
          userId,
          params.account,
          (params.profile ?? null) as Record<string, unknown> | null,
        );
        if (!result.ok) {
          await emitAuthLoginFailure({
            email: emailForAudit,
            provider: auditProvider,
            reason: result.reason,
            tenantId: result.tenantId,
            userId,
            claim: result.claim,
            claimRefusal: result.claimRefusal,
          });
        }
        return result.ok;
      } catch (error) {
        // MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED is handled inside
        // ensureTenantMembershipForSignIn and returns false (not thrown here).
        // Any other error is unexpected — log and block sign-in.
        getLogger().error(
          { error: errorLogFields(error), provider: provider ?? "unknown" },
          "auth.signin.ensureTenantMembership_failed",
        );
        await emitAuthLoginFailure({
          email: emailForAudit,
          provider: auditProvider,
          reason: "provider_error",
          userId,
        });
        return false;
      }
    },
    async session({ session, user }) {
      // Auth.js v5 database strategy passes raw adapter fields;
      // strip internal fields to prevent leaking sessionToken etc.

      // Fetch passkey enforcement data alongside session build.
      // Wrapped in withBypassRls because session callbacks have no RLS context.
      let hasPasskey = false;
      let requirePasskey = false;
      let requirePasskeyEnabledAt: string | null = null;
      let passkeyGracePeriodDays: number | null = null;
      let fetchFavicons = false;
      try {
        const passkeyData = await withBypassRls(prisma, async (tx) => {
          const [credCount, tenant] = await Promise.all([
            tx.webAuthnCredential.count({ where: { userId: user.id } }),
            tx.user.findUnique({
              where: { id: user.id },
              select: {
                fetchFavicons: true,
                tenant: {
                  select: {
                    requirePasskey: true,
                    requirePasskeyEnabledAt: true,
                    passkeyGracePeriodDays: true,
                  },
                },
              },
            }),
          ]);
          // FAIL-CLOSED on a null tenant: User.tenantId is a non-null FK
          // (onDelete: Restrict), so a null tenant on a SUCCESSFUL query means
          // the user row itself vanished mid-session (or FK-orphaned corruption)
          // — there is no policy to trust. Throw so this flows through the
          // fail-closed catch below (same stance as derivePasskeyState, which
          // throws on a missing tenant) rather than defaulting requirePasskey
          // to false (a fail-open on the success path).
          if (!tenant?.tenant) {
            throw new Error(`session passkey policy: tenant for user ${user.id} not found`);
          }
          return { credCount, tenant: tenant.tenant, fetchFavicons: tenant.fetchFavicons };
        }, BYPASS_PURPOSE.AUTH_FLOW);

        hasPasskey = passkeyData.credCount > 0;
        requirePasskey = passkeyData.tenant.requirePasskey;
        requirePasskeyEnabledAt = passkeyData.tenant.requirePasskeyEnabledAt?.toISOString() ?? null;
        passkeyGracePeriodDays = passkeyData.tenant.passkeyGracePeriodDays;
        fetchFavicons = passkeyData.fetchFavicons;
      } catch (err) {
        // FAIL-CLOSED: a passkey-enforcement fetch failure must NOT drop
        // enforcement. Leaving the initial requirePasskey=false default would
        // fail OPEN — a passkey-required tenant would lose enforcement on a
        // transient DB/Redis blip. Instead force the safe-blocking bundle so
        // the page-route gate blocks (redirect to the exempt passkey-setup
        // page): requirePasskey=true + hasPasskey=false +
        // requirePasskeyEnabledAt=null. The null enabledAt makes
        // isPasskeyGracePeriodExpired() return true (immediate enforcement),
        // so passkeyEnforcementBlocks() === true. The four fields move as an
        // all-or-nothing bundle — a partial set (e.g. requirePasskey=true with
        // a stale non-null enabledAt) could land in "still in grace" and NOT
        // block, re-introducing a partial fail-open.
        requirePasskey = true;
        hasPasskey = false;
        requirePasskeyEnabledAt = null;
        passkeyGracePeriodDays = null;
        // fetchFavicons stays false (cosmetic; not a security field).

        // Still surface to ops: a silent catch hid Redis/DB issues that
        // mattered for tenants with requirePasskey enforcement (audit-trail
        // gap → A09). tenantId is included so operators can group by affected
        // tenant when a single tenant's data path is degraded.
        getLogger().warn(
          {
            userId: user.id,
            tenantId: (user as { tenantId?: string }).tenantId ?? null,
            error: errorLogFields(err),
          },
          "auth.session.passkey_data_fetch_failed",
        );
      }

      return {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
          hasPasskey,
          requirePasskey,
          requirePasskeyEnabledAt,
          passkeyGracePeriodDays,
          fetchFavicons,
        },
        expires: session.expires,
      };
    },
  },
  events: {
    async signIn({ user }) {
      if (user.id) {
        const meta = sessionMetaStorage.getStore();
        await logAuditAsync({
          scope: AUDIT_SCOPE.PERSONAL,
          action: AUDIT_ACTION.AUTH_LOGIN,
          userId: user.id,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
        });
      }
    },
    async signOut(message) {
      if ("session" in message && message.session?.userId) {
        const meta = sessionMetaStorage.getStore();
        await logAuditAsync({
          scope: AUDIT_SCOPE.PERSONAL,
          action: AUDIT_ACTION.AUTH_LOGOUT,
          userId: message.session.userId,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
        });
      }
    },
  },
});
