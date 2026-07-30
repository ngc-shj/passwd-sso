import type { Account } from "next-auth";
import { createHash } from "node:crypto";
import {
  UNSAFE_DISPLAY_CHARS_RE,
  escapeUnsafeDisplayChars,
} from "@/lib/security/unsafe-display-chars";
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
 * What one claim key on the profile yielded.
 *
 * Three arms rather than `string | null`, and the split is the whole point
 * (round-3 M1). Round 2 changed this boundary from strip to reject — right for
 * the matching key — but routed the refusal through the same `null` that an
 * ABSENT attribute produces, and both consumers read that `null` as "the IdP
 * asserted no claim", which is an ALLOW. So `beta.example` + U+200B, a
 * spelling round 2 denied, silently became a sign-in into whatever tenant the
 * user was already in, and on the first-ever-sign-in path a fresh bootstrap
 * tenant with role OWNER — round-1 M1's overloaded `null` reappearing one
 * layer up.
 *
 * The classification below is per-cause, not per-`return null`:
 *
 * | Cause                          | Arm       | Why |
 * |--------------------------------|-----------|-----|
 * | key absent / `undefined` / `null` | absent | nothing was asserted |
 * | empty or whitespace-only string | absent    | an empty assertion is not an assertion — IdPs emit empty attributes for unset fields, and refusing would deny sign-ins that work today (NF2) for no gain, since the same actor can just omit the key |
 * | value present, not a string     | malformed | the key the operator made authoritative WAS asserted and this deployment cannot read it; falling through to the next key would let a lower-priority, self-asserted attribute decide the tenant |
 * | unsafe display characters       | malformed | round-2 F-D: the value must not be canonicalised onto a neighbouring claim, and must not be dropped either |
 * | longer than MAX_TENANT_CLAIM_LENGTH | malformed | a claim that cannot be stored cannot be honoured |
 */
type ClaimKeyRead =
  | { kind: "claim"; value: string }
  | { kind: "absent" }
  | { kind: "malformed"; display: string };

const ABSENT: ClaimKeyRead = { kind: "absent" };

function malformed(display: string): ClaimKeyRead {
  // Escaped, never stripped, and capped at the same bound the audit metadata
  // applies: this string exists so the denial is diagnosable — it reaches
  // metadata.claim on the AUTH_LOGIN_FAILURE row and, through that, the CSV
  // export and the operator terminal. It is a RENDERING and is never used as
  // a resolution key.
  return { kind: "malformed", display: escapeUnsafeDisplayChars(display, MAX_TENANT_CLAIM_LENGTH) };
}

function sanitizeTenantClaimValue(value: unknown): ClaimKeyRead {
  if (value === undefined || value === null) return ABSENT;
  // The attribute carries something that is not a claim string. Reporting the
  // type rather than the value: a non-string can be an object of arbitrary
  // depth and content, and none of it belongs on an audit row.
  if (typeof value !== "string") return malformed(`<${typeof value}>`);

  // Control, bidi and zero-width characters — see @/lib/security/
  // unsafe-display-chars for the members and for why the set is shared with
  // the delegation metadata boundary.
  //
  // REJECT, do not strip (round-2 F-D). This function's usable return value is
  // not a display copy: it becomes `tenantClaim`, which is the key
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
  if (UNSAFE_DISPLAY_CHARS_RE.test(value)) return malformed(value);

  const cleaned = value.trim();
  if (cleaned.length === 0) return ABSENT;
  if (cleaned.length > MAX_TENANT_CLAIM_LENGTH) return malformed(cleaned);
  return { kind: "claim", value: cleaned };
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
): ClaimKeyRead {
  // `absent`, not `malformed`: the gate is a refusal to READ, not a judgement
  // on a value. A SAML profile that happens to carry a field named `hd` has
  // asserted nothing this deployment consults, and classifying it as malformed
  // would deny every sign-in from such a profile.
  if (key.toLowerCase() === GOOGLE_HOSTED_DOMAIN_KEY && account?.provider !== "google") {
    return ABSENT;
  }
  return sanitizeTenantClaimValue(profile[key]);
}

/** See ClaimKeyRead — the arms and the reason there are three of them. */
export type TenantClaimExtraction = ClaimKeyRead;

export function extractTenantClaimValue(
  account?: Account | null,
  profile?: Record<string, unknown> | null,
): TenantClaimExtraction {
  if (!profile) return ABSENT;

  const keys = parseTenantClaimKeys();
  for (const key of keys) {
    const read = readClaimKey(key, account, profile);
    // A malformed value STOPS the walk. Continuing would make the tenant
    // depend on which higher-priority key happened to be unreadable — the
    // same silent-promotion fail-open the three arms exist to close, just
    // between keys instead of between callers.
    if (read.kind !== "absent") return read;
  }

  // Google Workspace fallback: hosted domain claim (hd). Unchanged for the
  // default key list, which does not name it; an operator who does name it
  // reaches the same value earlier, through the loop, and nothing else.
  return readClaimKey(GOOGLE_HOSTED_DOMAIN_KEY, account, profile);
}
