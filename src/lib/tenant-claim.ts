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

export function slugifyTenant(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);

  // Fallback for non-ASCII-only inputs (e.g. Japanese org names)
  if (!slug) {
    return createHash("sha256").update(input.trim()).digest("hex").slice(0, 24);
  }
  return slug;
}

function sanitizeTenantClaimValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/\0/g, "");
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
