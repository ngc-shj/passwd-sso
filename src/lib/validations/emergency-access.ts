import { z } from "zod";
import { SUPPORTED_WRAP_VERSIONS } from "@/lib/crypto/crypto-emergency";
import {
  HEX_IV_LENGTH,
  HEX_AUTH_TAG_LENGTH,
  HEX_SALT_LENGTH,
  EMERGENCY_WAIT_DAYS,
} from "./common";

// Shape: { ciphertext, iv, authTag } for an ECDH-wrapped private key
// (smaller ciphertext cap than the entry blob schema).
const encryptedPrivateKeySchema = z.object({
  ciphertext: z.string().min(1).max(1024),
  iv: z.string().length(HEX_IV_LENGTH),
  authTag: z.string().length(HEX_AUTH_TAG_LENGTH),
});

// ─── Emergency Access Schemas ─────────────────────────────

export const createEmergencyGrantSchema = z.object({
  granteeEmail: z.string().email(),
  waitDays: z.number().int().refine((n) => (EMERGENCY_WAIT_DAYS as readonly number[]).includes(n), {
    message: "waitDays must be 7, 14, or 30",
  }),
});

export const acceptEmergencyGrantSchema = z.object({
  token: z.string().min(1).max(128),
  granteePublicKey: z.string().min(1).max(512),
  encryptedPrivateKey: encryptedPrivateKeySchema,
});

export const rejectEmergencyGrantSchema = z.object({
  token: z.string().min(1).max(128),
});

export const confirmEmergencyGrantSchema = z.object({
  ownerEphemeralPublicKey: z.string().min(1).max(512),
  encryptedSecretKey: z.string().min(1).max(512),
  secretKeyIv: z.string().length(HEX_IV_LENGTH),
  secretKeyAuthTag: z.string().length(HEX_AUTH_TAG_LENGTH),
  hkdfSalt: z.string().length(HEX_SALT_LENGTH),
  wrapVersion: z.number().int().refine(
    (v) => SUPPORTED_WRAP_VERSIONS.has(v),
    { message: `wrapVersion must be one of: ${[...SUPPORTED_WRAP_VERSIONS].join(", ")}` }
  ),
  keyVersion: z.number().int().min(1).optional(), // Server uses owner's DB value
});

export const acceptEmergencyGrantByIdSchema = z.object({
  granteePublicKey: z.string().min(1).max(512),
  encryptedPrivateKey: encryptedPrivateKeySchema,
});

export const revokeEmergencyGrantSchema = z.object({
  permanent: z.boolean().default(true),
});

// ─── Type Exports ──────────────────────────────────────────

export type CreateEmergencyGrantInput = z.infer<typeof createEmergencyGrantSchema>;
export type AcceptEmergencyGrantInput = z.infer<typeof acceptEmergencyGrantSchema>;
export type ConfirmEmergencyGrantInput = z.infer<typeof confirmEmergencyGrantSchema>;
export type RevokeEmergencyGrantInput = z.infer<typeof revokeEmergencyGrantSchema>;
