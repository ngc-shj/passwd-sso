/**
 * The audit identifier pepper and the keyed references derived from it.
 *
 * One module for every reader: `auth-failure.ts` hashes failed sign-in emails
 * with it, the sign-in binding refusals store a reference to the presenting
 * provider id with it, and the tenant-domain CLI maps those references back
 * against the configured provider set. A second copy of the derivation is how
 * the app's references and the CLI's stop agreeing.
 *
 * Must stay prisma-free: the CLI imports it.
 *
 * Pepper resolution (C8):
 *   1. AUDIT_IDENTIFIER_PEPPER (>= 32 chars) — explicit override
 *   2. AUTH_SECRET (>= 32 chars)             — HKDF-derived, domain-separated
 *   3. neither                               — no key material; nothing keyed is computed
 * Unlike src/lib/auth/session/session-cache.ts, there is no dev fallback to
 * another real secret: that fallback exists to preserve digest compatibility
 * with pre-existing rows, a requirement this module does not have. Emitting
 * an unkeyed record is the honest branch.
 */

import { createHmac, hkdfSync } from "node:crypto";
import { getLogger } from "@/lib/logger";

const IDENTIFIER_PEPPER_INFO = "audit-identifier-pepper-v1";
// Matches envSchema's production floor for AUTH_SECRET (superRefine, prod-only —
// the field itself is .optional()), checked again here because this module
// runs regardless of NODE_ENV. The same floor applies to the explicit override:
// envSchema narrows AUDIT_IDENTIFIER_PEPPER further (hex64), but this module
// reads the env directly rather than the validated singleton, so an override
// that never passed the schema still has to be rejected here. A one-byte HMAC
// key is worse than the honest unkeyed branch, because the record then claims
// key material it does not have (round-1 Sec F5).
const MIN_KEY_MATERIAL_LENGTH = 32;

/** HKDF info separating provider references from the email hash's key. */
const PROVIDER_REF_INFO = "audit-provider-ref-v1";
/** Hex characters kept, as for the email hash: 64 bits. */
const REF_HEX_LENGTH = 16;

export type PepperEnv = Readonly<Record<string, string | undefined>>;

/** The pepper for an env, or null when neither source carries enough key material. */
export function deriveIdentifierPepper(env: PepperEnv): Buffer | null {
  const explicit = env.AUDIT_IDENTIFIER_PEPPER;
  if (explicit && explicit.length >= MIN_KEY_MATERIAL_LENGTH) {
    return Buffer.from(explicit, "utf8");
  }
  const authSecret = env.AUTH_SECRET;
  if (authSecret && authSecret.length >= MIN_KEY_MATERIAL_LENGTH) {
    // HKDF-domain-separate so AUTH_SECRET is never used verbatim as the HMAC key.
    return Buffer.from(hkdfSync("sha256", authSecret, "", IDENTIFIER_PEPPER_INFO, 32));
  }
  return null;
}

// Memoised pepper, derived on first use rather than at module load so the
// "no pepper configured" warning reflects the branch actually taken.
// undefined = not yet derived; null = derived, no key material available.
let identifierPepper: Buffer | null | undefined;
let warnedNoPepper = false;

/** The process's pepper, from `process.env`, derived once. */
export function getIdentifierPepper(): Buffer | null {
  if (identifierPepper !== undefined) return identifierPepper;
  identifierPepper = deriveIdentifierPepper(process.env);
  if (identifierPepper === null && !warnedNoPepper) {
    warnedNoPepper = true;
    getLogger().warn(
      "AUDIT_IDENTIFIER_PEPPER and AUTH_SECRET are both unavailable or too short; auth-failure identifier hashes are unkeyed",
    );
  }
  return identifierPepper;
}

/** Test seam: forget the memoised pepper so the next read re-derives from the env. */
export function resetIdentifierPepperForTests(): void {
  identifierPepper = undefined;
  warnedNoPepper = false;
}

/**
 * The stored reference to an SSO provider id: a truncated HMAC under a key
 * derived from the pepper. Audit rows readable by one tenant's admins carry
 * this instead of the id, so a connection named after another customer is not
 * shown to them; the operator, who holds the pepper and the configured set,
 * maps it back.
 */
export function providerRef(providerId: string, pepper: Buffer): string {
  const key = Buffer.from(hkdfSync("sha256", pepper, "", PROVIDER_REF_INFO, 32));
  return createHmac("sha256", key).update(providerId).digest("hex").slice(0, REF_HEX_LENGTH);
}

/** `providerRef` under the process's pepper; null — store no ref — without one. */
export function providerRefOf(providerId: string): string | null {
  const pepper = getIdentifierPepper();
  return pepper ? providerRef(providerId, pepper) : null;
}

/**
 * The first two provider ids whose refs collide, or null when every ref is
 * distinct. A collision would make the operator's mapping name the wrong
 * connection — the one it shares a ref with.
 */
export function findProviderRefCollision(
  entries: ReadonlyArray<{ id: string; ref: string }>,
): [string, string] | null {
  const idByRef = new Map<string, string>();
  for (const { id, ref } of entries) {
    const earlier = idByRef.get(ref);
    if (earlier !== undefined && earlier !== id) return [earlier, id];
    idByRef.set(ref, id);
  }
  return null;
}

/**
 * Boot refusal over the configured claim-provider set: every id's ref must be
 * distinct. Nothing to check without a pepper, because no ref is stored then.
 */
export function assertDistinctProviderRefs(
  providerIds: readonly string[],
  pepper: Buffer | null,
): void {
  if (pepper === null) return;
  const collision = findProviderRefCollision(
    providerIds.map((id) => ({ id, ref: providerRef(id, pepper) })),
  );
  if (collision) {
    throw new Error(
      `SSO providers "${collision[0]}" and "${collision[1]}" have the same audit reference; rename one connection id`,
    );
  }
}
