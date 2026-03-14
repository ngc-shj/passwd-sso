import { z } from "zod";
import { SUPPORTED_WRAP_VERSIONS } from "@/lib/crypto-emergency";

// ─── Emergency Access Schemas ─────────────────────────────

export const createEmergencyGrantSchema = z.object({
  granteeEmail: z.string().email(),
  waitDays: z.number().int().refine((n) => [7, 14, 30].includes(n), {
    message: "waitDays must be 7, 14, or 30",
  }),
});

export const acceptEmergencyGrantSchema = z.object({
  token: z.string().min(1),
  granteePublicKey: z.string().min(1),
  encryptedPrivateKey: z.object({
    ciphertext: z.string().min(1),
    iv: z.string().length(24),
    authTag: z.string().length(32),
  }),
});

export const rejectEmergencyGrantSchema = z.object({
  token: z.string().min(1),
});

export const confirmEmergencyGrantSchema = z.object({
  ownerEphemeralPublicKey: z.string().min(1),
  encryptedSecretKey: z.string().min(1),
  secretKeyIv: z.string().length(24),
  secretKeyAuthTag: z.string().length(32),
  hkdfSalt: z.string().length(64),
  wrapVersion: z.number().int().refine(
    (v) => SUPPORTED_WRAP_VERSIONS.has(v),
    { message: `wrapVersion must be one of: ${[...SUPPORTED_WRAP_VERSIONS].join(", ")}` }
  ),
  keyVersion: z.number().int().min(1).optional(), // Server uses owner's DB value
});

export const acceptEmergencyGrantByIdSchema = z.object({
  granteePublicKey: z.string().min(1),
  encryptedPrivateKey: z.object({
    ciphertext: z.string().min(1),
    iv: z.string().length(24),
    authTag: z.string().length(32),
  }),
});

export const revokeEmergencyGrantSchema = z.object({
  permanent: z.boolean().default(true),
});

// ─── Type Exports ──────────────────────────────────────────

export type CreateEmergencyGrantInput = z.infer<typeof createEmergencyGrantSchema>;
export type AcceptEmergencyGrantInput = z.infer<typeof acceptEmergencyGrantSchema>;
export type ConfirmEmergencyGrantInput = z.infer<typeof confirmEmergencyGrantSchema>;
export type RevokeEmergencyGrantInput = z.infer<typeof revokeEmergencyGrantSchema>;
