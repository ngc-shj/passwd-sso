import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockSlugifyTenant } = vi.hoisted(() => {
  const mockPrisma = {
    tenant: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  };
  return {
    mockPrisma,
    mockSlugifyTenant: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/tenant/tenant-claim", () => ({
  slugifyTenant: mockSlugifyTenant,
}));

import { findOrCreateSsoTenant } from "./tenant-management";

describe("findOrCreateSsoTenant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSlugifyTenant.mockReturnValue("acme-com");
  });

  it("returns existing tenant by externalId", async () => {
    mockPrisma.tenant.findUnique.mockResolvedValue({ id: "tenant-1" });

    const result = await findOrCreateSsoTenant("acme.com");

    expect(result).toEqual({ id: "tenant-1" });
    expect(mockPrisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { externalId: "acme.com" },
      select: { id: true },
    });
    expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
  });

  it("creates new tenant when not found", async () => {
    mockPrisma.tenant.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.create.mockResolvedValue({ id: "tenant-new" });

    const result = await findOrCreateSsoTenant("acme.com");

    expect(result).toEqual({ id: "tenant-new" });
    expect(mockPrisma.tenant.create).toHaveBeenCalledWith({
      data: {
        externalId: "acme.com",
        name: "acme.com",
        slug: "acme-com",
      },
      select: { id: true },
    });
  });

  it("retries findUnique after P2002 on externalId", async () => {
    const { Prisma } = await import("@prisma/client");
    mockPrisma.tenant.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "tenant-concurrent" });
    mockPrisma.tenant.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "7.0.0",
      }),
    );

    const result = await findOrCreateSsoTenant("acme.com");

    expect(result).toEqual({ id: "tenant-concurrent" });
    expect(mockPrisma.tenant.findUnique).toHaveBeenCalledTimes(2);
  });

  it("retries with fallback slug when P2002 is slug collision", async () => {
    const { Prisma } = await import("@prisma/client");
    mockPrisma.tenant.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.create
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("unique", {
          code: "P2002",
          clientVersion: "7.0.0",
        }),
      )
      .mockResolvedValueOnce({ id: "tenant-fallback" });

    const result = await findOrCreateSsoTenant("acme.com");

    expect(result).toEqual({ id: "tenant-fallback" });
    expect(mockPrisma.tenant.create).toHaveBeenCalledTimes(2);
    const secondCreate = mockPrisma.tenant.create.mock.calls[1][0];
    expect(secondCreate.data.slug).toMatch(/^acme-com-[0-9a-f]{8}$/);
    expect(secondCreate.data.externalId).toBe("acme.com");
  });

  it("returns null when slugifyTenant returns empty string", async () => {
    mockSlugifyTenant.mockReturnValue("");

    const result = await findOrCreateSsoTenant("???");

    expect(result).toBeNull();
    expect(mockPrisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
  });

  it("returns null on double P2002 collision", async () => {
    const { Prisma } = await import("@prisma/client");
    const p2002 = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "7.0.0",
    });
    mockPrisma.tenant.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.create
      .mockRejectedValueOnce(p2002)
      .mockRejectedValueOnce(p2002);

    const result = await findOrCreateSsoTenant("acme.com");

    expect(result).toBeNull();
    expect(mockPrisma.tenant.create).toHaveBeenCalledTimes(2);
  });

  it("throws non-P2002 errors", async () => {
    mockPrisma.tenant.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.create.mockRejectedValueOnce(new Error("DB down"));

    await expect(findOrCreateSsoTenant("acme.com")).rejects.toThrow("DB down");
  });
});
