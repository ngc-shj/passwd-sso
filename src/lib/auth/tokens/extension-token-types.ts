import { EXTENSION_TOKEN_SCOPE, type ExtensionTokenScope } from "@/lib/constants";

/**
 * Leaf type module — imported by both extension-token.ts and
 * dpop/validate-token-dpop.ts. Keeping types here breaks what would
 * otherwise be a circular dependency:
 *   dpop/validate-token-dpop → extension-token → dpop/validate-token-dpop
 */

const ALLOWED_SCOPES = new Set<string>(Object.values(EXTENSION_TOKEN_SCOPE));

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

export interface ValidatedExtensionToken {
  tokenId: string;
  userId: string;
  tenantId: string;
  scopes: ExtensionTokenScope[];
  expiresAt: Date;
  familyId: string;
  familyCreatedAt: Date;
  /**
   * RFC 7638 JWK thumbprint of the bound DPoP key (base64url, 43 chars).
   * Non-nullable by construction:
   *  - BROWSER_EXTENSION rows satisfy the partial CHECK constraint
   *    (cnf_jkt NOT NULL for this client_kind).
   *  - IOS_APP rows whose cnf_jkt IS NULL are rejected by the IOS dispatch
   *    guard in mobile-token.ts before this type is ever constructed.
   */
  cnfJkt: string;
}

export type TokenValidationError =
  | "EXTENSION_TOKEN_INVALID"
  | "EXTENSION_TOKEN_REVOKED"
  | "EXTENSION_TOKEN_EXPIRED"
  | "EXTENSION_TOKEN_DPOP_INVALID";

export type TokenValidationResult =
  | { ok: true; data: ValidatedExtensionToken }
  | { ok: false; error: TokenValidationError };
