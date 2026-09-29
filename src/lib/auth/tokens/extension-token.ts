import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateShareToken, hashToken } from "@/lib/crypto/crypto-server";
import { withBypassRls, BYPASS_PURPOSE, advisoryXactLock } from "@/lib/tenant-rls";
import { withUserTenantRls } from "@/lib/tenant-context";
import { randomUUID } from "node:crypto";
import {
  CLIENT_TOKEN_MAX_ACTIVE_FAMILIES,
  type ExtensionTokenScope,
} from "@/lib/constants";
import { computeClientTokenExpiry, getFamilyPresenceAt } from "@/lib/auth/tokens/client-token-expiry";
import type { Prisma } from "@prisma/client";
import {
  EXTENSION_TOKEN_IDLE_TIMEOUT_DEFAULT,
  EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_DEFAULT,
} from "@/lib/validations/common";
import { logAuditAsync } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { validateExtensionTokenDpop } from "@/lib/auth/dpop/validate-token-dpop";

// ─── Types and helpers (re-exported from the leaf module for source-compat) ──

export type {
  ValidatedExtensionToken,
  TokenValidationError,
  TokenValidationResult,
} from "@/lib/auth/tokens/extension-token-types";
export { parseScopes } from "@/lib/auth/tokens/extension-token-types";

// ─── Helpers ─────────────────────────────────────────────────

function extractBearer(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() ?? null;
}

export function hasScope(
  scopes: ExtensionTokenScope[],
  required: ExtensionTokenScope,
): boolean {
  return scopes.includes(required);
}

// ─── Validation ──────────────────────────────────────────────

/**
 * Validate an extension token from the Authorization header.
 * Returns a discriminated union so callers can map errors to HTTP status/codes.
 *
 * Dispatch:
 *  - `clientKind === 'IOS_APP'`: defers to `validateExtensionTokenDpop` from
 *    `dpop/validate-token-dpop.ts`, which requires a valid DPoP proof bound
 *    to the row's `cnfJkt`. IOS_APP rows without cnfJkt are rejected early.
 *    IP / user-agent are updated on success.
 *  - `clientKind === 'BROWSER_EXTENSION'` (and `'IOS_AUTOFILL'`, which takes
 *    the same else-branch): ALWAYS requires a valid DPoP proof (no bearer-only
 *    fallback — cnfJkt is NOT NULL for all BROWSER_EXTENSION rows
 *    post-migration, and is set at mint for every IOS_AUTOFILL row). IP /
 *    user-agent are NOT updated (browser rows historically left those fields
 *    NULL).
 *
 * On success, updates `lastUsedAt` (best-effort, non-blocking).
 */
export async function validateExtensionToken(
  req: NextRequest,
): Promise<import("@/lib/auth/tokens/extension-token-types").TokenValidationResult> {
  const plaintext = extractBearer(req);
  if (!plaintext) {
    return { ok: false, error: "EXTENSION_TOKEN_INVALID" };
  }

  const tokenHash = hashToken(plaintext);

  const token = await withBypassRls(prisma, async (tx) =>
    tx.extensionToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        tenantId: true,
        scope: true,
        expiresAt: true,
        revokedAt: true,
        familyId: true,
        familyCreatedAt: true,
        clientKind: true,
        cnfJkt: true,
      },
    }),
  BYPASS_PURPOSE.TOKEN_LIFECYCLE);

  if (!token) {
    return { ok: false, error: "EXTENSION_TOKEN_INVALID" };
  }
  if (token.revokedAt) {
    return { ok: false, error: "EXTENSION_TOKEN_REVOKED" };
  }
  if (token.expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: "EXTENSION_TOKEN_EXPIRED" };
  }

  // C13: reject deactivated users — tenant-scoped to the token's own tenant.
  // Fail-closed: no active membership row ⇒ invalid (cross-tenant bypass guard).
  const member = await withBypassRls(prisma, async (tx) =>
    tx.tenantMember.findUnique({
      where: { tenantId_userId: { tenantId: token.tenantId, userId: token.userId } },
      select: { deactivatedAt: true },
    }),
  BYPASS_PURPOSE.TOKEN_LIFECYCLE);
  if (!member || member.deactivatedAt !== null) {
    return { ok: false, error: "EXTENSION_TOKEN_INVALID" };
  }

  // ── iOS-host-app dispatch ──────────────────────────────────
  // IOS_APP rows without cnfJkt cannot be DPoP-validated; reject early
  // so ValidatedExtensionToken.cnfJkt is always non-null by construction.
  if (token.clientKind === "IOS_APP") {
    if (!token.cnfJkt) {
      return { ok: false, error: "EXTENSION_TOKEN_INVALID" };
    }
    const dpopResult = await validateExtensionTokenDpop({
      req,
      accessToken: plaintext,
      row: {
        id: token.id,
        userId: token.userId,
        tenantId: token.tenantId,
        cnfJkt: token.cnfJkt,
        scope: token.scope,
        expiresAt: token.expiresAt,
        familyId: token.familyId,
        familyCreatedAt: token.familyCreatedAt,
        clientKind: token.clientKind,
      },
    });
    if (dpopResult.ok) return { ok: true, data: dpopResult.data };
    // Map DPoP failures to EXTENSION_TOKEN_INVALID so legacy callers
    // (which look up API_ERROR[result.error]) keep type-checking. Routes
    // that need granular DPoP error reporting call validateExtensionTokenDpop
    // directly with the row + access token.
    return { ok: false, error: "EXTENSION_TOKEN_INVALID" };
  }

  // ── BROWSER_EXTENSION: DPoP always required ────────────────
  // cnfJkt is NOT NULL for all BROWSER_EXTENSION rows post-migration.
  // The partial CHECK constraint enforces this at the DB layer.
  const cnfJkt = token.cnfJkt;
  if (!cnfJkt) {
    // Should not happen post-migration; defensive guard.
    return { ok: false, error: "EXTENSION_TOKEN_INVALID" };
  }

  const dpopResult = await validateExtensionTokenDpop({
    req,
    accessToken: plaintext,
    row: {
      id: token.id,
      userId: token.userId,
      tenantId: token.tenantId,
      cnfJkt,
      scope: token.scope,
      expiresAt: token.expiresAt,
      familyId: token.familyId,
      familyCreatedAt: token.familyCreatedAt,
      clientKind: token.clientKind,
    },
  });

  if (!dpopResult.ok) {
    return {
      ok: false,
      error: "EXTENSION_TOKEN_DPOP_INVALID",
      dpopError: dpopResult.dpopError,
    };
  }
  return { ok: true, data: dpopResult.data };
}

// ─── Family revocation reasons + active-family cap ──────────

export const EXTENSION_TOKEN_REVOKE_REASON = {
  FAMILY_EXPIRED: "family_expired",
  PRESENCE_EXPIRED: "presence_expired",
  REPLAY_DETECTED: "replay_detected",
  SIGN_OUT_EVERYWHERE: "sign_out_everywhere",
  SUPERSEDED_SAME_DEVICE: "superseded_same_device",
  ACTIVE_FAMILY_CAP: "active_family_cap",
  USER_DELETE: "user_delete",
} as const;

export type ExtensionTokenFamilyRevokeReason = (typeof EXTENSION_TOKEN_REVOKE_REASON)[keyof typeof EXTENSION_TOKEN_REVOKE_REASON];

export interface RevokedFamily {
  familyId: string;
  reason: ExtensionTokenFamilyRevokeReason;
  rowsRevoked: number;
}

/**
 * Post-commit audit emission for revoked families. Shared by
 * `revokeExtensionTokenFamily` (single family, its own transaction) and the
 * three issuers below (families revoked inside their own issuance
 * transaction, emitted once it has committed).
 */
export async function emitRevokedFamilyAudits(
  revoked: RevokedFamily[],
  ctx: { userId: string; tenantId: string },
): Promise<void> {
  for (const { familyId, reason, rowsRevoked } of revoked) {
    await logAuditAsync({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.EXTENSION_TOKEN_FAMILY_REVOKED,
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      targetType: AUDIT_TARGET_TYPE.EXTENSION_TOKEN,
      targetId: familyId,
      metadata: {
        reason,
        familyId,
        rowsRevoked,
      },
    });
  }
}

/**
 * Enforce the per-user active-device-family cap ahead of issuing a new
 * BROWSER_EXTENSION or IOS_APP family. Two steps, both inside the caller's
 * transaction:
 *
 *  1. Supersede: an active family with the same `userId` + `clientKind` +
 *     `cnfJkt` is the same install reconnecting — revoke it instead of
 *     letting it consume a cap slot. A family whose revoke touches 0 rows
 *     (already fully revoked) is not returned, mirroring
 *     `revokeExtensionTokenFamily`'s `count > 0` audit guard.
 *  2. Cap: membership is the active (non-expired, non-revoked) rows with
 *     `clientKind !== IOS_AUTOFILL`, grouped by family. Each family's
 *     presence comes from `getFamilyPresenceAt`, which reads over ALL of the
 *     family's rows (not just the active ones) — an iOS family's presence
 *     write can sit on its already-expired 24h access row while the refresh
 *     row is still live. Families are ordered by presence ascending, then
 *     `familyId` ascending as a total-order tie-break, and the oldest is
 *     evicted while `families + 1` (the new family about to be created)
 *     exceeds the cap.
 *
 * Precondition: the caller has already taken `advisoryXactLock(tx, userId)`
 * in this same transaction — this function does not re-acquire it.
 */
export async function enforceActiveFamilyCap(
  tx: Prisma.TransactionClient,
  params: {
    userId: string;
    clientKind: "BROWSER_EXTENSION" | "IOS_APP";
    cnfJkt: string;
    now: Date;
  },
): Promise<RevokedFamily[]> {
  const { userId, clientKind, cnfJkt, now } = params;
  const revoked: RevokedFamily[] = [];

  // ── Step 1: supersede same-install reconnect ──────────────
  const supersedeFamilies = await tx.extensionToken.findMany({
    where: { userId, clientKind, cnfJkt, revokedAt: null },
    select: { familyId: true },
    distinct: ["familyId"],
  });
  for (const { familyId } of supersedeFamilies) {
    const result = await tx.extensionToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    });
    if (result.count > 0) {
      revoked.push({
        familyId,
        reason: EXTENSION_TOKEN_REVOKE_REASON.SUPERSEDED_SAME_DEVICE,
        rowsRevoked: result.count,
      });
    }
  }

  // ── Step 2: cap active non-AutoFill families ───────────────
  const activeRows = await tx.extensionToken.findMany({
    where: {
      userId,
      revokedAt: null,
      expiresAt: { gt: now },
      clientKind: { not: "IOS_AUTOFILL" },
    },
    select: { familyId: true, familyCreatedAt: true },
  });
  const families = new Map<string, Date>();
  for (const row of activeRows) {
    if (!families.has(row.familyId)) {
      families.set(row.familyId, row.familyCreatedAt);
    }
  }

  // Sequential: one interactive transaction is one connection, and the set is
  // bounded by the cap (at most CLIENT_TOKEN_MAX_ACTIVE_FAMILIES + 1 reads).
  const presences: { familyId: string; presenceAt: Date }[] = [];
  for (const [familyId, familyCreatedAt] of families) {
    presences.push({
      familyId,
      presenceAt: await getFamilyPresenceAt(tx, familyId, familyCreatedAt),
    });
  }
  presences.sort((a, b) => {
    const byPresence = a.presenceAt.getTime() - b.presenceAt.getTime();
    if (byPresence !== 0) return byPresence;
    return a.familyId < b.familyId ? -1 : a.familyId > b.familyId ? 1 : 0;
  });

  while (presences.length + 1 > CLIENT_TOKEN_MAX_ACTIVE_FAMILIES) {
    const oldest = presences.shift();
    if (!oldest) break;
    const result = await tx.extensionToken.updateMany({
      where: { familyId: oldest.familyId, revokedAt: null },
      data: { revokedAt: now },
    });
    if (result.count > 0) {
      revoked.push({
        familyId: oldest.familyId,
        reason: EXTENSION_TOKEN_REVOKE_REASON.ACTIVE_FAMILY_CAP,
        rowsRevoked: result.count,
      });
    }
  }

  return revoked;
}

// ─── Issuance ────────────────────────────────────────────────

/**
 * Issue a new extension token for a user/tenant pair.
 *
 * Shared between:
 * - `POST /api/extension/token/exchange` (bridge code flow)
 *
 * `POST /api/extension/token/refresh` does NOT use this helper because
 * refresh requires `revoke(oldToken) + create(newToken)` to be atomic in
 * a single transaction (see plan §Step 6).
 *
 * Atomicity: sets up its own `withUserTenantRls` + `prisma.$transaction`
 * internally and enforces `CLIENT_TOKEN_MAX_ACTIVE_FAMILIES` (see
 * `enforceActiveFamilyCap`) before creating the new token, all in a single
 * transaction. Callers do NOT need to establish an RLS context before
 * calling. Any evicted families are audited after the transaction commits.
 */
export async function issueExtensionToken(params: {
  userId: string;
  tenantId: string;
  scope: string;
  /** RFC 7638 JWK thumbprint of the extension's DPoP key. Required. */
  cnfJkt: string;
}): Promise<{ token: string; expiresAt: Date; scopeCsv: string; cnfJkt: string }> {
  const { userId, tenantId, scope, cnfJkt } = params;
  const now = new Date();

  // Read tenant extension-token idle/absolute TTLs.
  // FAIL-CLOSED: tenantId is a non-null FK RESTRICT source, so a null tenant row
  // is data corruption, NOT "no policy". The columns are non-nullable with
  // schema defaults, so `tenant?.… ?? DEFAULT` only ever fires on a vanished
  // tenant — where defaulting to the ceiling could grant a longer-lived
  // token than a tenant that had tightened its TTL. Refuse issuance instead.
  const tenant = await withBypassRls(prisma, async (tx) =>
    tx.tenant.findUnique({
      where: { id: tenantId },
      select: {
        extensionTokenIdleTimeoutMinutes: true,
        extensionTokenAbsoluteTimeoutMinutes: true,
      },
    }),
  BYPASS_PURPOSE.TOKEN_LIFECYCLE);
  if (!tenant) {
    throw new Error(`issueExtensionToken: tenant ${tenantId} not found`);
  }
  // The columns are non-nullable with schema defaults; the `?? DEFAULT` is a
  // defensive floor for a field-null that cannot occur in practice (and is
  // fail-safe — a null would otherwise yield a 0-minute TTL).
  const idleMinutes =
    tenant.extensionTokenIdleTimeoutMinutes ?? EXTENSION_TOKEN_IDLE_TIMEOUT_DEFAULT;
  const absoluteMinutes =
    tenant.extensionTokenAbsoluteTimeoutMinutes ?? EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_DEFAULT;
  // Issuance follows a web sign-in + step-up, which itself counts as presence
  // (C3/C4) — presence and familyCreatedAt are both `now` for a brand-new family.
  const expiresAt = computeClientTokenExpiry({
    now,
    presenceAt: now,
    familyCreatedAt: now,
    idleMinutes,
    absoluteMinutes,
  });

  const plaintext = generateShareToken();
  const tokenHash = hashToken(plaintext);
  const familyId = randomUUID();

  const created = await withUserTenantRls(userId, async () =>
    prisma.$transaction(async (tx) => {
      // Serialize concurrent token issuance for this user (count-then-evict-then-create cap race).
      await advisoryXactLock(tx, userId);
      const revokedFamilies = await enforceActiveFamilyCap(tx, {
        userId,
        clientKind: "BROWSER_EXTENSION",
        cnfJkt,
        now,
      });

      const token = await tx.extensionToken.create({
        data: {
          userId,
          tenantId,
          tokenHash,
          scope,
          expiresAt,
          cnfJkt,
          // New token = new family. Refresh flow carries the existing familyId
          // forward (see /api/extension/token/refresh).
          familyId,
          familyCreatedAt: now,
          // Issuance itself counts as presence (see expiresAt comment above).
          lastPresenceAt: now,
        },
        select: { expiresAt: true, scope: true, cnfJkt: true },
      });

      return { token, revokedFamilies };
    }),
  );

  // The evictions have committed; audit them before any post-commit check can
  // throw.
  await emitRevokedFamilyAudits(created.revokedFamilies, { userId, tenantId });

  // cnfJkt is always written in the create.data above — null here is a system
  // invariant violation (Prisma schema allows null for legacy rows, but newly
  // issued tokens always carry it).
  if (!created.token.cnfJkt) {
    throw new Error("issueExtensionToken: cnfJkt missing from newly created row");
  }

  return {
    token: plaintext,
    expiresAt: created.token.expiresAt,
    scopeCsv: created.token.scope,
    cnfJkt: created.token.cnfJkt,
  };
}

// ─── Family revocation ───────────────────────────────────────

/**
 * Revoke every token row in the family and emit an audit event.
 * Safe to call when no rows are affected (no-op).
 */
export async function revokeExtensionTokenFamily(params: {
  familyId: string;
  userId: string;
  tenantId: string;
  reason: ExtensionTokenFamilyRevokeReason;
}): Promise<{ rowsRevoked: number }> {
  const { familyId, userId, tenantId, reason } = params;
  const now = new Date();

  const result = await withBypassRls(prisma, async (tx) =>
    tx.extensionToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    }),
  BYPASS_PURPOSE.TOKEN_LIFECYCLE);

  if (result.count > 0) {
    await emitRevokedFamilyAudits([{ familyId, reason, rowsRevoked: result.count }], {
      userId,
      tenantId,
    });
  }

  return { rowsRevoked: result.count };
}

/**
 * Revoke every active extension token for a user, regardless of family.
 * Used by: "sign out everywhere" (sessions DELETE).
 * Emits one audit event per affected family.
 */
export async function revokeAllExtensionTokensForUser(params: {
  userId: string;
  tenantId: string;
  reason: ExtensionTokenFamilyRevokeReason;
}): Promise<{ rowsRevoked: number; familiesRevoked: number }> {
  const { userId, tenantId, reason } = params;

  // familyId is NOT NULL post-Batch-D migration — no legacy-null branch needed.
  const activeFamilies = await withBypassRls(prisma, async (tx) =>
    tx.extensionToken.findMany({
      where: { userId, revokedAt: null },
      select: { familyId: true },
      distinct: ["familyId"],
    }),
  BYPASS_PURPOSE.TOKEN_LIFECYCLE);

  let totalRows = 0;
  for (const row of activeFamilies) {
    const { rowsRevoked } = await revokeExtensionTokenFamily({
      familyId: row.familyId,
      userId,
      tenantId,
      reason,
    });
    totalRows += rowsRevoked;
  }

  return {
    rowsRevoked: totalRows,
    familiesRevoked: activeFamilies.length,
  };
}
