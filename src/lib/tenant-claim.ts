import type { Account } from "next-auth";

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
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export function extractTenantClaimValue(
  account?: Account | null,
  profile?: Record<string, unknown> | null,
): string | null {
  if (!profile) return null;

  const keys = parseTenantClaimKeys();
  for (const key of keys) {
    const value = profile[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  // Google Workspace fallback: hosted domain claim (hd)
  if (account?.provider === "google") {
    const hd = profile.hd;
    if (typeof hd === "string" && hd.trim().length > 0) {
      return hd.trim();
    }
  }

  return null;
}
