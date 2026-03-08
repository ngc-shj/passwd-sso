import { PrismaAdapter } from "@auth/prisma-adapter";
import type { Adapter, AdapterSession, AdapterUser, AdapterAccount } from "next-auth/adapters";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sessionMetaStorage } from "@/lib/session-meta";
import { withBypassRls } from "@/lib/tenant-rls";
import { randomUUID } from "node:crypto";
import { checkNewDeviceAndNotify } from "@/lib/new-device-detection";
import { logAudit } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { createNotification } from "@/lib/notification";

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
      );
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
      const created = await withBypassRls(prisma, async () =>
        prisma.$transaction(async (tx) => {
          const tenant = await tx.tenant.create({
            data: {
              name: user.email ?? user.name ?? "User",
              slug: `bootstrap-${randomUUID().replace(/-/g, "").slice(0, 24)}`,
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
              role: "OWNER",
            },
          });

          return createdUser;
        }),
      );
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
      });
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
              userAgent: meta?.userAgent?.slice(0, 512) ?? null,
            },
            select: {
              sessionToken: true,
              userId: true,
              expires: true,
            },
          });
        }, { isolationLevel: "Serializable" });
      });

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
          logAudit({
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

    async updateSession(
      session: Partial<AdapterSession> & Pick<AdapterSession, "sessionToken">,
    ): Promise<AdapterSession | null | undefined> {
      try {
        // Read current session BEFORE updating lastActiveAt so we can check idle timeout
        const current = await withBypassRls(prisma, async () =>
          prisma.session.findUnique({
            where: { sessionToken: session.sessionToken },
            select: {
              lastActiveAt: true,
              tenantId: true,
            },
          }),
        );

        if (!current) return null;

        // Check idle timeout before refreshing the session
        if (current.lastActiveAt && current.tenantId) {
          const tenant = await withBypassRls(prisma, async () =>
            prisma.tenant.findUnique({
              where: { id: current.tenantId! },
              select: { sessionIdleTimeoutMinutes: true },
            }),
          );

          const timeout = tenant?.sessionIdleTimeoutMinutes;
          if (timeout != null && timeout > 0) {
            const idleSince = Date.now() - current.lastActiveAt.getTime();
            if (idleSince > timeout * 60_000) {
              // Session exceeded idle timeout — delete and return null (forces sign-out)
              await withBypassRls(prisma, async () =>
                prisma.session.delete({
                  where: { sessionToken: session.sessionToken },
                }),
              );
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
        );

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
