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
import { vi } from "vitest";
import {
  CLAIM_BINDING_MODE,
  JACKSON_CONNECTION_PROVIDER_ID_PREFIX,
  deriveClaimBindingMode,
  type ClaimBindingMode,
  type ProviderEnvKey,
} from "@/lib/auth/jackson-providers";

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

/**
 * Every env variable `jackson-providers.ts` reads to decide which claim
 * providers exist and which binding mode applies. Keyed by its own
 * `ProviderEnvKey`, so a variable added there does not compile here until it
 * is listed — the three suites that stub this env used to carry three
 * hand-written copies of the list.
 */
const PROVIDER_ENV: Record<ProviderEnvKey, true> = {
  AUTH_GOOGLE_ID: true,
  AUTH_GOOGLE_SECRET: true,
  JACKSON_URL: true,
  AUTH_JACKSON_ID: true,
  AUTH_JACKSON_SECRET: true,
  AUTH_JACKSON_CONNECTIONS: true,
  AUTH_CLAIM_BINDING: true,
  SAML_PROVIDER_NAME: true,
};
export const PROVIDER_ENV_KEYS = Object.keys(PROVIDER_ENV) as ProviderEnvKey[];

/**
 * Which claim providers to configure: Google, the legacy Jackson provider
 * (`AUTH_JACKSON_ID`/`SECRET`), and Jackson connections by provider id.
 */
export type ProviderEnvSpec = {
  google?: boolean;
  legacy?: boolean;
  connections?: readonly string[];
  mode?: ClaimBindingMode;
};

/**
 * Stub the SSO provider env to exactly `spec` — every other provider variable
 * blank, whatever the developer's `.env` sets — and assert the mode the
 * production derivation then reports. `{}` is "no claim provider": off.
 *
 * The expected mode is the documented rule (two or more claim providers force
 * strict; otherwise the variable, default off), so a stub that did not take —
 * a variable this list missed — fails here rather than as an unrelated
 * assertion in the cell.
 */
export function stubClaimProviderEnv(spec: ProviderEnvSpec): void {
  for (const key of PROVIDER_ENV_KEYS) vi.stubEnv(key, "");
  const connections = spec.connections ?? [];
  if (spec.google) {
    vi.stubEnv("AUTH_GOOGLE_ID", "claim-fixture-google-id");
    vi.stubEnv("AUTH_GOOGLE_SECRET", "claim-fixture-google-secret");
  }
  if (spec.legacy) {
    vi.stubEnv("AUTH_JACKSON_ID", "client-saml-jackson");
    vi.stubEnv("AUTH_JACKSON_SECRET", "secret-saml-jackson");
  }
  if (spec.legacy || connections.length > 0) {
    vi.stubEnv("JACKSON_URL", "http://jackson.invalid");
  }
  if (connections.length > 0) {
    vi.stubEnv(
      "AUTH_JACKSON_CONNECTIONS",
      JSON.stringify(
        connections.map((providerId) => ({
          id: providerId.slice(JACKSON_CONNECTION_PROVIDER_ID_PREFIX.length),
          name: providerId,
          clientId: `client-${providerId}`,
          clientSecret: `secret-${providerId}`,
        })),
      ),
    );
  }
  if (spec.mode) vi.stubEnv("AUTH_CLAIM_BINDING", spec.mode);

  const providers = (spec.google ? 1 : 0) + (spec.legacy ? 1 : 0) + connections.length;
  const expected = providers >= 2 ? CLAIM_BINDING_MODE.STRICT : (spec.mode ?? CLAIM_BINDING_MODE.OFF);
  const derived = deriveClaimBindingMode();
  if (derived !== expected) {
    throw new Error(`stubClaimProviderEnv(${JSON.stringify(spec)}): derived mode ${derived}, expected ${expected}`);
  }
}
