import NextAuth from "next-auth";
import type { Account } from "next-auth";
import { createCustomAdapter } from "@/lib/auth/session/auth-adapter";
import { logAuditAsync } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { extractTenantClaimValue } from "@/lib/tenant/tenant-claim";
import { sessionMetaStorage } from "@/lib/auth/session/session-meta";
import { SESSION_ABSOLUTE_TIMEOUT_MAX } from "@/lib/validations/common";
import { tenantClaimStorage } from "@/lib/tenant/tenant-claim-storage";
import {
  resolveTenantByClaim,
  findOrCreateTenantForClaim,
  type ClaimTenantResolution,
} from "@/lib/tenant/tenant-management";
import { invalidateCachedSessions } from "@/lib/auth/session/session-cache-helpers";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { resolveUserTenantId, resolveUserTenantIdFromClient } from "@/lib/tenant-context";
import { getLogger } from "@/lib/logger";
import {
  emitAuthLoginFailure,
  type AuthProvider,
  type AuthLoginFailureReason,
} from "@/lib/audit/auth-failure";
import authConfig from "./auth.config";
import { TENANT_ROLE } from "@/lib/constants/auth/tenant-role";

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
      claim: string | null;
    };

// Deny reason per refusal arm of findOrCreateTenantForClaim (round-1 M2).
// The two arms have different triggers and different operator remedies, and
// collapsing them — as the single `null` used to — hid the one that matters
// most:
//   claim_taken   — a revoked tenant_claims row owns the claim (D2). Emitted
//                   as tenant_claim_unmapped because that is the reason
//                   `tenant-domain unmapped` filters on; without it a
//                   revoked-claim lockout is invisible to the tool this PR
//                   ships for exactly that diagnosis.
//   claim_invalid — the claim fails storableClaimSchema (SC9). Nothing is
//                   registrable, so "register the claim" is not the remedy;
//                   tenant_mismatch, as row 8b always specified.
const CLAIM_REFUSAL_REASON = {
  claim_taken: "tenant_claim_unmapped",
  claim_invalid: "tenant_mismatch",
} as const satisfies Record<
  Exclude<ClaimTenantResolution["kind"], "tenant">,
  Extract<AuthLoginFailureReason, "tenant_mismatch" | "tenant_claim_unmapped">
>;

export async function ensureTenantMembershipForSignIn(
  userId: string,
  account?: Account | null,
  profile?: Record<string, unknown> | null,
): Promise<SignInTenantResult> {
  const tenantClaim = extractTenantClaimValue(account, profile);
  if (!tenantClaim) {
    try {
      await resolveUserTenantId(userId);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED"
      ) {
        return { ok: false, reason: "tenant_mismatch", tenantId: null, claim: null };
      }
      throw error;
    }
    // Allow first-time sign-in without tenant claim.
    // Membership bootstrap is handled by the auth adapter createUser flow.
    return { ok: true };
  }

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
    const claimTenant = await resolveTenantByClaim(tenantClaim, tx);
    const existingTenantId = await resolveUserTenantIdFromClient(prisma, userId);

    if (existingTenantId === null) {
      // Rows 4 / 8: no existing membership. Join the claimed tenant,
      // creating it first if this is the first sign-in to see this claim.
      const target: ClaimTenantResolution = claimTenant
        ? { kind: "tenant", id: claimTenant.id }
        : await findOrCreateTenantForClaim(tenantClaim, tx);
      if (target.kind !== "tenant") {
        // Row 8b: the claim is unusable, so there is no tenant to join. The
        // reason distinguishes the two refusals (see CLAIM_REFUSAL_REASON) —
        // the storableClaimSchema arm is unreachable from sign-in today
        // (sanitizeTenantClaimValue already trims/bounds/rejects-empty), the
        // revoked-row arm is operator-reachable.
        return {
          ok: false,
          reason: CLAIM_REFUSAL_REASON[target.kind],
          tenantId: null,
          claim: tenantClaim,
        };
      }

      await tx.tenantMember.upsert({
        where: { tenantId_userId: { tenantId: target.id, userId } },
        create: { tenantId: target.id, userId, role: TENANT_ROLE.MEMBER },
        update: {},
      });
      return { ok: true };
    }

    if (claimTenant && existingTenantId === claimTenant.id) {
      // Row 5: already a member of the claimed tenant.
      await tx.tenantMember.upsert({
        where: { tenantId_userId: { tenantId: claimTenant.id, userId } },
        create: { tenantId: claimTenant.id, userId, role: TENANT_ROLE.MEMBER },
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
      //   - claimTenant resolved (row 7): this user belongs somewhere else,
      //     a tenant this deployment already knows -> tenant_mismatch.
      //   - claimTenant did not resolve (row 9b, the reported production
      //     bug): the IdP is sending a claim this deployment has not
      //     registered -> tenant_claim_unmapped. Distinct because the
      //     operator action differs (register the claim vs. investigate the
      //     user).
      return {
        ok: false,
        reason: claimTenant ? "tenant_mismatch" : "tenant_claim_unmapped",
        tenantId: existingTenantId,
        claim: tenantClaim,
      };
    }

    // Bootstrap tenant: eligible for one-time migration. Resolve (or, row
    // 9a, create) the target tenant now — creating here is on an ALLOW path,
    // which does not conflict with D2 (D2 is about writes on paths that go
    // on to deny). Row 9a is load-bearing (round-3 CR10): denying whenever
    // the claim is unresolved would regress the primary bootstrap->SSO
    // onboarding path (a magic-link user's first Google sign-in) into a hard
    // denial of the same NF2 shape as the bug this PR fixes.
    const target: ClaimTenantResolution = claimTenant
      ? { kind: "tenant", id: claimTenant.id }
      : await findOrCreateTenantForClaim(tenantClaim, tx);
    if (target.kind !== "tenant") {
      // Same refusal dispatch as row 8b, reached via the bootstrap branch.
      return {
        ok: false,
        reason: CLAIM_REFUSAL_REASON[target.kind],
        tenantId: existingTenantId,
        claim: tenantClaim,
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
      const auditProvider: AuthProvider =
        provider === "google"
          ? "google"
          : provider === "nodemailer"
            ? "nodemailer"
            : provider === "boxyhq-saml" || provider === "saml-jackson"
              ? "saml"
              : provider === "credentials"
                ? "credentials"
                : "unknown";

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
        const claim = extractTenantClaimValue(
          params.account,
          (params.profile ?? null) as Record<string, unknown> | null,
        );
        const store = tenantClaimStorage.getStore();
        if (store && claim) {
          store.tenantClaim = claim;
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
          });
        }
        return result.ok;
      } catch (error) {
        // MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED is handled inside
        // ensureTenantMembershipForSignIn and returns false (not thrown here).
        // Any other error is unexpected — log and block sign-in.
        getLogger().error(
          { err: error, provider: provider ?? "unknown" },
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
            err,
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
