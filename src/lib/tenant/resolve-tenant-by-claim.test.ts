import { describe, it, expect, vi, beforeEach } from "vitest";

// A NEW file, deliberately not tenant-management.test.ts: that file's
// factory mock of "@/lib/tenant/tenant-claim" would shadow the real
// normaliser this suite needs to exercise (RT5). No mock on
// tenant-claim-registry.ts here — normalizeTenantClaim / storableClaimSchema
// run for real.

const mockPrisma = vi.hoisted(() => ({
  tenantClaim: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  tenant: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mockPrisma,
}));

import { resolveTenantByClaim } from "./tenant-management";

describe("resolveTenantByClaim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves a registered claim to its tenant", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue({
      tenantId: "tenant-1",
      revokedAt: null,
    });

    const result = await resolveTenantByClaim("alias.example");

    expect(result).toEqual({ kind: "tenant", id: "tenant-1" });
    expect(mockPrisma.tenantClaim.findUnique).toHaveBeenCalledWith({
      where: { claim: "alias.example" },
      select: { tenantId: true, revokedAt: true },
    });
  });

  it("reports an unregistered claim with no externalId match, asserting zero writes (I5)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.findUnique.mockResolvedValue(null);

    const result = await resolveTenantByClaim("unregistered.example");

    expect(result).toEqual({ kind: "unregistered" });
    expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
    expect(mockPrisma.tenantClaim.create).not.toHaveBeenCalled();
    expect(mockPrisma.tenantClaim.update).not.toHaveBeenCalled();
  });

  it("resolves the row stored as alias.example when queried as Alias.Example (real normaliser)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue({
      tenantId: "tenant-2",
      revokedAt: null,
    });

    const result = await resolveTenantByClaim("Alias.Example");

    expect(result).toEqual({ kind: "tenant", id: "tenant-2" });
    expect(mockPrisma.tenantClaim.findUnique).toHaveBeenCalledWith({
      where: { claim: "alias.example" },
      select: { tenantId: true, revokedAt: true },
    });
  });

  it("resolves a registered non-domain claim (NF2)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue({
      tenantId: "tenant-3",
      revokedAt: null,
    });

    const result = await resolveTenantByClaim("acmecorp");

    expect(result).toEqual({ kind: "tenant", id: "tenant-3" });
  });

  it("returns null, without throwing, for a claim that fails storableClaimSchema", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.findUnique.mockResolvedValue(null);

    // "café.example" normalises to a non-ASCII value storableClaimSchema
    // rejects; resolveTenantByClaim does not validate it explicitly — the
    // row simply never existed to be found (SC9), and the externalId
    // fallback (also not found here) leaves null.
    await expect(resolveTenantByClaim("café.example")).resolves.toEqual({ kind: "unregistered" });
  });

  it("reports a revoked claim row WITH its owner, and does NOT consult the externalId fallback", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue({
      tenantId: "tenant-revoked-owner",
      revokedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const result = await resolveTenantByClaim("alias.example");

    // Round-4 F1: `revoked` and `unregistered` were the same `null`, and the
    // caller filed its denial under the USER's tenant for both — while the
    // no-membership path filed the identical lockout under the CLAIM's owner.
    // `tenant-domain unmapped` groups by (tenant_id, claim), so one incident
    // arrived as two groups. Carrying the owner is what lets the dispatch
    // agree with itself.
    expect(result).toEqual({ kind: "revoked", tenantId: "tenant-revoked-owner" });
    expect(mockPrisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it("resolves through the externalId fallback when no claim row exists (D1 release-1 case)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.findUnique.mockResolvedValue({ id: "tenant-legacy" });

    const result = await resolveTenantByClaim("alias.example");

    expect(result).toEqual({ kind: "tenant", id: "tenant-legacy" });
    expect(mockPrisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { externalId: "alias.example" },
      select: { id: true },
    });
  });

  // Round-1 M12: "alias.example" is its own normal form, so the case above
  // holds whether the fallback is passed the raw or the normalised claim. D-3
  // makes the RAW spelling load-bearing — the fallback is what keeps NF2 true
  // in release 1 for a deployment whose tenants.external_id was stored
  // un-normalised, and those rows are invisible to a folded lookup.
  it("queries the externalId fallback with the RAW claim while the registry gets the normalised one (D-3)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.findUnique.mockResolvedValue({ id: "tenant-legacy-mixed" });

    const result = await resolveTenantByClaim("Alias.Example");

    expect(result).toEqual({ kind: "tenant", id: "tenant-legacy-mixed" });
    expect(mockPrisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { externalId: "Alias.Example" },
      select: { id: true },
    });
    expect(mockPrisma.tenantClaim.findUnique).toHaveBeenCalledWith({
      where: { claim: "alias.example" },
      select: { tenantId: true, revokedAt: true },
    });
  });
});
