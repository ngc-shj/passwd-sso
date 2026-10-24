/**
 * The configured SSO provider set — one parser for every reader.
 *
 * `auth.config.ts` builds the Auth.js providers from it, `env-schema.ts`
 * validates the same variables at boot, and the sign-in page, the
 * auth-provider route and the audit provider mapping ask it which provider ids
 * exist. A second copy of any of these predicates is how a button, a provider
 * and a boot rule drift apart.
 *
 * Must stay prisma-free: the tenant-domain CLI reads the configured set and the
 * derived binding mode through this module.
 *
 * Every Jackson provider is bound to exactly one Jackson connection: its own
 * client id and secret, exchanged without PKCE. Jackson's PKCE branch does not
 * authenticate the client at the token endpoint, so with PKCE an IdP behind one
 * connection can complete a sign-in through another connection's client; only a
 * no-PKCE exchange with the connection's own credentials attests which
 * connection authenticated the user (plan sso-claim-connection-binding, M1/M9).
 */

import { UNSAFE_DISPLAY_CHARS_RE } from "@/lib/security/unsafe-display-chars";

/** Provider id of the single connection configured by AUTH_JACKSON_ID/SECRET. */
export const JACKSON_LEGACY_PROVIDER_ID = "saml-jackson";

/** Prefix of the provider ids built from AUTH_JACKSON_CONNECTIONS entries. */
export const JACKSON_CONNECTION_PROVIDER_ID_PREFIX = `${JACKSON_LEGACY_PROVIDER_ID}-`;

export const GOOGLE_PROVIDER_ID = "google";

/**
 * Shape of every provider id the app records as claim provenance. The DB CHECK
 * on the provenance columns states the same pattern; a parity test holds the
 * two together, so change both or neither.
 */
export const PROVIDER_ID_PATTERN = "^[a-z0-9-]{1,64}$";
const PROVIDER_ID_RE = new RegExp(PROVIDER_ID_PATTERN);

export function isProviderIdShape(id: string): boolean {
  return PROVIDER_ID_RE.test(id);
}

const CONNECTION_ID_RE = /^[a-z0-9-]{1,32}$/;
const CONNECTION_NAME_MAX_LENGTH = 64;
const CONNECTION_ENTRY_KEYS = ["id", "name", "clientId", "clientSecret"] as const;

/** Jackson's global client: tenant/product come from the authorize request. */
const JACKSON_DUMMY_CREDENTIAL = "dummy";
/** Prefix of Jackson federation (SAML Federation app) client ids. */
const JACKSON_FEDERATION_CLIENT_ID_PREFIX = "fed_";

export const CLAIM_BINDING_MODE = {
  OFF: "off",
  STRICT: "strict",
} as const;

export type ClaimBindingMode = (typeof CLAIM_BINDING_MODE)[keyof typeof CLAIM_BINDING_MODE];

const CLAIM_BINDING_MODES: readonly string[] = Object.values(CLAIM_BINDING_MODE);

/** The env variables this module reads. */
export type ProviderEnvKey =
  | "AUTH_GOOGLE_ID"
  | "AUTH_GOOGLE_SECRET"
  | "JACKSON_URL"
  | "AUTH_JACKSON_ID"
  | "AUTH_JACKSON_SECRET"
  | "AUTH_JACKSON_CONNECTIONS"
  | "AUTH_CLAIM_BINDING"
  | "SAML_PROVIDER_NAME";

/** `process.env` or any record of raw (untrimmed) values for those keys. */
export type ProviderEnv = Readonly<Record<string, string | undefined>>;

export interface JacksonProviderConfig {
  /** Auth.js provider id: `saml-jackson` or `saml-jackson-<entry id>`. */
  id: string;
  /** Sign-in button label. */
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
}

/**
 * A refused provider configuration. The message names the variable and, for
 * an entry, its position — never a value: client secrets, client ids and the
 * raw JSON stay out of it, because boot errors are printed and shipped.
 */
export class ProviderConfigError extends Error {
  /** The env variable alone — boot diagnostics and init-env key on it. */
  readonly variable: string;

  /** `where` is the variable, or `VARIABLE[index]` for a connection entry. */
  constructor(where: string, detail: string) {
    super(`${where}: ${detail}`);
    this.name = "ProviderConfigError";
    this.variable = where.split("[")[0];
  }
}

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Registration predicate for the Google provider — the one `auth.config.ts`
 * registers it under and every other reader counts it by.
 */
export function isGoogleProviderConfigured(env: ProviderEnv = process.env): boolean {
  return !!(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET);
}

function assertBindableClientId(variable: string, clientId: string): void {
  if (clientId.toLowerCase() === JACKSON_DUMMY_CREDENTIAL) {
    throw new ProviderConfigError(
      variable,
      "client id is Jackson's global placeholder client, which binds to no connection; use the connection's own client id",
    );
  }
  if (clientId.includes("=") || clientId.includes("&")) {
    throw new ProviderConfigError(
      variable,
      "client id is a tenant/product-encoded id, which binds to no connection; use the connection's own client id",
    );
  }
  if (clientId.toLowerCase().startsWith(JACKSON_FEDERATION_CLIENT_ID_PREFIX)) {
    throw new ProviderConfigError(
      variable,
      "client id is a Jackson federation app id; use the connection's own client id",
    );
  }
}

function assertRealSecret(variable: string, clientSecret: string): void {
  if (clientSecret.toLowerCase() === JACKSON_DUMMY_CREDENTIAL) {
    throw new ProviderConfigError(
      variable,
      "client secret is Jackson's placeholder; use the connection's own client secret",
    );
  }
}

function parseConnectionEntries(raw: string): Array<Record<(typeof CONNECTION_ENTRY_KEYS)[number], string>> {
  const variable = "AUTH_JACKSON_CONNECTIONS";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The SyntaxError message embeds a prefix of the input, which holds
    // secrets; it is dropped, not wrapped.
    throw new ProviderConfigError(variable, "is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new ProviderConfigError(variable, "must be a JSON array of { id, name, clientId, clientSecret }");
  }
  if (parsed.length === 0) {
    throw new ProviderConfigError(variable, "is set but names no connection (leave it unset instead)");
  }
  return parsed.map((entry: unknown, index) => {
    const at = `${variable}[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ProviderConfigError(at, "must be an object { id, name, clientId, clientSecret }");
    }
    const record = entry as Record<string, unknown>;
    const unknownKeys = Object.keys(record).filter(
      (key) => !(CONNECTION_ENTRY_KEYS as readonly string[]).includes(key),
    );
    if (unknownKeys.length > 0) {
      // A count, not the names: a malformed entry can hold a secret where a
      // key was meant, and the count is enough to act on.
      throw new ProviderConfigError(
        at,
        `has ${unknownKeys.length} unknown field(s); allowed: ${CONNECTION_ENTRY_KEYS.join(", ")}`,
      );
    }
    const fields = {} as Record<(typeof CONNECTION_ENTRY_KEYS)[number], string>;
    for (const key of CONNECTION_ENTRY_KEYS) {
      const value = record[key];
      if (typeof value !== "string" || value.trim() === "") {
        throw new ProviderConfigError(at, `${key} must be a non-empty string`);
      }
      // The id is matched as given: a padded id is a different id, refused
      // below rather than silently becoming its neighbour.
      fields[key] = key === "id" ? value : value.trim();
    }
    return fields;
  });
}

/**
 * Parses the Jackson providers from the env, refusing every configuration
 * whose client could complete a sign-in for a connection other than its own.
 * Throws `ProviderConfigError`; returns `[]` when no Jackson provider is
 * configured. The legacy pair counts only when both halves are set (a partial
 * pair registers nothing, as before).
 */
export function parseJacksonProviders(env: ProviderEnv = process.env): JacksonProviderConfig[] {
  const legacyId = present(env.AUTH_JACKSON_ID);
  const legacySecret = present(env.AUTH_JACKSON_SECRET);
  const rawConnections = present(env.AUTH_JACKSON_CONNECTIONS);

  const providers: Array<Omit<JacksonProviderConfig, "issuer"> & { source: string }> = [];

  if (legacyId && legacySecret) {
    assertBindableClientId("AUTH_JACKSON_ID", legacyId);
    assertRealSecret("AUTH_JACKSON_SECRET", legacySecret);
    providers.push({
      id: JACKSON_LEGACY_PROVIDER_ID,
      name: env.SAML_PROVIDER_NAME ?? "SSO",
      clientId: legacyId,
      clientSecret: legacySecret,
      source: "AUTH_JACKSON_ID",
    });
  }

  if (rawConnections) {
    const seenIds = new Set<string>();
    parseConnectionEntries(rawConnections).forEach((entry, index) => {
      const at = `AUTH_JACKSON_CONNECTIONS[${index}]`;
      if (!CONNECTION_ID_RE.test(entry.id)) {
        throw new ProviderConfigError(at, "id must match ^[a-z0-9-]{1,32}$");
      }
      if (seenIds.has(entry.id)) {
        throw new ProviderConfigError(at, `id "${entry.id}" is used by an earlier entry`);
      }
      seenIds.add(entry.id);
      // The name is the sign-in button label.
      if (entry.name.length > CONNECTION_NAME_MAX_LENGTH || UNSAFE_DISPLAY_CHARS_RE.test(entry.name)) {
        throw new ProviderConfigError(
          at,
          `name must be at most ${CONNECTION_NAME_MAX_LENGTH} characters with no control, bidi or invisible characters`,
        );
      }
      assertBindableClientId(at, entry.clientId);
      assertRealSecret(at, entry.clientSecret);
      providers.push({
        id: `${JACKSON_CONNECTION_PROVIDER_ID_PREFIX}${entry.id}`,
        name: entry.name,
        clientId: entry.clientId,
        clientSecret: entry.clientSecret,
        source: `${at} (id "${entry.id}")`,
      });
    });
  }

  // One client id behind two provider ids would let either id complete the
  // other's sign-ins — the binding the provider id is supposed to attest.
  const firstSourceByClientId = new Map<string, string>();
  for (const provider of providers) {
    const earlier = firstSourceByClientId.get(provider.clientId);
    if (earlier) {
      // The legacy pair is one provider, so a duplicate always involves an entry.
      throw new ProviderConfigError(
        "AUTH_JACKSON_CONNECTIONS",
        `${provider.source} has the same client id as ${earlier}; each provider needs its own connection`,
      );
    }
    firstSourceByClientId.set(provider.clientId, provider.source);
  }

  if (providers.length === 0) return [];

  const issuer = present(env.JACKSON_URL);
  if (!issuer) {
    throw new ProviderConfigError("JACKSON_URL", "is required when a Jackson connection is configured");
  }

  return providers.map(({ id, name, clientId, clientSecret }) => ({
    id,
    name,
    issuer,
    clientId,
    clientSecret,
  }));
}

/** Membership in the configured Jackson provider set — not a prefix match. */
export function isJacksonProviderId(id: string, env: ProviderEnv = process.env): boolean {
  return parseJacksonProviders(env).some((provider) => provider.id === id);
}

/** Provider ids whose sign-ins can present a tenant claim: Google and every Jackson provider. */
export function listClaimProviderIds(env: ProviderEnv = process.env): string[] {
  return [
    ...(isGoogleProviderConfigured(env) ? [GOOGLE_PROVIDER_ID] : []),
    ...parseJacksonProviders(env).map((provider) => provider.id),
  ];
}

export function countClaimProviders(env: ProviderEnv = process.env): number {
  return listClaimProviderIds(env).length;
}

function configuredClaimBindingMode(env: ProviderEnv): ClaimBindingMode | undefined {
  const raw = env.AUTH_CLAIM_BINDING;
  if (raw === undefined || raw.trim() === "") return undefined;
  if (!CLAIM_BINDING_MODES.includes(raw)) {
    throw new ProviderConfigError(
      "AUTH_CLAIM_BINDING",
      `must be one of ${CLAIM_BINDING_MODES.join(", ")} (lowercase)`,
    );
  }
  return raw as ClaimBindingMode;
}

/**
 * The binding mode the adjudicator enforces. With two or more claim providers
 * it is `strict` whatever AUTH_CLAIM_BINDING says — a claim must not resolve
 * through a provider it is not bound to, and that holds without the operator's
 * help. With fewer it is the variable's value, default `off`. Computed per
 * call: no module-level cache, so tests and the CLI select the env explicitly.
 */
export function deriveClaimBindingMode(env: ProviderEnv = process.env): ClaimBindingMode {
  const configured = configuredClaimBindingMode(env);
  if (countClaimProviders(env) >= 2) return CLAIM_BINDING_MODE.STRICT;
  return configured ?? CLAIM_BINDING_MODE.OFF;
}

/**
 * Boot refusal, separate from the derivation: with two or more claim providers
 * the app starts only when AUTH_CLAIM_BINDING=strict is set explicitly. The
 * derived mode is already strict there; the refusal makes an upgrade stop at
 * deploy time, before claim rows recorded without a provider refuse every
 * claim-routed sign-in. The CLI never calls this, so its binding commands run
 * in the window before strict is set.
 */
export function assertClaimBindingBootConfig(env: ProviderEnv = process.env): void {
  const configured = configuredClaimBindingMode(env);
  const count = countClaimProviders(env);
  if (count >= 2 && configured !== CLAIM_BINDING_MODE.STRICT) {
    throw new ProviderConfigError(
      "AUTH_CLAIM_BINDING",
      `must be set to "strict" when ${count} SSO providers can present a tenant claim; ` +
        "bind the existing tenant claims to their providers first (README: SSO tenant claim binding upgrade)",
    );
  }
}
