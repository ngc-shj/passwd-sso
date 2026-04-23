import NextAuth from "next-auth";
import type { Account } from "next-auth";
import { createCustomAdapter } from "@/lib/auth-adapter";
import { logAuditAsync } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { extractTenantClaimValue } from "@/lib/tenant-claim";
import { sessionMetaStorage } from "@/lib/auth/session-meta";
import { SESSION_ABSOLUTE_TIMEOUT_MAX } from "@/lib/validations/common";
import { tenantClaimStorage } from "@/lib/tenant-claim-storage";
import { findOrCreateSsoTenant } from "@/lib/tenant-management";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { resolveUserTenantId, resolveUserTenantIdFromClient } from "@/lib/tenant-context";
import { getLogger } from "@/lib/logger";
import authConfig from "./auth.config";
import { TENANT_ROLE } from "@/lib/constants/tenant-role";

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

export async function ensureTenantMembershipForSignIn(
  userId: string,
  account?: Account | null,
  profile?: Record<string, unknown> | null,
): Promise<boolean> {
  const tenantClaim = extractTenantClaimValue(account, profile);
  if (!tenantClaim) {
    try {
      await resolveUserTenantId(userId);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED"
      ) {
        return false;
      }
      throw error;
    }
    // Allow first-time sign-in without tenant claim.
    // Membership bootstrap is handled by the auth adapter createUser flow.
    return true;
  }

  const tenant = await withBypassRls(prisma, async () => {
    const found = await findOrCreateSsoTenant(tenantClaim);

    if (!found) return null;

    const existingTenantId = await resolveUserTenantIdFromClient(prisma, userId);

    // Single-tenant sign-in policy: reject cross-tenant login.
    if (existingTenantId && existingTenantId !== found.id) {
      const existingTenant = await prisma.tenant.findUnique({
        where: { id: existingTenantId },
        select: { isBootstrap: true },
      });
      const isBootstrapTenant = !!existingTenant?.isBootstrap;
      // Allow one-time migration from bootstrap tenant to IdP tenant.
      if (isBootstrapTenant) {
        await prisma.$transaction(async (tx) => {
          await assertBootstrapSingleMember(tx, existingTenantId);

          // Migrate user and account rows
          await tx.user.update({
            where: { id: userId },
            data: { tenantId: found.id },
          });

          await tx.account.updateMany({
            where: { userId },
            data: { tenantId: found.id },
          });

          // Migrate all tenant-scoped data tables
          await tx.passwordEntry.updateMany({
            where: { userId, tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.tag.updateMany({
            where: { userId, tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.folder.updateMany({
            where: { userId, tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.session.updateMany({
            where: { userId, tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.extensionToken.updateMany({
            where: { userId, tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.passwordEntryHistory.updateMany({
            where: { tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.vaultKey.updateMany({
            where: { userId, tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.auditLog.updateMany({
            where: { userId, tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.emergencyAccessGrant.updateMany({
            where: { ownerId: userId, tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          // emergencyAccessKeyPair/shareAccessLog have no userId column;
          // safe because bootstrap tenants are single-user by design.
          await tx.emergencyAccessKeyPair.updateMany({
            where: { tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.passwordShare.updateMany({
            where: { createdById: userId, tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.shareAccessLog.updateMany({
            where: { tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.attachment.updateMany({
            where: { createdById: userId, tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.notification.updateMany({
            where: { userId, tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.apiKey.updateMany({
            where: { userId, tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.webAuthnCredential.updateMany({
            where: { userId, tenantId: existingTenantId },
            data: { tenantId: found.id },
          });

          // Create membership in new tenant and remove old
          await tx.tenantMember.upsert({
            where: {
              tenantId_userId: {
                tenantId: found.id,
                userId,
              },
            },
            create: {
              tenantId: found.id,
              userId,
              role: TENANT_ROLE.MEMBER,
            },
            update: {},
          });

          await tx.tenantMember.deleteMany({
            where: { userId, tenantId: existingTenantId },
          });
        });

        // Bootstrap migration complete — skip redundant upsert below
        return found;
      } else {
        return null;
      }
    }

    await prisma.tenantMember.upsert({
      where: {
        tenantId_userId: {
          tenantId: found.id,
          userId,
        },
      },
      create: {
        tenantId: found.id,
        userId,
        role: TENANT_ROLE.MEMBER,
      },
      update: {},
    });

    return found;
  }, BYPASS_PURPOSE.AUTH_FLOW);

  return !!tenant;
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
      const baseSignIn = authConfig.callbacks?.signIn;
      if (baseSignIn) {
        const baseResult = await baseSignIn(params);
        if (!baseResult) return false;
      }

      // Reject nodemailer for SSO tenant users.
      // Magic Link is for individual (bootstrap tenant) users only.
      // Prevents bypassing SSO policy via direct API calls.
      // Note: WebAuthn sign-in uses a custom route (/api/auth/passkey/verify)
      // that has its own SSO tenant guard, bypassing Auth.js entirely.
      const provider = params.account?.provider;

      // Propagate provider to the adapter via sessionMetaStorage so
      // createSession can record Session.provider for AAL3 enforcement.
      // The meta object is the one established by withSessionMeta at the
      // route handler entry; AsyncLocalStorage returns the same reference
      // throughout the async chain, so mutating it is the intended pattern.
      const meta = sessionMetaStorage.getStore();
      if (meta) meta.provider = provider ?? null;
      if (provider === "nodemailer") {
        // Nodemailer requires email by definition. Block null-email as a safeguard.
        if (!params.user?.email) return false;

        const existingUser = await withBypassRls(prisma, async () =>
          prisma.user.findUnique({
            where: { email: params.user.email! },
            select: {
              id: true,
              tenant: { select: { isBootstrap: true } },
            },
          }),
        BYPASS_PURPOSE.AUTH_FLOW);
        // Existing user in a non-bootstrap (SSO) tenant → reject
        if (existingUser?.tenant && !existingUser.tenant.isBootstrap) {
          return false;
        }
      }

      // Always verify user exists in DB — Auth.js may provide a pre-generated
      // id before the user row is actually inserted (new OAuth sign-in).
      let userId: string | null = null;
      const lookupEmail = params.user?.email;
      if (lookupEmail) {
        const existing = await withBypassRls(prisma, async () =>
          prisma.user.findUnique({
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
        const ok = await ensureTenantMembershipForSignIn(
          userId,
          params.account,
          (params.profile ?? null) as Record<string, unknown> | null,
        );
        return ok;
      } catch (error) {
        // MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED is handled inside
        // ensureTenantMembershipForSignIn and returns false (not thrown here).
        // Any other error is unexpected — log and block sign-in.
        getLogger().error(
          { err: error, provider: provider ?? "unknown" },
          "auth.signin.ensureTenantMembership_failed",
        );
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
      try {
        const passkeyData = await withBypassRls(prisma, async () => {
          const [credCount, tenant] = await Promise.all([
            prisma.webAuthnCredential.count({ where: { userId: user.id } }),
            prisma.user.findUnique({
              where: { id: user.id },
              select: {
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
          return { credCount, tenant: tenant?.tenant ?? null };
        }, BYPASS_PURPOSE.AUTH_FLOW);

        hasPasskey = passkeyData.credCount > 0;
        requirePasskey = passkeyData.tenant?.requirePasskey ?? false;
        requirePasskeyEnabledAt = passkeyData.tenant?.requirePasskeyEnabledAt?.toISOString() ?? null;
        passkeyGracePeriodDays = passkeyData.tenant?.passkeyGracePeriodDays ?? null;
      } catch {
        // Non-critical: passkey enforcement data failure should not break session
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
