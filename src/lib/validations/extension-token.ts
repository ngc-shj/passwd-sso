import { z } from "zod";

/** Response schema for POST /api/extension/token and POST /api/extension/token/refresh */
export const TokenIssueResponseSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.string().datetime(),
  scope: z.array(z.string()).min(1),
});

/** Response schema for DELETE /api/extension/token */
export const TokenRevokeResponseSchema = z.object({
  ok: z.literal(true),
});
