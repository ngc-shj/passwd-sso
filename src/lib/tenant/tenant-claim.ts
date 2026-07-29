import type { Account } from "next-auth";
import { createHash } from "node:crypto";
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
  // Strip all C0 (U+0000-U+001F), DEL (U+007F), C1 (U+0080-U+009F) control
  // characters, plus Unicode bidi and zero-width formatting characters
  // (U+200B-U+200F, U+202A-U+202E, U+2066-U+2069, U+FEFF). This value is
  // rendered to an operator (audit metadata, Tenant.name, the CLI's terminal
  // output), so a bidi-override or zero-width character could visually spoof
  // the claim shown. Stripped only from the value that gets displayed — the
  // stored/matched form is unaffected by this rider since C1's ASCII CHECK
  // constraint already excludes these characters from what can be stored.
  const cleaned = value
    .trim()
    .replace(/[\x00-\x1f\x7f-\x9f\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "");
  if (cleaned.length === 0 || cleaned.length > MAX_TENANT_CLAIM_LENGTH) {
    return null;
  }
  return cleaned;
}

export function extractTenantClaimValue(
  account?: Account | null,
  profile?: Record<string, unknown> | null,
): string | null {
  if (!profile) return null;

  const keys = parseTenantClaimKeys();
  for (const key of keys) {
    const cleaned = sanitizeTenantClaimValue(profile[key]);
    if (cleaned) return cleaned;
  }

  // Google Workspace fallback: hosted domain claim (hd)
  if (account?.provider === "google") {
    const cleaned = sanitizeTenantClaimValue(profile.hd);
    if (cleaned) return cleaned;
  }

  return null;
}
