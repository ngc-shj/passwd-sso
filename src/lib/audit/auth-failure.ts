/**
 * Emit AUTH_LOGIN_FAILURE audit event (C11 / OWASP A09-1).
 *
 * Identifier is hashed with HMAC(AUDIT_IDENTIFIER_PEPPER, email + ":" + tenantId)
 * truncated to 16 hex chars (64 bits). Tenant binding prevents cross-tenant
 * correlation of the same email's failures. Raw email is never persisted.
 *
 * Per-tenant binding: tenantId="" is used when the failure occurs before a
 * tenant can be determined (e.g., unknown email, magic link entry). This
 * yields a stable global hash for that email across pre-tenant failures.
 */

import { createHmac } from "node:crypto";
import { logAuditAsync } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { getLogger } from "@/lib/logger";

export type AuthLoginFailureReason =
  | "unknown_email"
  | "tenant_mismatch"
  | "provider_error"
  | "magic_link_expired"
  | "credential_mismatch";

export type AuthProvider =
  | "google"
  | "nodemailer"
  | "saml"
  | "passkey"
  | "credentials"
  | "unknown";

function hashIdentifier(email: string, tenantId: string): string {
  const pepper = process.env.AUDIT_IDENTIFIER_PEPPER ?? "";
  if (!pepper) {
    // No pepper configured — fall back to bare HMAC with empty key.
    // Audit value is degraded (offline dictionary attack possible if DB leaks),
    // but the event still serves brute-force detection. Operators are warned.
    getLogger().warn(
      "AUDIT_IDENTIFIER_PEPPER not configured; auth-failure identifier hashes use empty key",
    );
  }
  return createHmac("sha256", pepper)
    .update(`${email.toLowerCase()}:${tenantId}`)
    .digest("hex")
    .slice(0, 16);
}

export async function emitAuthLoginFailure(args: {
  email: string | null;
  tenantId?: string | null;
  provider: AuthProvider;
  reason: AuthLoginFailureReason;
  userId?: string | null;
}): Promise<void> {
  const identifierHash = args.email
    ? hashIdentifier(args.email, args.tenantId ?? "")
    : null;

  await logAuditAsync({
    scope: AUDIT_SCOPE.PERSONAL,
    // SYSTEM actor: failed sign-in has no authenticated user yet.
    userId: args.userId ?? SYSTEM_ACTOR_ID,
    actorType: ACTOR_TYPE.SYSTEM,
    metadata: {
      provider: args.provider,
      reason: args.reason,
      identifierHash,
    },
    action: AUDIT_ACTION.AUTH_LOGIN_FAILURE,
  });
}
