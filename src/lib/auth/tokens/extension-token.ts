import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateShareToken, hashToken } from "@/lib/crypto/crypto-server";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withUserTenantRls } from "@/lib/tenant-context";
import { randomUUID } from "node:crypto";
import {
  EXTENSION_TOKEN_SCOPE,
  EXTENSION_TOKEN_MAX_ACTIVE,
  type ExtensionTokenScope,
} from "@/lib/constants";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { logAuditAsync } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
// ─── Types ───────────────────────────────────────────────────

export interface ValidatedExtensionToken {
  tokenId: string;
  userId: string;
  tenantId: string;
  scopes: ExtensionTokenScope[];
  expiresAt: Date;
  familyId: string;
  familyCreatedAt: Date;
}

export type TokenValidationError =
  | "EXTENSION_TOKEN_INVALID"
  | "EXTENSION_TOKEN_REVOKED"
  | "EXTENSION_TOKEN_EXPIRED";

export type TokenValidationResult =
  | { ok: true; data: ValidatedExtensionToken }
  | { ok: false; error: TokenValidationError };

// ─── Helpers ─────────────────────────────────────────────────

function extractBearer(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() ?? null;
}

const ALLOWED_SCOPES = new Set<string>(
  Object.values(EXTENSION_TOKEN_SCOPE),
);

/** Parse CSV scope string into typed array. Unknown scopes are dropped. */
export function parseScopes(csv: string): ExtensionTokenScope[] {
  const out: ExtensionTokenScope[] = [];
  for (const raw of csv.split(",")) {
    const s = raw.trim();
    if (s && ALLOWED_SCOPES.has(s)) {
      out.push(s as ExtensionTokenScope);
    }
  }
  return out;
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
 *  - `clientKind === 'BROWSER_EXTENSION'` (default for legacy rows): the
 *    classic path — bearer-only validation + `lastUsedAt` bump.
 *  - `clientKind === 'IOS_APP'`: defers to `validateIosTokenDpop` from
 *    `mobile-token.ts`, which additionally requires a valid DPoP proof
 *    bound to the row's `cnfJkt`. iOS rows also have `lastUsedIp` /
 *    `lastUsedUserAgent` updated on each call (browser rows leave those
 *    columns NULL).
 *
 * On success, updates `lastUsedAt` (best-effort, non-blocking).
 */
export async function validateExtensionToken(
  req: NextRequest,
): Promise<TokenValidationResult> {
  const plaintext = extractBearer(req);
  if (!plaintext) {
    return { ok: false, error: "EXTENSION_TOKEN_INVALID" };
  }

  const tokenHash = hashToken(plaintext);

  const token = await withBypassRls(prisma, async () =>
    prisma.extensionToken.findUnique({
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

  // ── iOS-host-app dispatch ──────────────────────────────────
  // For IOS_APP rows, additionally require a DPoP proof bound to the
  // row's stored cnfJkt. Lazy-imported to avoid a module-init cycle:
  // mobile-token.ts imports parseScopes / revokeExtensionTokenFamily
  // from this file.
  if (token.clientKind === "IOS_APP") {
    const [{ validateIosTokenDpop }, { canonicalHtu }] = await Promise.all([
      import("./mobile-token"),
      import("@/lib/auth/dpop/htu-canonical"),
    ]);
    const route = new URL(req.url).pathname;
    const dpopResult = await validateIosTokenDpop({
      req,
      expectedHtm: req.method,
      expectedHtu: canonicalHtu({ route }),
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
      },
    });
    if (dpopResult.ok) return { ok: true, data: dpopResult.data };
    // Map iOS DPoP failures to the existing INVALID error so legacy callers
    // (which look up API_ERROR[result.error]) keep type-checking. Routes
    // that need granular DPoP error reporting call validateIosTokenDpop
    // directly with the row + access token.
    return { ok: false, error: "EXTENSION_TOKEN_INVALID" };
  }

  // ── BROWSER_EXTENSION (default): unchanged ─────────────────
  // Best-effort lastUsedAt update (non-blocking).
  void withBypassRls(prisma, async () =>
    prisma.extensionToken.update({
      where: { id: token.id },
      data: { lastUsedAt: new Date() },
    }),
  BYPASS_PURPOSE.TOKEN_LIFECYCLE).catch(() => {});

  return {
    ok: true,
    data: {
      tokenId: token.id,
      userId: token.userId,
      tenantId: token.tenantId,
      scopes: parseScopes(token.scope),
      expiresAt: token.expiresAt,
      familyId: token.familyId,
      familyCreatedAt: token.familyCreatedAt,
    },
  };
}

// ─── Issuance ────────────────────────────────────────────────

/**
 * Issue a new extension token for a user/tenant pair.
 *
 * Shared between:
 * - `POST /api/extension/token` (legacy direct issuance)
 * - `POST /api/extension/token/exchange` (new bridge code flow)
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
}): Promise<{ token: string; expiresAt: Date; scopeCsv: string }> {
  const { userId, tenantId, scope } = params;
  const now = new Date();

  // Read tenant extension-token idle TTL. Fall back to the policy ceiling if
  // the tenant row is missing (defensive — should not happen in practice).
  const tenant = await withBypassRls(prisma, async () =>
    prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { extensionTokenIdleTimeoutMinutes: true },
    }),
  BYPASS_PURPOSE.TOKEN_LIFECYCLE);
  const idleMinutes = tenant?.extensionTokenIdleTimeoutMinutes ?? 10080;
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
          // New token = new family. Refresh flow carries the existing familyId
          // forward (see /api/extension/token/refresh).
          familyId,
          familyCreatedAt: now,
        },
        select: { expiresAt: true, scope: true },
      });
    }),
  );

  return {
    token: plaintext,
    expiresAt: created.expiresAt,
    scopeCsv: created.scope,
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

  const result = await withBypassRls(prisma, async () =>
    prisma.extensionToken.updateMany({
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
  const activeFamilies = await withBypassRls(prisma, async () =>
    prisma.extensionToken.findMany({
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
