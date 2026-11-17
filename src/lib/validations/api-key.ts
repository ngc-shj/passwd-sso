import { z } from "zod";
import { API_KEY_SCOPES, MAX_API_KEY_EXPIRY_DAYS } from "@/lib/constants/auth/api-key";
import { NAME_MAX_LENGTH } from "./common";
import { MS_PER_DAY } from "@/lib/constants/time";

// ─── API Key ──────────────────────────────────────────────

export const apiKeyCreateSchema = z.object({
  name: z.string().min(1).max(NAME_MAX_LENGTH),
  scope: z.array(z.enum(API_KEY_SCOPES)).min(1)
    .transform((v) => [...new Set(v)]),
  expiresAt: z.coerce.date().refine(
    // Elapsed time, not a server-local calendar step (setDate), so the bound
    // does not move with the server's timezone or a DST change in the window.
    (d) => {
      const now = Date.now();
      return d.getTime() > now && d.getTime() <= now + MAX_API_KEY_EXPIRY_DAYS * MS_PER_DAY;
    },
    { message: `Expiry must be in the future and within ${MAX_API_KEY_EXPIRY_DAYS} days` },
  ),
});

// ─── Type Exports ──────────────────────────────────────────

export type ApiKeyCreateInput = z.infer<typeof apiKeyCreateSchema>;
