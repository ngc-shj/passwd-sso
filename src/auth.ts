import NextAuth from "next-auth";
import * as Sentry from "@sentry/nextjs";
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
  providerBindingOf,
  type ClaimTenantResolution,
  type ClaimLookup,
} from "@/lib/tenant/tenant-management";
import type { ClaimRefusalDiagnosis } from "@/lib/tenant/claim-refusal";
import { classifySentinelTenantConstraint } from "@/lib/tenant/sentinel-tenant-constraint";
import { invalidateCachedSessions } from "@/lib/auth/session/session-cache-helpers";
import { withBypassRls } from "@/lib/tenant-rls";
import { assertTeamsLocked, lockTenantMemberTeamsAgainstRotation, memberTeamIds } from "@/lib/team/team-key-rotation-lock";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import {
  resolveOwningTenantIdFromClient,
  resolveUserTenantId,
  resolveUserTenantIdFromClient,
} from "@/lib/tenant-context";
import { getLogger } from "@/lib/logger";
import { realignmentBySignIn, realignToMembershipInTx } from "@/lib/tenant/tenant-realignment";
import {
  emitAuthLoginFailure,
  type AuthLoginFailureReason,
  type ProviderBindingAudit,
} from "@/lib/audit/auth-failure";
import { deriveClaimBindingMode, type ClaimBindingMode } from "@/lib/auth/jackson-providers";
// Shared with the adapter's first-ever-sign-in refusal site, which classifies
// the same refusal arms (see that module's header for why it is not hosted in
// either of the two files that use it).
import {
  CLAIM_REFUSAL_REASON,
  toAuditProvider,
} from "@/lib/audit/auth-failure-mapping";
import authConfig, { allowsDangerousEmailAccountLinking } from "./auth.config";
import { TENANT_ROLE } from "@/lib/constants/auth/tenant-role";
import { errorLogFields } from "@/lib/logger/error-fields";
import { passkeyEnforcementBlocks } from "@/lib/auth/policy/passkey-enforcement";

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
type SignInRefusalReason = Extract<
  AuthLoginFailureReason,
  | "tenant_mismatch"
  | "tenant_claim_unmapped"
  | "tenant_claim_system_tenant"
  | "tenant_claim_unbound"
  | "tenant_claim_provider_mismatch"
  | "provider_error"
>;

export type SignInTenantResult =
  | { ok: true }
  | {
      ok: false;
      reason: SignInRefusalReason;
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
      /**
       * The binding refusals' `boundProvider` and `signInProviderRef`
       * (`providerBindingOf`); null on every other arm. Required, so each arm
       * states which it is.
       */
      providerBinding: ProviderBindingAudit | null;
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
 * the operator cannot act on, and the `null` one arriving under `__system__`
 * (logAuditAsync records a tenant-less emit under SYSTEM_TENANT_ID), which is
 * a fourth group the operator cannot act on either.
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
 * consumers, not attribution SOURCES. Three sources is how an owner-carrying arm
 * came to be missing from one of them; one source is the fix.
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
): SignInRefusalReason {
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

/** The binding audit fields a refusing lookup carries, where its arm has them. */
function lookupProviderBinding(
  lookup: Exclude<ClaimLookup, { kind: "tenant" }>,
  signInProvider: string,
): ProviderBindingAudit | null {
  if (lookup.kind === "unregistered") return null;
  return providerBindingOf(refusalFromLookup(lookup), signInProvider);
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
  signInProvider: string,
  mode: ClaimBindingMode,
  db: TxOrPrisma,
): Promise<ClaimTenantResolution> {
  if (lookup.kind === "tenant") return { kind: "tenant", id: lookup.id };
  if (lookup.kind === "unregistered") {
    return findOrCreateTenantForClaim(tenantClaim, signInProvider, mode, db);
  }
  return refusalFromLookup(lookup);
}

/**
 * `account` is required (C5): its `provider` is the presenting provider the
 * claim binding is decided against. `null` stays expressible because Auth.js
 * types the callback's account that way; a claim arriving with no account is
 * refused, never resolved as if unbound.
 */
export async function ensureTenantMembershipForSignIn(
  userId: string,
  account: Account | null,
  profile: Record<string, unknown> | null,
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
    // emitAuthLoginFailure without a tenantId is recorded under
    // SYSTEM_TENANT_ID (CR-3), so the denial is filed under "no owning tenant"
    // when one exists, and `tenant-domain unmapped` shows it against
    // `__system__` instead of against the tenant it is about.
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
          providerBinding: null,
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
        providerBinding: null,
      };
    }

    // Allow first-time sign-in without tenant claim.
    // Membership bootstrap is handled by the auth adapter createUser flow.
    return { ok: true };
  }
  const tenantClaim = extraction.value;

  const signInProvider = account?.provider;
  if (!signInProvider) {
    getLogger().error({ userId }, "auth.signin.claim_without_provider");
    return {
      ok: false,
      reason: CLAIM_REFUSAL_REASON.provider_unavailable,
      tenantId: null,
      claim: tenantClaim,
      claimRefusal: null,
      providerBinding: null,
    };
  }

  try {
    // Derived per sign-in, not cached: the mode follows the env the process
    // was started with, and tests select it by stubbing that env.
    return await claimedTenantMembership(
      userId,
      tenantClaim,
      signInProvider,
      deriveClaimBindingMode(),
    );
  } catch (error) {
    // The claim resolved to SYSTEM_TENANT_ID and a CHECK refused the write
    // (CF13). Two writers below can reach it: the `tenantMember.upsert` on the
    // no-membership path and the `user.update` on the migration path, raising
    // `tenant_members_not_system_tenant` and `users_not_system_tenant`
    // respectively. Turned into a REFUSAL rather than emitted here, so the
    // single emit at the signIn callback stays the only one — a second emit
    // site is what round 1 of #812 spent itself on.
    //
    // The state is reachable only out of band: `tenant-domain add` refuses a
    // sentinel target on the resolved id, so no operator command creates the
    // `tenant_claims` row this needs. What C3 buys is that the denial says so
    // instead of arriving as `provider_error`.
    const verdict = classifySentinelTenantConstraint(error);
    if (verdict.kind === "unnamed_check") {
      // A check violation whose constraint could not be read — the reachable
      // cause is a server with a non-English `lc_messages`, where the name is
      // in the message but not in a shape the extractor matches. Rethrown, so
      // the callback's catch files it as `provider_error`; logged here because
      // that reason is indistinguishable from a dozen others and this is the
      // only place that knows a CHECK was involved.
      getLogger().error(
        { error: errorLogFields(error) },
        "auth.signin.check_violation_constraint_unnamed",
      );
      throw error;
    }
    if (verdict.kind !== "sentinel") throw error;
    return {
      ok: false,
      reason: CLAIM_REFUSAL_REASON.claim_system_tenant,
      // Left to logAuditAsync's own resolveTenantId, which reads the user's
      // `users.tenantId`: for both reachable paths the user already has a
      // tenant, and that is the tenant an operator can act on. Naming the
      // sentinel here would instead file the denial under `__system__`, where
      // the same comment on the extraction branch above explains it is not
      // wanted when a real tenant is known.
      tenantId: null,
      // Load-bearing, and measured. `tenant-domain unmapped` filters
      // `claim IS NOT NULL OR claim_refusal IS NOT NULL` after the reason
      // predicate, and this arm carries no `claimRefusal` — a CHECK produces no
      // `ClaimRefusalDiagnosis`. Without the claim the row passes the reason
      // filter and is then dropped by that gate, so Objective 3 would be false
      // while every unit assertion passed.
      claim: tenantClaim,
      claimRefusal: null,
      providerBinding: null,
    };
  }
}

async function claimedTenantMembership(
  userId: string,
  tenantClaim: string,
  signInProvider: string,
  mode: ClaimBindingMode,
): Promise<SignInTenantResult> {
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
    const lookup = await resolveTenantByClaim(tenantClaim, signInProvider, mode, tx);
    const existingTenantId = await resolveUserTenantIdFromClient(prisma, userId);
    // The claim's owner where the lookup knows one (`revoked`) — derived from
    // the arms through refusalFromLookup, not from whichever arm a finding
    // happened to name (round-5 F2), so a denial is filed under the same
    // tenant on every path.
    const claimOwnerId = lookupOwnerId(lookup);

    if (existingTenantId === null) {
      // Rows 4 / 8: no existing membership. Join the claimed tenant,
      // creating it first if this is the first sign-in to see this claim.
      const target = await resolveTargetTenant(lookup, tenantClaim, signInProvider, mode, tx);
      if (target.kind !== "tenant") {
        // Row 8b: the claim is unusable, so there is no tenant to join. The
        // reason distinguishes the refusals (see CLAIM_REFUSAL_REASON) —
        // the storableClaimSchema arm is reachable from sign-in only through
        // SC9's ASCII narrowing (the ingest boundary already rejects the
        // other unstorable shapes), the revoked-row arm is operator-reachable.
        return {
          ok: false,
          reason: CLAIM_REFUSAL_REASON[target.kind],
          tenantId: refusalTenantId(target, null),
          claim: tenantClaim,
          claimRefusal: claimRefusalOf(target),
          providerBinding: providerBindingOf(target, signInProvider),
        };
      }

      const joined = await tx.tenantMember.upsert({
        where: { tenantId_userId: { tenantId: target.id, userId } },
        create: { tenantId: target.id, userId, role: TENANT_ROLE.MEMBER },
        update: {},
        select: { id: true },
      });

      // This branch is the producer of the column/membership divergence the
      // adjudicator exists to survive: the membership moves and, until now, the
      // column did not. A user released by one tenant and signed in through
      // another's IdP was left with `User.tenantId` naming the tenant that
      // released them, and `users_tenant_isolation` then hid their own row from
      // their own requests — vault unlock reporting the vault as not set up,
      // vault setup returning unauthorized, and eleven more routes taking their
      // not-found arm.
      //
      // The column follows the membership. The DATA does not, and that is the
      // decision rather than an oversight: see `realignOwningTenantColumn`. The
      // counts it records are what stop it being a silent one — a member arriving
      // with rows stranded in a tenant they no longer belong to is a condition
      // an operator can act on, and nobody can act on a state nothing reports.
      await realignToMembershipInTx(tx, {
        userId,
        memberId: joined.id,
        tenantId: target.id,
        cause: realignmentBySignIn(userId),
      });
      return { ok: true };
    }

    if (lookup.kind === "tenant" && existingTenantId === lookup.id) {
      // Row 5: already a member of the claimed tenant.
      const member = await tx.tenantMember.upsert({
        where: { tenantId_userId: { tenantId: lookup.id, userId } },
        create: { tenantId: lookup.id, userId, role: TENANT_ROLE.MEMBER },
        update: {},
        select: { id: true },
      });
      // "Already a member" is answered from the active membership first, so the
      // column can still name another tenant here — a user SCIM or directory sync
      // reactivated before those producers moved it. Row 4's move, for the same
      // reason; a no-op read when the column already agrees.
      await realignToMembershipInTx(tx, {
        userId,
        memberId: member.id,
        tenantId: lookup.id,
        cause: realignmentBySignIn(userId),
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
        providerBinding:
          lookup.kind === "tenant" ? null : lookupProviderBinding(lookup, signInProvider),
      };
    }

    // Bootstrap tenant: eligible for one-time migration. Resolve (or, row
    // 9a, create) the target tenant now — creating here is on an ALLOW path,
    // which does not conflict with D2 (D2 is about writes on paths that go
    // on to deny). Row 9a is load-bearing (round-3 CR10): denying whenever
    // the claim is unresolved would regress the primary bootstrap->SSO
    // onboarding path (a magic-link user's first Google sign-in) into a hard
    // denial of the same NF2 shape as the bug this PR fixes.
    const target = await resolveTargetTenant(lookup, tenantClaim, signInProvider, mode, tx);
    if (target.kind !== "tenant") {
      // Same refusal dispatch as row 8b, reached via the bootstrap branch.
      return {
        ok: false,
        reason: CLAIM_REFUSAL_REASON[target.kind],
        tenantId: refusalTenantId(target, existingTenantId),
        claim: tenantClaim,
        claimRefusal: claimRefusalOf(target),
        providerBinding: providerBindingOf(target, signInProvider),
      };
    }

    // A membership row the user already holds in the target can only be a
    // deactivated one: the bootstrap membership is their active one, and
    // `tenant_members_one_active_per_user` allows no second. Reactivating it is
    // the target tenant's decision — SCIM, directory sync, its admins — not a
    // sign-in's: row 4 leaves such a row deactivated (`update: {}`), and
    // `tenant-domain realign` does too. Migrating anyway would delete the
    // bootstrap membership and leave the user active nowhere, so the migration
    // is refused here, before any write, and the user keeps their bootstrap
    // tenant and its data. Filed under the target. Reachable on row 6 only: a
    // tenant row 9a has just created has no members.
    //
    // No producer can reactivate this user today, so the refusal repeats on
    // every sign-in. Directory sync created the row deactivated because the
    // bootstrap membership is active, and refuses to reactivate it with
    // ACTIVE_IN_ANOTHER_TENANT (`usersActiveInAnotherTenant` has no bootstrap
    // exemption). SCIM reactivation meets `tenant_members_one_active_per_user`
    // and answers 409. `realign` takes only users active nowhere. What works
    // today: the target tenant deletes the row (SCIM `DELETE /Users/<userId>`,
    // `deactivateScimUser`), and the user signs in before the next directory
    // sync recreates it; the sign-in then finds no row and migrates.
    const priorMembership = await tx.tenantMember.findUnique({
      where: { tenantId_userId: { tenantId: target.id, userId } },
      select: { id: true },
    });
    if (priorMembership) {
      return {
        ok: false,
        reason: "tenant_mismatch",
        tenantId: target.id,
        claim: tenantClaim,
        claimRefusal: null,
        providerBinding: null,
      };
    }

    // Rows 6 / 9a: migrate.
    // Captured inside the tx for cache invalidation after commit (R3 site
    // #10 — Session.tenantId is cached in SessionInfo, so the migration
    // updateMany would otherwise leave stale cache entries up to TTL).
    let migratedSessionTokens: string[] = [];
    await prisma.$transaction(async (tx) => {
      await assertBootstrapSingleMember(tx, existingTenantId); // row 6b throw

      // The user leaves the bootstrap tenant's teams' key distribution: the
      // memberships are not migrated, and a rotation there must not wrap the
      // next key to a user no longer in the tenant. Locked first, before the
      // users row is touched, and checked after: a membership joined since
      // the lock refuses the move (team-key-rotation-lock.ts).
      const leavingTeams = await lockTenantMemberTeamsAgainstRotation(tx, existingTenantId, [userId]);
      await tx.teamMember.updateMany({
        where: { userId, tenantId: existingTenantId, keyDistributed: true },
        data: { keyDistributed: false },
      });
      assertTeamsLocked(leavingTeams, await memberTeamIds(tx, userId, existingTenantId));

      // Migrate user and account rows
      await tx.user.update({
        where: { id: userId },
        data: { tenantId: target.id },
      });

      await tx.account.updateMany({
        where: { userId, tenantId: existingTenantId },
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
      await tx.webAuthnCredential.updateMany({
        where: { userId, tenantId: existingTenantId },
        data: { tenantId: target.id },
      });
      // MCP grants cannot move: each is bound to its client's tenant, and the
      // client is tenant-owned and stays — the code exchange and the refresh
      // refuse a grant whose tenant differs from its client's. They are revoked
      // instead: invalidateUserSessions revokes these two and the delegation
      // sessions riding on them, by user and tenant, when a member leaves a
      // tenant. It has no authorization-code arm; an unused code is consumed
      // here, its own revocation.
      const revokedAt = new Date();
      await tx.mcpAccessToken.updateMany({
        where: { userId, tenantId: existingTenantId, revokedAt: null },
        data: { revokedAt },
      });
      await tx.mcpRefreshToken.updateMany({
        where: { userId, tenantId: existingTenantId, revokedAt: null },
        data: { revokedAt },
      });
      await tx.delegationSession.updateMany({
        where: { userId, tenantId: existingTenantId, revokedAt: null },
        data: { revokedAt },
      });
      await tx.mcpAuthorizationCode.updateMany({
        where: { userId, tenantId: existingTenantId, usedAt: null },
        data: { usedAt: revokedAt },
      });
      // An op_* token authenticates as its subject with the bootstrap tenant's
      // maintenance scope, which the user no longer holds after the move:
      // revoked by subject, as invalidateUserSessions does.
      await tx.operatorToken.updateMany({
        where: { subjectUserId: userId, tenantId: existingTenantId, revokedAt: null },
        data: { revokedAt },
      });
      // An extension or iOS token, or an API key, is revoked, not moved: a
      // moved one would be a live target-tenant credential never checked
      // against the target's `requirePasskey` — an extension token until its
      // next refresh, an API key for the rest of its life — since each is
      // validated only against revocation, expiry and an active membership in
      // its own tenant. Revoked as invalidateUserSessions revokes both when a
      // member leaves a tenant. Sessions above do move, where
      // invalidateUserSessions deletes them: the session callback reads the
      // passkey requirement from the tenant of the user's ACTIVE MEMBERSHIP
      // (resolveOwningTenantIdFromClient), and the proxy reads it through the
      // session cache, so their cache is evicted below and the next request
      // re-reads it under the target tenant.
      await tx.extensionToken.updateMany({
        where: { userId, tenantId: existingTenantId, revokedAt: null },
        data: { revokedAt },
      });
      await tx.apiKey.updateMany({
        where: { userId, tenantId: existingTenantId, revokedAt: null },
        data: { revokedAt },
      });
      // A pending bridge code is consumed, not moved. The passkey requirement
      // is checked when a code is issued and when a token is refreshed, not at
      // the exchange, so a code issued under the bootstrap tenant and moved
      // would mint a target-tenant token never held to the target's
      // `requirePasskey`. The extension or app asks for a new code.
      await tx.extensionBridgeCode.updateMany({
        where: { userId, tenantId: existingTenantId, usedAt: null },
        data: { usedAt: revokedAt },
      });
      await tx.mobileBridgeCode.updateMany({
        where: { userId, tenantId: existingTenantId, usedAt: null },
        data: { usedAt: revokedAt },
      });
      // teamMemberKey / teamPasswordFavorite stay: they are filed under their
      // team's tenant, and teams and team memberships are not migrated.

      // Remove the bootstrap membership BEFORE creating the new one:
      // `tenant_members_one_active_per_user` refuses a second active row, so
      // the other order failed every migration on a real database. `create`,
      // not an upsert: the check above found no row in the target, and one
      // that appeared since is refused (P2002) rather than kept as found.
      await tx.tenantMember.deleteMany({
        where: { userId, tenantId: existingTenantId },
      });

      await tx.tenantMember.create({
        data: {
          tenantId: target.id,
          userId,
          role: TENANT_ROLE.MEMBER,
        },
      });
    });

    // R3 site #10: Session.tenantId is part of cached SessionInfo;
    // tombstone the migrated tokens so the proxy stops serving the
    // stale (pre-migration) tenantId for up to SESSION_CACHE_TTL_MS.
    if (migratedSessionTokens.length > 0) {
      const { failed } = await invalidateCachedSessions(migratedSessionTokens);
      // Same signal invalidateUserSessions raises: a tombstone that did not
      // land leaves the pre-migration SessionInfo cached on workers.
      if (failed > 0) {
        getLogger().error(
          {
            userId,
            failures: failed,
            reason: "bootstrap_tenant_migration",
            _logType: "session.cache_tombstone_failures",
          },
          "session.cache_tombstone_failures",
        );
        Sentry.captureMessage(
          "session cache tombstone failures during the bootstrap tenant migration",
          {
            level: "error",
            tags: { reason: "bootstrap_tenant_migration" },
            extra: { userId, failures: failed, tenantScope: target.id },
          },
        );
      }
    }

    return { ok: true };
  }, BYPASS_GRANT.AUTH_TENANT_CLAIM_MEMBERSHIP);
}

// One instance, shared by NextAuth and the signIn callback's subject lookup
// below, so both read accounts and users through the same methods.
const adapter = createCustomAdapter();

type OAuthSignInSubject =
  /** `userId` null: no user yet — the first-ever sign-in path. */
  | { kind: "user"; userId: string | null }
  /** Auth.js will refuse with OAuthAccountNotLinked; `userId` is the email's user. */
  | { kind: "not_linked"; userId: string };

/**
 * The user an OAuth/OIDC sign-in will be signed in as, resolved the way
 * Auth.js's `handleLoginOrRegister` resolves it, through the same adapter
 * methods.
 *
 * Auth.js calls the signIn callback BEFORE its own account-link check, so the
 * callback cannot take the user by the IdP-asserted email: every membership
 * write below — the bootstrap migration, the row-4 join and realignment —
 * commits in its own transaction, and Auth.js's later `OAuthAccountNotLinked`
 * does not undo it. An IdP asserting another user's email, with a claim bound
 * to the IdP's own tenant, would move that user's tenant and data while the
 * session itself was refused.
 *
 * - The provider account is linked: its user, whatever email is asserted.
 * - Not linked, and the email names a user: that user only where the provider
 *   links by email (`allowsDangerousEmailAccountLinking`, the predicate the
 *   provider construction uses); otherwise `not_linked`.
 * - Not linked, no such user: none.
 *
 * Not modelled: a sign-in made while another session is active, which Auth.js
 * links to that session's user. The app has no linking flow; such a sign-in is
 * resolved as if no session existed, with three outcomes:
 * - refused (`not_linked`);
 * - through a provider that links by email, resolved to the user whose email
 *   that provider vouches for;
 * - when the email names no user (any provider), resolved to none: the callback
 *   allows it with no writes (no `createUser` follows), Auth.js links the IdP
 *   account to the session's user, and that user's claim gate runs on their
 *   next sign-in through that account.
 */
async function resolveOAuthSignInSubject(
  account: Account,
  email: string | null | undefined,
): Promise<OAuthSignInSubject> {
  const { getUserByAccount, getUserByEmail } = adapter;
  if (!getUserByAccount || !getUserByEmail) {
    throw new Error("auth adapter does not implement getUserByAccount/getUserByEmail");
  }
  const linked = await getUserByAccount({
    provider: account.provider,
    providerAccountId: account.providerAccountId,
  });
  if (linked) return { kind: "user", userId: linked.id };
  if (!email) return { kind: "user", userId: null };
  const byEmail = await getUserByEmail(email);
  if (!byEmail) return { kind: "user", userId: null };
  return allowsDangerousEmailAccountLinking(account.provider)
    ? { kind: "user", userId: byEmail.id }
    : { kind: "not_linked", userId: byEmail.id };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  basePath: getAuthRouteBasePath(),
  adapter,
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
    // Owned, not inherited: every reader of the session cookie accepts only
    // the alphabet this emits (SESSION_TOKEN_PATTERN in session-cookie.ts).
    // Auth.js's default is the same today; pinning it here keeps an Auth.js
    // upgrade from changing the format under that reader.
    generateSessionToken: () => crypto.randomUUID(),
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
      // The meta object is the innermost sessionMetaStorage.run: the one
      // withSessionMeta establishes, or on a callback that carried a session
      // cookie, the copy the callback wrapper makes with replacesSessionTokens
      // (the outer store does not see this mutation). AsyncLocalStorage
      // returns the same reference throughout the handler, so mutating it is
      // the intended pattern.
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

        // The active membership's tenant, not the `User.tenantId` column: this
        // gate rejects magic-link sign-in for SSO-tenant users, and the column is
        // a denormalized copy with no invalidation, so against a stale value the
        // gate consults the tenant the user has left.
        const existingUser = await withBypassRls(prisma, async (tx) => {
          const found = await tx.user.findUnique({
            where: { email: params.user.email! },
            select: { id: true },
          });
          if (!found) return null;
          const tenantId = await resolveOwningTenantIdFromClient(tx, found.id);
          const tenant = tenantId
            ? await tx.tenant.findUnique({
                where: { id: tenantId },
                select: { isBootstrap: true, id: true },
              })
            : null;
          return { id: found.id, tenant };
        }, BYPASS_GRANT.AUTH_SIGNIN_TENANT_LOOKUP);
        // An existing user whose tenant does not resolve, or whose resolved
        // tenant row is absent, leaves this gate's question — is this an SSO
        // tenant? — unanswered. The arm below reads "no answer" as "not SSO" and
        // admits the magic link, so the undecidable case had to be split out:
        // `createSession` in auth-adapter treats exactly this state as
        // corruption and refuses, and an authentication gate must not be the one
        // reader that takes it for a default. `provider_error` is this
        // deployment's existing reason for "the sign-in machinery failed",
        // which is what a missing tenant row is.
        if (existingUser && !existingUser.tenant) {
          await emitAuthLoginFailure({
            email: emailForAudit,
            provider: "nodemailer",
            reason: "provider_error",
            userId: existingUser.id,
          });
          return false;
        }
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
      const account = params.account;
      if (account && (account.type === "oauth" || account.type === "oidc")) {
        const subject = await resolveOAuthSignInSubject(account, lookupEmail);
        if (subject.kind === "not_linked") {
          await emitAuthLoginFailure({
            email: emailForAudit,
            provider: auditProvider,
            reason: "account_not_linked",
            userId: subject.userId,
          });
          return false;
        }
        userId = subject.userId;
      } else if (lookupEmail) {
        const existing = await withBypassRls(prisma, async (tx) =>
          tx.user.findUnique({
            where: { email: lookupEmail },
            select: { id: true },
          }),
        BYPASS_GRANT.AUTH_USER_LOOKUP);
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
        // tenantId and logAuditAsync records it under SYSTEM_TENANT_ID. The
        // row IS written; what is lost is the attribution, so `tenant-domain
        // unmapped` (which groups by tenant_id) shows the refusal under
        // `__system__` rather than under any tenant an operator can act on.
        // That is inherent to a refusal with no tenant (claim_invalid has the
        // same limit), not an oversight: there is nothing to bind to. The
        // existing-user path above does bind, because there the user's tenant
        // is known.
        //
        // This comment used to say the emit DEAD-LETTERS and that the
        // synchronous structured log line was the durable record. That was the
        // premise #806 closed: the shipped forwarder excludes
        // `audit-dead-letter` and the container log cap can rotate it out, so
        // the line was not durable and the event had no record at all.
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
          // Set together (C5): createUser decides the binding against this
          // provider, and refuses a claim that arrives without one.
          store.tenantClaim = extraction.value;
          store.provider = provider ?? null;
        }
        return true;
      }

      try {
        const result = await ensureTenantMembershipForSignIn(
          userId,
          params.account ?? null,
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
            providerBinding: result.providerBinding,
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
      let passkeyStateDegraded = false;
      let fetchFavicons = false;
      try {
        const passkeyData = await withBypassRls(prisma, async (tx) => {
          // The active membership decides whose passkey enforcement applies.
          // `fetchFavicons` still comes off the user row; only the tenant is
          // re-sourced, because traversing `user.tenant` follows the stale column.
          const credCount = await tx.webAuthnCredential.count({ where: { userId: user.id } });
          const userRow = await tx.user.findUnique({
            where: { id: user.id },
            select: { fetchFavicons: true },
          });
          const tenantId = await resolveOwningTenantIdFromClient(tx, user.id);
          // Same fail-closed stance as the null-tenant throw below: a missing
          // user row on a successful query is corruption, not a default.
          if (!userRow) {
            throw new Error(`session passkey policy: user ${user.id} not found`);
          }
          // An unresolvable tenant is the same corruption case as the null row
          // below, so it throws here rather than becoming a `null` the guard
          // then has to distinguish.
          if (!tenantId) {
            throw new Error(`session passkey policy: tenant for user ${user.id} not resolved`);
          }
          // Bound to a plain identifier, and guarded on that same identifier
          // below. check-null-tenant-fail-closed resolves the binding, and a
          // tenant read buried in a conditional or an object literal is
          // UNGUARDED to it — measured, that shape failed the gate.
          const tenant = await tx.tenant.findUnique({
            where: { id: tenantId },
            select: {
              requirePasskey: true,
              requirePasskeyEnabledAt: true,
              passkeyGracePeriodDays: true,
            },
          });
          // FAIL-CLOSED on a null tenant: User.tenantId is a non-null FK
          // (onDelete: Restrict), so a null tenant on a SUCCESSFUL query means
          // the user row itself vanished mid-session (or FK-orphaned corruption)
          // — there is no policy to trust. Throw so this flows through the
          // fail-closed catch below (same stance as derivePasskeyState, which
          // throws on a missing tenant) rather than defaulting requirePasskey
          // to false (a fail-open on the success path).
          if (!tenant) {
            throw new Error(`session passkey policy: tenant for user ${user.id} not found`);
          }
          return { credCount, tenant, fetchFavicons: userRow.fetchFavicons };
        }, BYPASS_GRANT.AUTH_SESSION_PASSKEY_STATUS);

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
        // every consumer deciding on the raw fields refuses:
        // requirePasskey=true + hasPasskey=false +
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
        // The bundle is an outage, not a requirement: consumers still refuse
        // on it, but answer 503 rather than PASSKEY_REQUIRED, write no audit
        // row, and show no "register a passkey" verdict.
        passkeyStateDegraded = true;
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
          // A display verdict for the client, computed here on the server
          // clock so the browser never re-derives it. False for a degraded
          // bundle, which carries its own flag.
          passkeyBlocked:
            !passkeyStateDegraded &&
            passkeyEnforcementBlocks({
              hasPasskey,
              requirePasskey,
              requirePasskeyEnabledAt,
              passkeyGracePeriodDays,
            }),
          passkeyStateDegraded,
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
