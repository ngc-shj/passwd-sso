import type { NextRequest } from "next/server";
import type { ExtensionTokenClientKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { extractClientIp } from "@/lib/auth/policy/ip-access";
import { verifyDpopProof, computeAth } from "@/lib/auth/dpop/verify";
import { getJtiCache } from "@/lib/auth/dpop/jti-cache";
import { canonicalHtu } from "@/lib/auth/dpop/htu-canonical";
import {
  EXTENSION_TOKEN_SCOPE,
  type ExtensionTokenScope,
} from "@/lib/constants";
import type {
  ValidatedExtensionToken,
  TokenValidationError,
} from "@/lib/auth/tokens/extension-token-types";
import type { DpopVerifyError } from "@/lib/auth/dpop/verify";

// Local copy of parseScopes to avoid a circular dependency:
// validate-token-dpop → extension-token → validate-token-dpop.
// Both implementations must stay in sync if EXTENSION_TOKEN_SCOPE changes.
const ALLOWED_SCOPES = new Set<string>(Object.values(EXTENSION_TOKEN_SCOPE));
function parseScopes(csv: string): ExtensionTokenScope[] {
  const out: ExtensionTokenScope[] = [];
  for (const raw of csv.split(",")) {
    const s = raw.trim();
    if (s && ALLOWED_SCOPES.has(s)) {
      out.push(s as ExtensionTokenScope);
    }
  }
  return out;
}

export interface ValidateTokenDpopRow {
  id: string;
  userId: string;
  tenantId: string;
  /**
   * For BROWSER_EXTENSION: enforced NOT NULL by partial CHECK constraint.
   * For IOS_APP: caller (the IOS_APP dispatch) guards row.cnfJkt non-null
   * at the call site (mobile-token.ts:247-251 pattern).
   */
  cnfJkt: string;
  scope: string;
  expiresAt: Date;
  familyId: string;
  familyCreatedAt: Date;
  /** Prisma-generated enum, NOT a hand-rolled union. */
  clientKind: ExtensionTokenClientKind;
}

export type ValidateTokenDpopResult =
  | { ok: true; data: ValidatedExtensionToken }
  | {
      ok: false;
      error: Extract<TokenValidationError, "EXTENSION_TOKEN_INVALID" | "EXTENSION_TOKEN_DPOP_INVALID">;
      dpopError?: DpopVerifyError;
    };

/**
 * Shared DPoP-validation helper for both BROWSER_EXTENSION and IOS_APP tokens.
 *
 * Extracted from the IOS_APP branch of validateExtensionToken. Caller has
 * already confirmed the row is non-revoked, non-expired, and (for IOS_APP)
 * that cnfJkt is non-null.
 *
 * Behavior differences by clientKind:
 *  - IOS_APP: updates lastUsedIp and lastUsedUserAgent (fire-and-forget).
 *  - BROWSER_EXTENSION: leaves lastUsedIp / lastUsedUserAgent NULL (existing
 *    behavior preserved; browser rows never tracked these).
 */
export async function validateExtensionTokenDpop(args: {
  req: NextRequest;
  row: ValidateTokenDpopRow;
  accessToken: string;
}): Promise<ValidateTokenDpopResult> {
  const { req, row, accessToken } = args;

  const route = new URL(req.url).pathname;
  const dpopHeader = req.headers.get("dpop");

  const result = await verifyDpopProof(dpopHeader, {
    expectedHtm: req.method,
    expectedHtu: canonicalHtu({ route }),
    expectedAth: computeAth(accessToken),
    expectedCnfJkt: row.cnfJkt,
    expectedNonce: null,
    jtiCache: getJtiCache(),
  });

  if (!result.ok) {
    return {
      ok: false,
      error: "EXTENSION_TOKEN_DPOP_INVALID",
      dpopError: result.error,
    };
  }

  // Best-effort lastUsedAt update — always, for both clientKinds.
  // lastUsedIp / lastUsedUserAgent only for IOS_APP (preserves existing behavior).
  const updateData: Record<string, unknown> = { lastUsedAt: new Date() };
  if (row.clientKind === "IOS_APP") {
    updateData.lastUsedIp = extractClientIp(req);
    updateData.lastUsedUserAgent =
      req.headers.get("user-agent")?.slice(0, 512) ?? null;
  }

  void withBypassRls(
    prisma,
    async (tx) =>
      tx.extensionToken.update({
        where: { id: row.id },
        data: updateData,
      }),
    BYPASS_PURPOSE.TOKEN_LIFECYCLE,
  ).catch(() => {});

  return {
    ok: true,
    data: {
      tokenId: row.id,
      userId: row.userId,
      tenantId: row.tenantId,
      scopes: parseScopes(row.scope),
      expiresAt: row.expiresAt,
      familyId: row.familyId,
      familyCreatedAt: row.familyCreatedAt,
      cnfJkt: row.cnfJkt,
    },
  };
}
