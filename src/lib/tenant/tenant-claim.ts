import type { Account } from "next-auth";
import { createHash } from "node:crypto";
import { claimRefusal, type ClaimRefusalDiagnosis } from "@/lib/tenant/claim-refusal";
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

/**
 * Thrown when `AUTH_TENANT_CLAIM_KEYS` is set to something that names no key at
 * all (`","`, `",,"`, `" , "`). Round-6, raised independently by Codex.
 *
 * The old parser filtered the empty entries away and returned `[]`, so the walk
 * read nothing and fell through to the `hd` fallback — which on a SAML
 * deployment resolves no claim for any sign-in, and a first-ever SAML user is
 * then created in their own bootstrap tenant as OWNER. An operator who
 * configured a claim-key list got the behaviour of having configured none, with
 * no signal. That is the module's own rule from
 * `scripts/lib/tenant-domain-flags.ts` at the env boundary: an instruction the
 * operator believes was applied must either take effect or stop the command.
 *
 * Throwing (rather than falling back) is fail-closed: it propagates to
 * `src/auth.ts`'s signIn catch, which emits `provider_error` and writes
 * nothing. `envSchema` rejects the same value at boot, so in a normally-started
 * app this branch is unreachable — the asymmetry is deliberate and has the same
 * shape as D-23's pepper floor: this module reads `process.env` directly, so a
 * process that never parsed the schema still has to be refused here.
 *
 * A DUPLICATE key is deliberately NOT an error here. Reading the same profile
 * attribute twice takes effect exactly once and changes no outcome, so it is
 * config hygiene rather than a silently-dropped instruction; `envSchema`
 * rejects it at boot, where hygiene belongs.
 */
export class TenantClaimKeysMisconfiguredError extends Error {
  constructor() {
    super("AUTH_TENANT_CLAIM_KEYS_NAMES_NO_KEY");
    this.name = "TenantClaimKeysMisconfiguredError";
  }
}

export function parseTenantClaimKeys(): string[] {
  const configured = process.env.AUTH_TENANT_CLAIM_KEYS?.trim();
  if (!configured) return [...DEFAULT_TENANT_CLAIM_KEYS];
  const keys = configured
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  if (keys.length === 0) throw new TenantClaimKeysMisconfiguredError();
  return keys;
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
 * The classification is per-cause, not per-`return null`. Round 4 corrected two
 * of the arms round 3 got wrong; the table below is the settled version:
 *
 * | Cause | Arm | Why |
 * |---|---|---|
 * | key absent / `undefined` / `null` | absent | nothing was asserted |
 * | value present, not a string | absent | round-4 F2/S6 — see below |
 * | empty, or whitespace-only under EITHER trim | absent | an empty assertion is not an assertion; IdPs emit empty attributes for unset fields, and refusing would deny sign-ins that work today (NF2) for no gain, since the same actor can just omit the key |
 * | unsafe display characters | **malformed** | round-2 F-D: the value must not be canonicalised onto a neighbouring claim, and must not be dropped either |
 * | edges JS `.trim()` would strip but ASCII trim does not (e.g. U+00A0) | **malformed** | `normalizeTenantClaim` trims with JS semantics downstream, so accepting these means the value MATCHED on is not the value asserted — the same canonicalisation hazard as the unsafe class |
 * | longer than `MAX_TENANT_CLAIM_LENGTH` | **malformed** | a claim that cannot be stored cannot be honoured, and padding a losing claim past the cap must not convert its denial into the claim-less allow |
 *
 * **Non-string is `absent`, not `malformed` (round-4 F2 + S6, converged).**
 * Round 3 denied it, reasoning that the operator made this key authoritative
 * so falling through would let a lower-priority attribute decide the tenant.
 * That conflated two decisions — *stop the key walk* and *deny the sign-in* —
 * and only the first followed. SAML attributes are multi-valued by
 * specification and BoxyHQ Jackson surfaces them into the OIDC profile as JSON
 * arrays, so a deployment whose `organization` arrives as `["acme"]` — with
 * `organization` in the shipped default key list — went from resolving
 * correctly to denying EVERY sign-in. Nor does denying buy anything: an actor
 * who can change the attribute's TYPE can equally remove the attribute, and
 * omission reaches the same claim-less path, so the arm closes no hole that
 * absence does not already open. A non-string is not a claim string; the key
 * carries no claim and the walk continues, exactly as it did before round 3.
 *
 * **Whitespace is trimmed BEFORE the unsafe-character test (round-4 T2).**
 * `\t \n \r \v \f` are C0 controls, so they are members of the unsafe class as
 * well as `.trim()` whitespace. Testing first meant `"acme.example\n"` — the
 * ordinary shape of a pretty-printed SAML `<AttributeValue>` — was refused and
 * the sign-in denied. The trim is deliberately **ASCII-only** rather than JS
 * `.trim()`: `.trim()` also strips U+FEFF, which IS in the unsafe class, and
 * stripping it would silently canonicalise a U+FEFF-prefixed `acme.example` onto the
 * existing `acme.example` tenant — the exact F-D hazard the reject policy
 * exists to prevent. Whitespace the ASCII trim leaves but `.trim()` would take
 * is therefore its own refusal arm rather than a silent strip.
 */
type ClaimKeyRead =
  | { kind: "claim"; value: string }
  | { kind: "absent" }
  | { kind: "malformed"; diagnosis: ClaimRefusalDiagnosis };

const ABSENT: ClaimKeyRead = { kind: "absent" };

/** ASCII whitespace only — see the note above on why not `.trim()`. */
const ASCII_WHITESPACE_EDGES_RE = /^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g;

/**
 * A refusal carries a DIAGNOSIS of the value, never the value itself
 * (round-4 S1/S2, user-chosen).
 *
 * Round 3 put an escaped rendering of the refused value here, so that an
 * operator could see which claim their IdP had started mangling. That put an
 * attacker-chosen string on a path — `metadata.claim` -> `logAuditAsync` -> a
 * `jsonb` write -> the CSV export -> the operator's terminal — and the
 * encoding hazards followed immediately: truncating the rendering at
 * `MAX_TENANT_CLAIM_LENGTH` split a UTF-16 surrogate pair, Postgres rejects a
 * lone surrogate in `jsonb` with 22P02, and `logAuditAsync` swallows the error
 * into a dead-letter — so an actor could suppress the audit record of their
 * own denial by padding the claim past the cap with an emoji at the boundary.
 *
 * The diagnosis is printable ASCII, bounded, and describes the violation
 * rather than reproducing the value. It is strictly more actionable for the
 * remedy that actually applies (fix the IdP), because the operator needs to
 * know WHICH RULE the value broke, not what the value was — and the value is
 * unregistrable, so `tenant-domain add` could not consume it anyway.
 *
 * The `refused: ` prefix and the branded return type both come from
 * `claimRefusal()` (round-6 SEC-R6-3): round 5 gave the diagnosis its own
 * metadata key so an IdP could not forge it from the value side, but left the
 * key typed as a bare `string`, so the unforgeability was a convention. It is
 * now a compile-time property.
 */
function malformed(rule: string): ClaimKeyRead {
  return { kind: "malformed", diagnosis: claimRefusal(rule) };
}

/** Distinct offending code points, sorted, at most three — enough to fix the IdP. */
function describeUnsafeChars(value: string): string {
  const seen = new Set<number>();
  for (const char of value) {
    const cp = char.codePointAt(0);
    if (cp !== undefined && UNSAFE_DISPLAY_CHARS_RE.test(char)) seen.add(cp);
  }
  const listed = [...seen].sort((a, b) => a - b);
  const shown = listed
    .slice(0, 3)
    .map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`)
    .join(", ");
  return `contains ${shown}${listed.length > 3 ? ` and ${listed.length - 3} more` : ""}`;
}

function sanitizeTenantClaimValue(value: unknown): ClaimKeyRead {
  if (value === undefined || value === null) return ABSENT;
  // Not a claim string — the key carries no claim, so the walk continues.
  if (typeof value !== "string") return ABSENT;

  const cleaned = value.replace(ASCII_WHITESPACE_EDGES_RE, "");
  if (cleaned.length === 0) return ABSENT;

  // Whitespace-only under EITHER trim is `absent`, and this test has to run
  // BEFORE the unsafe-class test below (round-6 F2). Round 5 fixed the same
  // rule for `"　"` and placed the check after the unsafe test, which left the
  // three members of the whitespace class that are ALSO unsafe-class members
  // unable to reach it. Derived rather than sampled, which is how the
  // classification was wrong for three rounds running (r4 T2, r5 F4, r6 F2):
  // of the 25 code points JS `.trim()` strips, U+2028, U+2029 and U+FEFF are
  // in UNSAFE_DISPLAY_CHAR_RANGES, so a value consisting only of one of them
  // was DENIED — on `main` and in round 3 all three read as absent, so this is
  // the round-4 regression at its remaining members.
  //
  // Moving it up cannot canonicalise anything onto a neighbouring claim, which
  // is the hazard that puts the unsafe class ahead of everything else: a value
  // that is entirely JS-trim whitespace normalises to the EMPTY string, so
  // there is no neighbour for it to land on. The reject-don't-strip policy
  // still governs every value that has a non-whitespace character.
  if (cleaned.trim().length === 0) return ABSENT;

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
  if (UNSAFE_DISPLAY_CHARS_RE.test(cleaned)) return malformed(describeUnsafeChars(cleaned));

  // An unpaired surrogate is not text: it cannot round-trip through JSON or
  // Postgres, and it is not a member of the unsafe class, not whitespace and
  // usually under the cap — so before this arm it passed as a perfectly
  // ordinary claim (round-5 T1, verified: `"acme\uD83D.example"` yielded
  // `{kind:"claim"}` with `isWellFormed() === false`). It then reached
  // `metadata.claim` verbatim, where a jsonb write fails with 22P02 and
  // logAuditAsync swallows the row — the audit-suppression path round-4 S1
  // closed for RENDERED values but not for accepted ones. Refused here as
  // well as guarded at the audit boundary, because a value this deployment
  // cannot store should not be adjudicating tenant membership either.
  if (!cleaned.isWellFormed()) return malformed("ill-formed UTF-16 (unpaired surrogate)");

  // Whatever `.trim()` would still take off the ends, the ASCII trim did not —
  // U+00A0 and friends. `normalizeTenantClaim` runs `.trim()` downstream, so
  // letting these through means the value matched on is not the value
  // asserted. A value that is ENTIRELY such whitespace was already returned as
  // `absent` above (round-5 F4, round-6 F2); this arm is the residue case,
  // where a real claim carries JS-trim whitespace on an edge.
  if (cleaned !== cleaned.trim()) {
    return malformed("leading or trailing non-ASCII whitespace");
  }

  if (cleaned.length > MAX_TENANT_CLAIM_LENGTH) {
    return malformed(`${cleaned.length} characters (max ${MAX_TENANT_CLAIM_LENGTH})`);
  }
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
