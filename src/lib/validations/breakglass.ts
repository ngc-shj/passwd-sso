import { z } from "zod";

// ─── Break-Glass Personal Log Access Schemas ──────────────

export const createBreakglassGrantSchema = z.object({
  targetUserId: z.string().cuid(),
  reason: z.string().trim().min(10).max(1000),
  incidentRef: z.string().trim().max(500).optional(),
});

export type CreateBreakglassGrantInput = z.infer<
  typeof createBreakglassGrantSchema
>;
