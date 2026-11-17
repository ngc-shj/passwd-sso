import { z } from "zod";
import {
  SA_TOKEN_SCOPES,
  MAX_SA_TOKEN_EXPIRY_DAYS,
} from "@/lib/constants/auth/service-account";
import { NAME_MAX_LENGTH } from "./common";
import { MS_PER_DAY } from "@/lib/constants/time";

// ─── Service Account ──────────────────────────────────────

export const serviceAccountCreateSchema = z.object({
  name: z.string().min(1).max(NAME_MAX_LENGTH),
  description: z.string().max(1000).optional(),
  teamId: z.string().uuid().optional(),
});

export const serviceAccountUpdateSchema = z.object({
  name: z.string().min(1).max(NAME_MAX_LENGTH).optional(),
  description: z.string().max(1000).nullable().optional(),
  isActive: z.boolean().optional(),
});

// ─── Service Account Token ────────────────────────────────

export const saTokenCreateSchema = z.object({
  name: z.string().min(1).max(NAME_MAX_LENGTH),
  scope: z.array(z.enum(SA_TOKEN_SCOPES)).min(1)
    .transform((v) => [...new Set(v)]),
  expiresAt: z.coerce.date().refine(
    // Elapsed time, not a server-local calendar step (setDate), so the bound
    // does not move with the server's timezone or a DST change in the window.
    (d) => {
      const now = Date.now();
      return d.getTime() > now && d.getTime() <= now + MAX_SA_TOKEN_EXPIRY_DAYS * MS_PER_DAY;
    },
    {
      message: `Expiry must be in the future and within ${MAX_SA_TOKEN_EXPIRY_DAYS} days`,
    },
  ),
});

// ─── Type Exports ──────────────────────────────────────────

export type ServiceAccountCreateInput = z.infer<
  typeof serviceAccountCreateSchema
>;
export type ServiceAccountUpdateInput = z.infer<
  typeof serviceAccountUpdateSchema
>;
export type SaTokenCreateInput = z.infer<typeof saTokenCreateSchema>;
