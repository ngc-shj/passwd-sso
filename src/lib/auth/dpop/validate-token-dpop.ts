import type { NextRequest } from "next/server";
import type { ExtensionTokenClientKind } from "@prisma/client";
import { verifyDpopProof, computeAth } from "@/lib/auth/dpop/verify";
import { getJtiCache } from "@/lib/auth/dpop/jti-cache";
import { canonicalHtu } from "@/lib/auth/dpop/htu-canonical";
import {
  parseScopes,
  type ValidatedExtensionToken,
  type TokenValidationError,
} from "@/lib/auth/tokens/extension-token-types";
import type { DpopVerifyError } from "@/lib/auth/dpop/verify";

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
 * Shared DPoP-validation helper for BROWSER_EXTENSION, IOS_APP, and
 * IOS_AUTOFILL tokens.
 *
 * Extracted from the IOS_APP branch of validateExtensionToken. Caller has
 * already confirmed the row is non-revoked, non-expired, and (for IOS_APP)
 * that cnfJkt is non-null.
 *
 * Writes nothing: the `lastUsedAt`/IP/UA update lives in
 * `validateExtensionToken`, its only caller, so a DPoP failure or a passkey
 * gate refusal downstream of this helper writes nothing either (C5).
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
      clientKind: row.clientKind,
    },
  };
}
