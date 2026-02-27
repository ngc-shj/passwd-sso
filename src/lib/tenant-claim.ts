import type { Account } from "next-auth";
import { createHash } from "node:crypto";

const MAX_TENANT_CLAIM_LENGTH = 255;

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
    .slice(0, 50);

  // Fallback for non-ASCII-only inputs (e.g. Japanese org names)
  if (!slug) {
    return createHash("sha256").update(input.trim()).digest("hex").slice(0, 24);
  }

  // Prevent collision with reserved internal prefixes
  if (RESERVED_SLUG_PREFIXES.some((p) => slug.startsWith(p))) {
    slug = `t-${slug}`.slice(0, 50);
  }
  return slug;
}

function sanitizeTenantClaimValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Strip all C0 (U+0000-U+001F), DEL (U+007F), and C1 (U+0080-U+009F) control characters
  const cleaned = value.trim().replace(/[\x00-\x1f\x7f-\x9f]/g, "");
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
