import { z } from "zod";
import { API_KEY_SCOPES, MAX_API_KEY_EXPIRY_DAYS } from "@/lib/constants/api-key";
import { NAME_MAX_LENGTH } from "./common";

// ─── API Key ──────────────────────────────────────────────

export const apiKeyCreateSchema = z.object({
  name: z.string().min(1).max(NAME_MAX_LENGTH),
  scope: z.array(z.enum(API_KEY_SCOPES)).min(1),
  expiresAt: z.coerce.date().refine(
    (d) => {
      const maxDate = new Date();
      maxDate.setDate(maxDate.getDate() + MAX_API_KEY_EXPIRY_DAYS);
      return d.getTime() > Date.now() && d.getTime() <= maxDate.getTime();
    },
    { message: `Expiry must be in the future and within ${MAX_API_KEY_EXPIRY_DAYS} days` },
  ),
});

// ─── Type Exports ──────────────────────────────────────────

export type ApiKeyCreateInput = z.infer<typeof apiKeyCreateSchema>;
