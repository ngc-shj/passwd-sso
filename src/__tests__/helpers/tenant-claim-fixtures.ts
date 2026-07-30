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
export const PRIMARY_CLAIM = "primary.example";
export const ALIAS_CLAIM = "alias.example";
export const NON_DOMAIN_CLAIM = "acmecorp";
