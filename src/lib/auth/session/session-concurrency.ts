import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE, advisoryXactLock } from "@/lib/tenant-rls";
import { checkNewDeviceAndNotify } from "@/lib/auth/policy/new-device-detection";
import { hashSessionToken } from "@/lib/auth/session/session-cache";
import { invalidateCachedSessions } from "@/lib/auth/session/session-cache-helpers";
import { logAuditAsync } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { createNotification } from "@/lib/notification";
import {
  SESSION_IP_MAX_LENGTH,
  USER_AGENT_MAX_LENGTH,
} from "@/lib/validations/common.server";

/**
 * Shared capped Web-session creation, extracted from the adapter's
 * `createSession`. The two Web-session creators
 * — the Auth.js adapter (OAuth/SAML/magic-link) and the passkey sign-in route
 * — both delegate here so the concurrent-session cap has exactly one
 * implementation (R48: they cannot drift apart).
 *
 * `sessionToken` is the RAW cookie token; the digest is computed here (H4)
 * rather than threaded in pre-hashed, matching every other Session write in
 * the codebase (auth-adapter's own deleteSession/updateSession/
 * getSessionAndUser all hash locally from a raw value) and keeping the digest
 * computation and the DB write in the same reviewed place.
 */
export type CappedSessionInput = {
  userId: string;
  tenantId: string;
  sessionToken: string;
  expires: Date;
  ip: string | null;
  userAgent: string | null;
  provider: string | null;
  passkeyVerifiedAt?: Date;
  authCredentialId?: string;
};

export type SessionEviction = {
  tenantId: string;
  maxSessions: number;
  evicted: {
    id: string;
    sessionToken: string;
    ipAddress: string | null;
    userAgent: string | null;
  }[];
};

/**
 * Create a Session row under the tenant's concurrent-session cap.
 *
 * Precondition: `tx` is an already-open transaction (the caller's
 * `withBypassRls` scope) — this helper opens no RLS context itself. A
 * `withBypassRls` inside a `withBypassRls` is refused by the nesting guard,
 * so a caller that already holds a bypass transaction must pass its `tx`
 * straight through rather than opening a second one.
 */
export async function createSessionUnderConcurrencyCap(
  tx: Prisma.TransactionClient,
  input: CappedSessionInput,
): Promise<{
  session: { userId: string; expires: Date };
  eviction: SessionEviction | null;
}> {
  // Serialize concurrent session creation for this user so the
  // count-then-evict-then-create sequence cannot race past the concurrent
  // session cap (two concurrent sign-ins both reading count < max).
  // Advisory lock is transaction-scoped; matches the codebase idiom
  // (attachments, vault rotate-key).
  await advisoryXactLock(tx, input.userId);

  // Check tenant's concurrent session limit
  const tenant = await tx.tenant.findUnique({
    where: { id: input.tenantId },
    select: { maxConcurrentSessions: true },
  });

  // FAIL-CLOSED: tenantId comes from the adjudicator — the active
  // TenantMember, with User.tenantId as the fallback — and BOTH are
  // non-null FKs into tenants (TenantMember.tenantId ON DELETE CASCADE,
  // User.tenantId ON DELETE RESTRICT), so neither path can name a tenant
  // that is not there. A null row here is data corruption, NOT "no limit
  // configured" — an unconfigured limit is a real row with
  // maxConcurrentSessions=null.
  // Silently skipping the cap would let the corrupt-tenant user open
  // unbounded concurrent sessions. Throw so session creation refuses.
  // Matches the null-tenant fail-closed stance across the policy readers
  // (getTenantAccessPolicy, derivePasskeyState — PR #685 class).
  if (!tenant) {
    throw new Error(
      `createSessionUnderConcurrencyCap: tenant ${input.tenantId} not found`,
    );
  }

  let eviction: SessionEviction | null = null;
  const maxSessions = tenant.maxConcurrentSessions;
  if (maxSessions != null && maxSessions > 0) {
    // Count active sessions. Ordered by createdAt (F3-adj-1: Session.id is
    // uuid(4) — random — so "oldest" by id was arbitrary; the advisory lock
    // above already serializes this path, so the old "consistent lock
    // ordering" reason for id-ordering no longer applies). id is only the
    // tie-break for a total order (R57).
    const activeSessions = await tx.session.findMany({
      where: {
        userId: input.userId,
        tenantId: input.tenantId,
        expires: { gt: new Date() },
      },
      select: { id: true, sessionToken: true, ipAddress: true, userAgent: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    // Evict oldest sessions if at or over limit
    if (activeSessions.length >= maxSessions) {
      const toEvict = activeSessions.slice(0, activeSessions.length - maxSessions + 1);
      await tx.session.deleteMany({
        where: { id: { in: toEvict.map((s) => s.id) } },
      });

      eviction = { tenantId: input.tenantId, maxSessions, evicted: toEvict };
    }
  }

  const session = await tx.session.create({
    data: {
      // H4: store the digest, never the raw cookie token.
      sessionToken: hashSessionToken(input.sessionToken),
      userId: input.userId,
      tenantId: input.tenantId,
      expires: input.expires,
      ipAddress: input.ip?.slice(0, SESSION_IP_MAX_LENGTH) ?? null,
      userAgent: input.userAgent?.slice(0, USER_AGENT_MAX_LENGTH) ?? null,
      provider: input.provider,
      passkeyVerifiedAt: input.passkeyVerifiedAt ?? null,
      authCredentialId: input.authCredentialId ?? null,
    },
    select: {
      userId: true,
      expires: true,
    },
  });

  return { session, eviction };
}

/**
 * Report a session-cap eviction after the creating transaction has
 * committed: invalidate the cache, write one `SESSION_EVICTED` audit entry
 * per evicted session, and notify the user. Fire this only after the
 * transaction resolves — logAudit/createNotification use `withBypassRls`
 * internally, which conflicts with the parent's AsyncLocalStorage-based RLS
 * context if called from inside it.
 */
export async function reportSessionEviction(
  eviction: SessionEviction,
  ctx: { userId: string; ip: string | null; userAgent: string | null },
): Promise<void> {
  const { tenantId, maxSessions, evicted } = eviction;

  // Invalidate the cache BEFORE the audit/notification loop so the evicted
  // sessions stop being served from cache as quickly as possible.
  await invalidateCachedSessions(evicted.map((e) => e.sessionToken));
  for (const ev of evicted) {
    await logAuditAsync({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.SESSION_EVICTED,
      userId: ctx.userId,
      tenantId,
      targetType: AUDIT_TARGET_TYPE.SESSION,
      targetId: ev.id,
      metadata: {
        reason: "concurrent_session_limit",
        maxConcurrentSessions: maxSessions,
        newSessionIp: ctx.ip,
        newSessionUa: ctx.userAgent,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  createNotification({
    userId: ctx.userId,
    tenantId,
    type: "SESSION_EVICTED",
    title: "Session terminated",
    body: `${evicted.length} session(s) terminated due to concurrent session limit (max: ${maxSessions}).`,
    metadata: { evictedCount: evicted.length, maxConcurrentSessions: maxSessions },
  });
}

/**
 * The entry point both Web-session creators call: opens the bypass
 * transaction, creates the session under the cap, then — once it has
 * committed — fires the new-device check and reports any eviction.
 *
 * The transaction is opened HERE, not by the caller, so check-bypass-rls
 * sees the models this path touches under the bypass (a tx handed to an
 * imported callee is invisible to it). Keeping the post-commit work here too
 * means the adapter and the passkey route cannot drift on what a sign-in
 * notifies.
 */
export async function createCappedSession(
  input: CappedSessionInput & { acceptLanguage: string | null },
): Promise<{ userId: string; expires: Date }> {
  const { session, eviction } = await withBypassRls(
    prisma,
    async (tx) => createSessionUnderConcurrencyCap(tx, input),
    BYPASS_PURPOSE.AUTH_FLOW,
  );

  // Fire-and-forget: check for new device and notify user
  void checkNewDeviceAndNotify(input.userId, {
    ip: input.ip,
    userAgent: input.userAgent,
    acceptLanguage: input.acceptLanguage,
    currentSessionToken: input.sessionToken,
  });

  if (eviction) {
    await reportSessionEviction(eviction, {
      userId: input.userId,
      ip: input.ip,
      userAgent: input.userAgent,
    });
  }

  return session;
}
