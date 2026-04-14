import { PrismaAdapter } from "@auth/prisma-adapter";
import type { Adapter, AdapterSession, AdapterUser, AdapterAccount } from "next-auth/adapters";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sessionMetaStorage } from "@/lib/session-meta";
import { tenantClaimStorage } from "@/lib/tenant-claim-storage";
import { findOrCreateSsoTenant } from "@/lib/tenant-management";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { randomUUID } from "node:crypto";
import { checkNewDeviceAndNotify } from "@/lib/new-device-detection";
import { USER_AGENT_MAX_LENGTH, BOOTSTRAP_SLUG_HASH_LENGTH } from "@/lib/validations/common.server";
import { logAuditAsync } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { createNotification } from "@/lib/notification";
import { getStrictestSessionDuration } from "@/lib/team-policy";

/**
 * Custom Auth.js adapter that extends PrismaAdapter with:
 * - createSession: captures IP/UA from AsyncLocalStorage
 * - updateSession: updates lastActiveAt on session refresh
 */
export function createCustomAdapter(): Adapter {
  const base = PrismaAdapter(prisma);

  async function resolveTenantIdForUser(userId: string): Promise<string> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { tenantId: true },
    });
    if (!user) {
      throw new Error("USER_NOT_FOUND");
    }
    return user.tenantId;
  }

  return {
    ...base,

    // All auth tables have RLS tenant_isolation policies. During auth flows
    // (OAuth callback, session checks, sign-out) no tenant context is set,
    // so current_setting('app.tenant_id')::uuid casts '' → error.
    // Override every base method that touches RLS-protected tables.

    async getUser(id: string): Promise<AdapterUser | null> {
      const user = await withBypassRls(prisma, async () =>
        prisma.user.findUnique({
          where: { id },
          select: { id: true, name: true, email: true, image: true, emailVerified: true },
        }),
      BYPASS_PURPOSE.AUTH_FLOW);
      if (!user?.email) return null;
      return { id: user.id, name: user.name, email: user.email, image: user.image, emailVerified: user.emailVerified };
    },

    async getUserByEmail(email: string): Promise<AdapterUser | null> {
      const user = await withBypassRls(prisma, async () =>
        prisma.user.findUnique({
          where: { email },
          select: { id: true, name: true, email: true, image: true, emailVerified: true },
        }),
      BYPASS_PURPOSE.AUTH_FLOW);
      if (!user?.email) return null;
      return { id: user.id, name: user.name, email: user.email, image: user.image, emailVerified: user.emailVerified };
    },

    async getUserByAccount(
      providerAccountId: Pick<AdapterAccount, "provider" | "providerAccountId">,
    ) {
      // RLS requires tenant_id context; during OAuth callback no user is
      // identified yet, so bypass RLS to avoid "invalid uuid: ''" cast error.
      const account = await withBypassRls(prisma, async () =>
        prisma.account.findUnique({
          where: {
            provider_providerAccountId: {
              provider: providerAccountId.provider,
              providerAccountId: providerAccountId.providerAccountId,
            },
          },
          select: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
                emailVerified: true,
              },
            },
          },
        }),
      BYPASS_PURPOSE.AUTH_FLOW);
      if (!account?.user?.email) return null;
      return {
        id: account.user.id,
        name: account.user.name,
        email: account.user.email,
        image: account.user.image,
        emailVerified: account.user.emailVerified,
      };
    },

    async getSessionAndUser(
      sessionToken: string,
    ): Promise<{ session: AdapterSession; user: AdapterUser } | null> {
      const result = await withBypassRls(prisma, async () =>
        prisma.session.findUnique({
          where: { sessionToken },
          select: {
            sessionToken: true,
            userId: true,
            expires: true,
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
                emailVerified: true,
              },
            },
          },
        }),
      BYPASS_PURPOSE.AUTH_FLOW);
      if (!result || !result.user.email) return null;

      return {
        session: {
          sessionToken: result.sessionToken,
          userId: result.userId,
          expires: result.expires,
        },
        user: {
          id: result.user.id,
          name: result.user.name,
          email: result.user.email,
          image: result.user.image,
          emailVerified: result.user.emailVerified,
        },
      };
    },

    async createUser(
      user: Omit<AdapterUser, "id">,
    ): Promise<AdapterUser> {
      // Read tenant claim stored by signIn callback (e.g. Google hd).
      // If present, place user directly into the SSO tenant.
      const pendingClaim = tenantClaimStorage.getStore()?.tenantClaim ?? null;

      const created = await withBypassRls(prisma, async () => {
        // Resolve SSO tenant inside withBypassRls (no nesting)
        let ssoTenant: { id: string } | null = null;
        if (pendingClaim) {
          ssoTenant = await findOrCreateSsoTenant(pendingClaim);
        }

        return prisma.$transaction(async (tx) => {
          const tenant = ssoTenant
            ?? await tx.tenant.create({
                data: {
                  name: user.email ?? user.name ?? "User",
                  slug: `bootstrap-${randomUUID().replace(/-/g, "").slice(0, BOOTSTRAP_SLUG_HASH_LENGTH)}`,
                  isBootstrap: true,
                },
                select: { id: true },
              });

          const createdUser = await tx.user.create({
            data: {
              name: user.name,
              email: user.email,
              image: user.image,
              emailVerified: user.emailVerified,
              tenantId: tenant.id,
            },
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
              emailVerified: true,
            },
          });

          await tx.tenantMember.create({
            data: {
              tenantId: tenant.id,
              userId: createdUser.id,
              role: ssoTenant ? "MEMBER" : "OWNER",
            },
          });

          return createdUser;
        });
      }, BYPASS_PURPOSE.AUTH_FLOW);
      if (!created.email) {
        throw new Error("USER_EMAIL_MISSING");
      }

      return {
        id: created.id,
        name: created.name,
        email: created.email,
        image: created.image,
        emailVerified: created.emailVerified,
      };
    },

    async linkAccount(
      account: AdapterAccount,
    ): Promise<void> {
      await withBypassRls(prisma, async () => {
        const tenantId = await resolveTenantIdForUser(account.userId);

        await prisma.account.create({
          data: {
            userId: account.userId,
            tenantId,
            type: account.type,
            provider: account.provider,
            providerAccountId: account.providerAccountId,
            refresh_token: account.refresh_token,
            access_token: account.access_token,
            expires_at: account.expires_at,
            token_type: account.token_type,
            scope: account.scope,
            id_token: account.id_token,
            session_state: account.session_state
              ? String(account.session_state)
              : null,
          },
          select: { id: true },
        });
      }, BYPASS_PURPOSE.AUTH_FLOW);
    },

    async createSession(
      session: { sessionToken: string; userId: string; expires: Date },
    ): Promise<AdapterSession> {
      const meta = sessionMetaStorage.getStore();
      // Collect eviction info to fire audit/notification outside the transaction
      // (logAudit/createNotification use withBypassRls internally, which conflicts
      // with the parent's AsyncLocalStorage-based RLS context if called inside)
      let evictionInfo: {
        tenantId: string;
        maxSessions: number;
        evicted: { id: string; ipAddress: string | null; userAgent: string | null }[];
      } | null = null;

      const created = await withBypassRls(prisma, async () => {
        const tenantId = await resolveTenantIdForUser(session.userId);

        // Serializable prevents TOCTOU in concurrent session counting
        return prisma.$transaction(async (tx) => {
          // Check tenant's concurrent session limit
          const tenant = await tx.tenant.findUnique({
            where: { id: tenantId },
            select: { maxConcurrentSessions: true },
          });

          const maxSessions = tenant?.maxConcurrentSessions;
          if (maxSessions != null && maxSessions > 0) {
            // Count active sessions (ORDER BY id for consistent lock ordering)
            const activeSessions = await tx.session.findMany({
              where: {
                userId: session.userId,
                tenantId,
                expires: { gt: new Date() },
              },
              select: { id: true, ipAddress: true, userAgent: true },
              orderBy: { id: "asc" },
            });

            // Evict oldest sessions if at or over limit
            if (activeSessions.length >= maxSessions) {
              const toEvict = activeSessions.slice(0, activeSessions.length - maxSessions + 1);
              await tx.session.deleteMany({
                where: { id: { in: toEvict.map((s) => s.id) } },
              });

              evictionInfo = { tenantId, maxSessions, evicted: toEvict };
            }
          }

          return tx.session.create({
            data: {
              sessionToken: session.sessionToken,
              userId: session.userId,
              tenantId,
              expires: session.expires,
              ipAddress: meta?.ip ?? null,
              userAgent: meta?.userAgent?.slice(0, USER_AGENT_MAX_LENGTH) ?? null,
            },
            select: {
              sessionToken: true,
              userId: true,
              expires: true,
            },
          });
        }, { isolationLevel: "Serializable" });
      }, BYPASS_PURPOSE.AUTH_FLOW);

      // Fire-and-forget: check for new device and notify user
      void checkNewDeviceAndNotify(session.userId, {
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
        acceptLanguage: meta?.acceptLanguage ?? null,
        currentSessionToken: session.sessionToken,
      });

      // Fire audit + notification outside the RLS transaction context
      if (evictionInfo) {
        const { tenantId, maxSessions, evicted } = evictionInfo as {
          tenantId: string;
          maxSessions: number;
          evicted: { id: string; ipAddress: string | null; userAgent: string | null }[];
        };
        for (const ev of evicted) {
          await logAuditAsync({
            scope: AUDIT_SCOPE.PERSONAL,
            action: AUDIT_ACTION.SESSION_EVICTED,
            userId: session.userId,
            tenantId,
            targetType: AUDIT_TARGET_TYPE.SESSION,
            targetId: ev.id,
            metadata: {
              reason: "concurrent_session_limit",
              maxConcurrentSessions: maxSessions,
              newSessionIp: meta?.ip ?? null,
              newSessionUa: meta?.userAgent ?? null,
            },
            ip: meta?.ip ?? null,
            userAgent: meta?.userAgent ?? null,
          });
        }

        createNotification({
          userId: session.userId,
          tenantId,
          type: "SESSION_EVICTED",
          title: "Session terminated",
          body: `${evicted.length} session(s) terminated due to concurrent session limit (max: ${maxSessions}).`,
          metadata: { evictedCount: evicted.length, maxConcurrentSessions: maxSessions },
        });
      }

      return {
        sessionToken: created.sessionToken,
        userId: created.userId,
        expires: created.expires,
      };
    },

    async updateUser(data: Partial<AdapterUser> & Pick<AdapterUser, "id">): Promise<AdapterUser> {
      const { id, ...rest } = data;
      const updated = await withBypassRls(prisma, async () =>
        prisma.user.update({
          where: { id },
          data: rest,
          select: { id: true, name: true, email: true, image: true, emailVerified: true },
        }),
      BYPASS_PURPOSE.AUTH_FLOW);
      if (!updated.email) throw new Error("USER_EMAIL_MISSING");
      return { id: updated.id, name: updated.name, email: updated.email, image: updated.image, emailVerified: updated.emailVerified };
    },

    async deleteUser(userId: string) {
      await withBypassRls(prisma, async () =>
        prisma.user.delete({ where: { id: userId } }),
      BYPASS_PURPOSE.AUTH_FLOW);
    },

    async unlinkAccount(providerAccountId: Pick<AdapterAccount, "provider" | "providerAccountId">) {
      await withBypassRls(prisma, async () =>
        prisma.account.delete({
          where: {
            provider_providerAccountId: {
              provider: providerAccountId.provider,
              providerAccountId: providerAccountId.providerAccountId,
            },
          },
        }),
      BYPASS_PURPOSE.AUTH_FLOW);
    },

    async deleteSession(sessionToken: string) {
      await withBypassRls(prisma, async () =>
        prisma.session.delete({ where: { sessionToken } }),
      BYPASS_PURPOSE.AUTH_FLOW);
    },

    async getAccount(providerAccountId: string, provider: string): Promise<AdapterAccount | null> {
      const account = await withBypassRls(prisma, async () =>
        prisma.account.findFirst({
          where: { providerAccountId, provider },
          select: {
            userId: true,
            type: true,
            provider: true,
            providerAccountId: true,
            refresh_token: true,
            access_token: true,
            expires_at: true,
            token_type: true,
            scope: true,
            id_token: true,
            session_state: true,
          },
        }),
      BYPASS_PURPOSE.AUTH_FLOW);
      if (!account) return null;
      return {
        userId: account.userId,
        type: account.type as AdapterAccount["type"],
        provider: account.provider,
        providerAccountId: account.providerAccountId,
        refresh_token: account.refresh_token ?? undefined,
        access_token: account.access_token ?? undefined,
        expires_at: account.expires_at ?? undefined,
        token_type: (account.token_type ?? undefined) as Lowercase<string> | undefined,
        scope: account.scope ?? undefined,
        id_token: account.id_token ?? undefined,
        session_state: account.session_state ?? undefined,
      };
    },

    async updateSession(
      session: Partial<AdapterSession> & Pick<AdapterSession, "sessionToken">,
    ): Promise<AdapterSession | null | undefined> {
      try {
        // Read current session + tenant in a single query
        const current = await withBypassRls(prisma, async () =>
          prisma.session.findUnique({
            where: { sessionToken: session.sessionToken },
            select: {
              userId: true,
              createdAt: true,
              lastActiveAt: true,
              tenantId: true,
              tenant: { select: { sessionIdleTimeoutMinutes: true } },
            },
          }),
        BYPASS_PURPOSE.AUTH_FLOW);

        if (!current) return null;

        // Check idle timeout before refreshing the session
        if (current.lastActiveAt && current.tenantId) {
          const timeout = current.tenant?.sessionIdleTimeoutMinutes;
          if (timeout != null && timeout > 0) {
            const idleSince = Date.now() - current.lastActiveAt.getTime();
            if (idleSince > timeout * 60_000) {
              // Session exceeded idle timeout — delete and return null (forces sign-out)
              await withBypassRls(prisma, async () =>
                prisma.session.delete({
                  where: { sessionToken: session.sessionToken },
                }),
              BYPASS_PURPOSE.AUTH_FLOW);
              return null;
            }
          }
        }

        // Team session duration enforcement
        if (current.userId) {
          const maxDuration = await getStrictestSessionDuration(current.userId);
          if (maxDuration !== null && current.createdAt) {
            const sessionAgeMs = Date.now() - current.createdAt.getTime();
            if (sessionAgeMs > maxDuration * 60_000) {
              await withBypassRls(
                prisma,
                () => prisma.session.delete({ where: { sessionToken: session.sessionToken } }),
                BYPASS_PURPOSE.AUTH_FLOW,
              );
              await logAuditAsync({
                scope: AUDIT_SCOPE.PERSONAL,
                action: AUDIT_ACTION.SESSION_REVOKE,
                userId: current.userId,
                metadata: {
                  reason: "team_session_duration_exceeded",
                  maxDurationMinutes: maxDuration,
                },
              });
              return null;
            }
          }
        }

        // Session is still valid — update lastActiveAt
        const updated = await withBypassRls(prisma, async () =>
          prisma.session.update({
            where: { sessionToken: session.sessionToken },
            data: {
              ...(session.expires ? { expires: session.expires } : {}),
              lastActiveAt: new Date(),
            },
            select: {
              sessionToken: true,
              userId: true,
              expires: true,
            },
          }),
        BYPASS_PURPOSE.AUTH_FLOW);

        return {
          sessionToken: updated.sessionToken,
          userId: updated.userId,
          expires: updated.expires,
        };
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2025"
        ) {
          return null;
        }
        throw err;
      }
    },
  };
}
