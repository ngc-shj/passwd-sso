import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TxOrPrisma } from "@/lib/prisma";

const { mockPrisma, mockSlugifyTenant, mockAdvisoryXactLock } = vi.hoisted(() => {
  const mockPrisma = {
    tenant: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    tenantClaim: {
      findUnique: vi.fn(),
    },
    $executeRaw: vi.fn(),
  };
  return {
    mockPrisma,
    mockSlugifyTenant: vi.fn(),
    mockAdvisoryXactLock: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/tenant/tenant-claim", () => ({
  slugifyTenant: mockSlugifyTenant,
}));

vi.mock("@/lib/tenant-rls", () => ({
  advisoryXactLock: mockAdvisoryXactLock,
}));

import { findOrCreateTenantForClaim } from "./tenant-management";

// findOrCreateTenantForClaim's `db` parameter is REQUIRED (no `= prisma`
// default — see the doc comment: a default would let the advisory lock run
// in autocommit mode outside a real transaction). Every call below passes
// the mocked client explicitly, cast the same way other tests in this repo
// cast a mock object to TxOrPrisma (see scim-group-service.test.ts).
const db = mockPrisma as unknown as TxOrPrisma;

describe("findOrCreateTenantForClaim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSlugifyTenant.mockReturnValue("acme-com");
    mockAdvisoryXactLock.mockResolvedValue(undefined);
    mockPrisma.$executeRaw.mockResolvedValue(1);
  });

  it("resolves an already-registered claim via the claim registry, without creating", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue({
      tenantId: "tenant-1",
      revokedAt: null,
    });

    const result = await findOrCreateTenantForClaim("acme.com", db);

    expect(result).toEqual({ id: "tenant-1" });
    expect(mockPrisma.tenantClaim.findUnique).toHaveBeenCalledWith({
      where: { claim: "acme.com" },
      select: { tenantId: true, revokedAt: true },
    });
    expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
  });

  it("creates a new tenant with its claim row in one nested create when not found", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.findUnique.mockResolvedValue(null); // externalId fallback miss
    mockPrisma.tenant.create.mockResolvedValue({ id: "tenant-new" });

    const result = await findOrCreateTenantForClaim("acme.com", db);

    expect(result).toEqual({ id: "tenant-new" });
    expect(mockPrisma.tenant.create).toHaveBeenCalledWith({
      data: {
        externalId: "acme.com", // D1: release 1 still writes it
        name: "acme.com",
        slug: "acme-com",
        claims: { create: { claim: "acme.com", createdBy: "signin" } },
      },
      select: { id: true },
    });
  });

  // Round-3's ":62 retries findUnique after P2002 on externalId" is deleted,
  // not adjusted: the advisory lock removes the concurrent claim-key race
  // this test existed to cover — two concurrent creators for the same claim
  // now serialise at advisoryXactLock and the second observes the first's
  // committed row at the resolve step, so a P2002 on tenant_claims_claim_key
  // is no longer reachable at all.

  it("retries with a fallback slug on slug collision (SAVEPOINT arm)", async () => {
    const { Prisma } = await import("@prisma/client");
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.create
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("unique", {
          code: "P2002",
          clientVersion: "7.0.0",
        }),
      )
      .mockResolvedValueOnce({ id: "tenant-fallback" });

    const result = await findOrCreateTenantForClaim("acme.com", db);

    expect(result).toEqual({ id: "tenant-fallback" });
    expect(mockPrisma.tenant.create).toHaveBeenCalledTimes(2);
    const secondCreate = mockPrisma.tenant.create.mock.calls[1][0];
    expect(secondCreate.data.slug).toMatch(/^acme-com-[0-9a-f]{8}$/);
    expect(secondCreate.data.externalId).toBe("acme.com");
    expect(secondCreate.data.claims).toEqual({
      create: { claim: "acme.com", createdBy: "signin" },
    });
    // SAVEPOINT, then ROLLBACK TO SAVEPOINT (on the P2002), then RELEASE
    // SAVEPOINT (after the retry succeeds) — issued BEFORE the statement
    // that may abort, per round-4 N6.
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(3);
  });

  it("returns null when the normalised claim fails storableClaimSchema, with no create (I5)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.findUnique.mockResolvedValue(null);

    // Truthy-but-invalid fixture (round-3 M27): src/auth.ts:53 is
    // `if (!tenantClaim)`, so an empty string never reaches this function.
    // A whitespace-only string is truthy but normalises to "", which
    // storableClaimSchema rejects (min length 1).
    const result = await findOrCreateTenantForClaim(" ", db);

    expect(result).toBeNull();
    expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
  });

  // Round-3's ":111 returns null on double P2002 collision" is deleted, not
  // restated: it modeled the OLD externalId-race retry path (two racing
  // creators both getting P2002 on tenants_external_id_key). That path is
  // gone — the advisory lock serialises same-claim creation, and a second
  // P2002 from the SAVEPOINT retry (different-claim slug collision, twice)
  // is no longer specially handled; it propagates like any other error,
  // already covered by the "throws non-P2002 errors" shape below.

  it("throws non-P2002 errors", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.create.mockRejectedValueOnce(new Error("DB down"));

    await expect(findOrCreateTenantForClaim("acme.com", db)).rejects.toThrow(
      "DB down",
    );
  });

  it("creates a tenant for a non-domain claim like acmecorp (NF2)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.findUnique.mockResolvedValue(null);
    mockSlugifyTenant.mockReturnValue("acmecorp");
    mockPrisma.tenant.create.mockResolvedValue({ id: "tenant-nf2" });

    const result = await findOrCreateTenantForClaim("acmecorp", db);

    expect(result).toEqual({ id: "tenant-nf2" });
    expect(mockPrisma.tenant.create).toHaveBeenCalledWith({
      data: {
        externalId: "acmecorp",
        name: "acmecorp",
        slug: "acmecorp",
        claims: { create: { claim: "acmecorp", createdBy: "signin" } },
      },
      select: { id: true },
    });
  });

  it("calls advisoryXactLock before resolving, keyed on the normalised claim", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue({
      tenantId: "tenant-1",
      revokedAt: null,
    });

    await findOrCreateTenantForClaim("Alias.Example", db);

    expect(mockAdvisoryXactLock).toHaveBeenCalledWith(db, "tenant-claim:alias.example");
    const lockOrder = mockAdvisoryXactLock.mock.invocationCallOrder[0];
    const resolveOrder = mockPrisma.tenantClaim.findUnique.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(resolveOrder);
  });

  it("returns null for a revoked claim row and does not create (D2)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue({
      tenantId: "tenant-owner",
      revokedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const result = await findOrCreateTenantForClaim("alias.example", db);

    expect(result).toBeNull();
    // No fallback either — a revoked row is taken, not "not found".
    expect(mockPrisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
  });

  it("resolves through the externalId fallback without creating (D1 release-1 case)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.findUnique.mockResolvedValue({ id: "tenant-legacy" });

    const result = await findOrCreateTenantForClaim("alias.example", db);

    expect(result).toEqual({ id: "tenant-legacy" });
    expect(mockPrisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { externalId: "alias.example" },
      select: { id: true },
    });
    expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
  });
});
