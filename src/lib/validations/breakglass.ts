import { z } from "zod";
import {
  BREAKGLASS_REASON_MIN,
  BREAKGLASS_REASON_MAX,
  BREAKGLASS_INCIDENT_REF_MAX,
} from "./common";

// ─── Break-Glass Personal Log Access Schemas ──────────────

export const createBreakglassGrantSchema = z.object({
  targetUserId: z.string().cuid(),
  reason: z.string().trim().min(BREAKGLASS_REASON_MIN).max(BREAKGLASS_REASON_MAX),
  incidentRef: z.string().trim().max(BREAKGLASS_INCIDENT_REF_MAX).optional(),
});

export type CreateBreakglassGrantInput = z.infer<
  typeof createBreakglassGrantSchema
>;
