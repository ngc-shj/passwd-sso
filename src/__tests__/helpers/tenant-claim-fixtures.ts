/**
 * Shared literals for the SSO tenant claim registry test suites (RT3).
 * `primary.example` / `alias.example` model an IdP domain rename: a tenant
 * originally provisioned under `primary.example` whose IdP starts sending
 * `alias.example` as the `hd` claim. `acmecorp` models a non-domain claim
 * key (AUTH_TENANT_CLAIM_KEYS pointed at `organization`/`company`, NF2).
 *
 * Documentation policy: no real customer/company domain, no real email
 * address — these placeholders only.
 */
import { randomBytes } from "node:crypto";

export const PRIMARY_CLAIM = "primary.example";
export const ALIAS_CLAIM = "alias.example";
export const NON_DOMAIN_CLAIM = "acmecorp";

/**
 * Per-run token so a claim literal (`${runToken()}.${ALIAS_CLAIM}`, SC11's
 * shape) never collides across concurrent runs on the shared dev database.
 * `tenant_claims` and `tenant_claim_events` both lack a per-run-safe unique
 * key that would make a collision loud, so this prefix is what keeps "one
 * row" from silently becoming two.
 *
 * Moved here from two local copies (round-4/SC11 RT3) — mandating the shape
 * without shipping the helper produces a third.
 */
export function runToken(): string {
  return randomBytes(4).toString("hex");
}
