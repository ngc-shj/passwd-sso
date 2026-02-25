import { randomBytes } from "node:crypto";

/** Prefix for SCIM tokens — enables secret scanners to detect leaks. */
export const SCIM_TOKEN_PREFIX = "scim_";

/**
 * Generate a SCIM bearer token.
 * Format: `scim_` + 32-byte (256-bit) random hex = 70 chars total.
 */
export function generateScimToken(): string {
  return SCIM_TOKEN_PREFIX + randomBytes(32).toString("hex");
}
