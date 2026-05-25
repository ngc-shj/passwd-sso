import { z } from "zod";

/** Response schema for POST /api/extension/token and POST /api/extension/token/refresh */
export const TokenIssueResponseSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.string().datetime(),
  scope: z.array(z.string()).min(1),
  /** RFC 7638 JWK thumbprint of the DPoP key bound to this token. Always present. */
  cnfJkt: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

/** Response schema for DELETE /api/extension/token */
export const TokenRevokeResponseSchema = z.object({
  ok: z.literal(true),
});
