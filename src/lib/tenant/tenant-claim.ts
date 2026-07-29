import type { Account } from "next-auth";
import { createHash } from "node:crypto";
import { UNSAFE_DISPLAY_CHARS_RE } from "@/lib/security/unsafe-display-chars";
import { SLUG_MAX_LENGTH } from "@/lib/validations/common";
import { MAX_TENANT_CLAIM_LENGTH, BOOTSTRAP_SLUG_HASH_LENGTH } from "@/lib/validations/common.server";

const DEFAULT_TENANT_CLAIM_KEYS = [
  "tenant_id",
  "tenantId",
  "organization",
  "org",
  "company",
  "company_id",
] as const;

/**
 * Google Workspace's hosted-domain claim. Unlike the keys above it is asserted
 * by Google rather than carried in a self-describing profile attribute, so it
 * is only ever honoured for the google provider — whether it is reached
 * through AUTH_TENANT_CLAIM_KEYS or through the fallback at the bottom of
 * extractTenantClaimValue. Naming it in AUTH_TENANT_CLAIM_KEYS is what makes
 * "attested claim only" an expressible configuration (round-1 M4).
 */
const GOOGLE_HOSTED_DOMAIN_KEY = "hd";

export function parseTenantClaimKeys(): string[] {
  const configured = process.env.AUTH_TENANT_CLAIM_KEYS?.trim();
  if (!configured) return [...DEFAULT_TENANT_CLAIM_KEYS];
  return configured
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

const RESERVED_SLUG_PREFIXES = ["bootstrap-", "u-"];

export function slugifyTenant(input: string): string {
  let slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH);

  // Fallback for non-ASCII-only inputs (e.g. Japanese org names)
  if (!slug) {
    return createHash("sha256").update(input.trim()).digest("hex").slice(0, BOOTSTRAP_SLUG_HASH_LENGTH);
  }

  // Prevent collision with reserved internal prefixes
  if (RESERVED_SLUG_PREFIXES.some((p) => slug.startsWith(p))) {
    slug = `t-${slug}`.slice(0, SLUG_MAX_LENGTH);
  }
  return slug;
}

/**
 * What this boundary made of one IdP-asserted tenant claim.
 *
 * Three arms, not two, because BOTH consumers read "no claim" as an allow:
 * src/auth.ts falls through to the claim-less path, and the adapter's
 * createUser creates a fresh bootstrap tenant with role OWNER. A single `null`
 * for "absent" and "refused" therefore turns every refusal into an allow —
 * round-2 F-D fixed the matching key by returning null instead of stripping,
 * and in doing so aimed the refusal straight at that allow (round-3 S3-1/F3).
 * This is round-1 M1's overloaded-null defect one layer up, with the same
 * remedy: make the refusal a value of its own.
 */
export type TenantClaimExtraction =
  | { kind: "none" }
  | { kind: "value"; value: string }
  | { kind: "malformed" };

const CLAIM_NONE = { kind: "none" } as const satisfies TenantClaimExtraction;
const CLAIM_MALFORMED = { kind: "malformed" } as const satisfies TenantClaimExtraction;

/**
 * Classify one attribute value.
 *
 * The split is "did the IdP assert something we then refused?", and the test
 * that decides it is whether the input buys the sender anything that simply
 * OMITTING the attribute would not:
 *
 *  - absent / JSON null -> `none`. Omission by another spelling; there is no
 *    asserted value to refuse, and reporting it as a refusal would deny every
 *    IdP that leaves the attribute empty for its non-SSO users.
 *  - anything else -> `malformed`. A non-string (a multi-valued SAML attribute
 *    arrives as an array), an empty or whitespace-only string, an over-long
 *    one, or one carrying a member of the unsafe-display class are all values
 *    the IdP DID assert and we cannot use. Each is a shape the party that
 *    controls the attribute can choose *instead of* the value that would have
 *    denied them, so each has to reach a refusal rather than the claim-less
 *    allow.
 */
function classifyTenantClaimValue(value: unknown): TenantClaimExtraction {
  if (value === undefined || value === null) return CLAIM_NONE;

  if (typeof value !== "string") return CLAIM_MALFORMED;

  // Control, bidi and zero-width characters — see @/lib/security/
  // unsafe-display-chars for the members and for why the set is shared with
  // the delegation metadata boundary.
  //
  // REJECT, do not strip (round-2 F-D). This function's return value is not a
  // display copy: it becomes `tenantClaim`, which is the key
  // resolveTenantByClaim / findOrCreateTenantForClaim match on and the value
  // stored verbatim as Tenant.externalId and Tenant.name. Stripping is what
  // would let `ac<U+00AD>me.example` — a value an operator reads as distinct
  // from `acme.example` — pass C1's printable-ASCII CHECK and select the
  // existing `acme.example` tenant, with nothing recorded anywhere: the
  // character is gone before storage, so `preflight`'s non-ASCII report can
  // never see it. The delegation metadata boundary
  // (src/lib/auth/access/delegation.ts's isSafeMetadataString) already takes
  // this policy for the same class; this is the same rule at the other end of
  // the shared definition. Note the direction of the dependency the old
  // comment here inverted: the ASCII CHECK does not make stripping harmless,
  // stripping is what lets a non-ASCII input satisfy the CHECK.
  if (UNSAFE_DISPLAY_CHARS_RE.test(value)) return CLAIM_MALFORMED;

  const cleaned = value.trim();
  if (cleaned.length === 0 || cleaned.length > MAX_TENANT_CLAIM_LENGTH) {
    return CLAIM_MALFORMED;
  }
  return { kind: "value", value: cleaned };
}

/**
 * Read one claim key off the profile. `hd` carries the provider gate described
 * on GOOGLE_HOSTED_DOMAIN_KEY; every other key is read as presented.
 *
 * The gate compares case-INSENSITIVELY (round-2 F-C). `AUTH_TENANT_CLAIM_KEYS`
 * is operator-typed free text, and an operator who writes `HD` — following the
 * README's "attested claim only" guidance — was previously getting no gate at
 * all: `profile["HD"]` was read from ANY provider, self-asserted, while the
 * configuration read as attested-only. The key itself is NOT case-folded, since
 * profile attribute names are case-sensitive (`tenantId` must stay `tenantId`);
 * only the gate's decision is. A Google profile spells the attribute `hd`, so
 * `HD` reads nothing there and the fallback at the bottom of
 * extractTenantClaimValue supplies the attested value as before.
 */
function readClaimKey(
  key: string,
  account: Account | null | undefined,
  profile: Record<string, unknown>,
): TenantClaimExtraction {
  if (key.toLowerCase() === GOOGLE_HOSTED_DOMAIN_KEY && account?.provider !== "google") {
    // Not read at all for this provider, so nothing was asserted TO US —
    // "none", not a refusal.
    return CLAIM_NONE;
  }
  return classifyTenantClaimValue(profile[key]);
}

export function extractTenantClaimValue(
  account?: Account | null,
  profile?: Record<string, unknown> | null,
): TenantClaimExtraction {
  if (!profile) return CLAIM_NONE;

  // A key that yields a usable value wins over an earlier one that did not:
  // refusing the whole extraction on the first unusable key would deny
  // profiles that carry a perfectly good claim under another configured key.
  // The refusal survives only when NO key produced a value — which is exactly
  // the case an attacker reaches by mangling the attribute that names them.
  let refused = false;

  const keys = parseTenantClaimKeys();
  for (const key of keys) {
    const result = readClaimKey(key, account, profile);
    if (result.kind === "value") return result;
    if (result.kind === "malformed") refused = true;
  }

  // Google Workspace fallback: hosted domain claim (hd). Unchanged for the
  // default key list, which does not name it; an operator who does name it
  // reaches the same value earlier, through the loop, and nothing else.
  const fallback = readClaimKey(GOOGLE_HOSTED_DOMAIN_KEY, account, profile);
  if (fallback.kind === "value") return fallback;
  if (fallback.kind === "malformed") refused = true;

  return refused ? CLAIM_MALFORMED : CLAIM_NONE;
}
