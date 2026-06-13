import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateShareToken, hashToken } from "@/lib/crypto/crypto-server";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withUserTenantRls } from "@/lib/tenant-context";
import { randomUUID } from "node:crypto";
import {
  EXTENSION_TOKEN_MAX_ACTIVE,
  type ExtensionTokenScope,
} from "@/lib/constants";
import { EXTENSION_TOKEN_IDLE_TIMEOUT_DEFAULT } from "@/lib/validations/common";
import { MS_PER_MINUTE } from "@/lib/constants/time";
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
 * internally and enforces `EXTENSION_TOKEN_MAX_ACTIVE` (revokes the oldest
 * unused tokens to make room) before creating the new token, all in a single
 * transaction. Callers do NOT need to establish an RLS context before calling.
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

  // Read tenant extension-token idle TTL. Fall back to the policy ceiling if
  // the tenant row is missing (defensive — should not happen in practice).
  const tenant = await withBypassRls(prisma, async (tx) =>
    tx.tenant.findUnique({
      where: { id: tenantId },
      select: { extensionTokenIdleTimeoutMinutes: true },
    }),
  BYPASS_PURPOSE.TOKEN_LIFECYCLE);
  const idleMinutes = tenant?.extensionTokenIdleTimeoutMinutes ?? EXTENSION_TOKEN_IDLE_TIMEOUT_DEFAULT;
  const expiresAt = new Date(now.getTime() + idleMinutes * MS_PER_MINUTE);

  const plaintext = generateShareToken();
  const tokenHash = hashToken(plaintext);
  const familyId = randomUUID();

  const created = await withUserTenantRls(userId, async () =>
    prisma.$transaction(async (tx) => {
      // Find active tokens (non-revoked, non-expired)
      const active = await tx.extensionToken.findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });

      // Revoke oldest if at max (need room for the new one)
      const over = active.length + 1 - EXTENSION_TOKEN_MAX_ACTIVE;
      if (over > 0) {
        const toRevoke = active.slice(0, over).map((t) => t.id);
        await tx.extensionToken.updateMany({
          where: { id: { in: toRevoke } },
          data: { revokedAt: now },
        });
      }

      return tx.extensionToken.create({
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
        },
        select: { expiresAt: true, scope: true, cnfJkt: true },
      });
    }),
  );

  // cnfJkt is always written in the create.data above — null here is a system
  // invariant violation (Prisma schema allows null for legacy rows, but newly
  // issued tokens always carry it).
  if (!created.cnfJkt) {
    throw new Error("issueExtensionToken: cnfJkt missing from newly created row");
  }

  return {
    token: plaintext,
    expiresAt: created.expiresAt,
    scopeCsv: created.scope,
    cnfJkt: created.cnfJkt,
  };
}

// ─── Family revocation ───────────────────────────────────────

export type ExtensionTokenFamilyRevokeReason =
  | "family_expired"
  | "replay_detected"
  | "sign_out_everywhere"
  | "passkey_reauth"
  | "user_delete";

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
    await logAuditAsync({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.EXTENSION_TOKEN_FAMILY_REVOKED,
      userId,
      tenantId,
      targetType: AUDIT_TARGET_TYPE.EXTENSION_TOKEN,
      targetId: familyId,
      metadata: {
        reason,
        familyId,
        rowsRevoked: result.count,
      },
    });
  }

  return { rowsRevoked: result.count };
}

/**
 * Revoke every active extension token for a user, regardless of family.
 * Used by: "sign out everywhere" (sessions DELETE), passkey re-auth.
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
