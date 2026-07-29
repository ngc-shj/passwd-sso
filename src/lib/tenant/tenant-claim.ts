import type { Account } from "next-auth";
import { createHash } from "node:crypto";
import { UNSAFE_DISPLAY_CHARS_GLOBAL_RE } from "@/lib/security/unsafe-display-chars";
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

function sanitizeTenantClaimValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Control, bidi and zero-width characters — see @/lib/security/
  // unsafe-display-chars for the members and for why the set is shared with
  // the delegation metadata boundary.
  // This value is rendered to an operator (audit metadata, Tenant.name, the
  // CLI's terminal output), so a bidi-override or zero-width character could
  // visually spoof the claim shown. Stripped only from the value that gets
  // displayed — the stored/matched form is unaffected by this rider since C1's
  // ASCII CHECK constraint already excludes these characters from what can be
  // stored.
  //
  // Strip BEFORE trimming: a zero-width character is not White_Space, so
  // trimming first leaves the space it was hiding behind at the edge of the
  // value, and that value becomes Tenant.name/externalId and the D1 fallback's
  // exact-match key.
  const cleaned = value.replace(UNSAFE_DISPLAY_CHARS_GLOBAL_RE, "").trim();
  if (cleaned.length === 0 || cleaned.length > MAX_TENANT_CLAIM_LENGTH) {
    return null;
  }
  return cleaned;
}

/**
 * Read one claim key off the profile. `hd` carries the provider gate described
 * on GOOGLE_HOSTED_DOMAIN_KEY; every other key is read as presented.
 */
function readClaimKey(
  key: string,
  account: Account | null | undefined,
  profile: Record<string, unknown>,
): string | null {
  if (key === GOOGLE_HOSTED_DOMAIN_KEY && account?.provider !== "google") return null;
  return sanitizeTenantClaimValue(profile[key]);
}

export function extractTenantClaimValue(
  account?: Account | null,
  profile?: Record<string, unknown> | null,
): string | null {
  if (!profile) return null;

  const keys = parseTenantClaimKeys();
  for (const key of keys) {
    const cleaned = readClaimKey(key, account, profile);
    if (cleaned) return cleaned;
  }

  // Google Workspace fallback: hosted domain claim (hd). Unchanged for the
  // default key list, which does not name it; an operator who does name it
  // reaches the same value earlier, through the loop, and nothing else.
  const cleaned = readClaimKey(GOOGLE_HOSTED_DOMAIN_KEY, account, profile);
  if (cleaned) return cleaned;

  return null;
}
