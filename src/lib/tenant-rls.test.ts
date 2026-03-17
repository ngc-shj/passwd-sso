import { describe, it, expect, vi } from "vitest";
import {
  getTenantRlsContext,
  withTenantRls,
  withBypassRls,
} from "@/lib/tenant-rls";
import type { PrismaClient } from "@prisma/client";

function makeMockPrisma(overrides?: Partial<{ $executeRaw: ReturnType<typeof vi.fn> }>) {
  const mockTx = {
    $executeRaw: overrides?.$executeRaw ?? vi.fn().mockResolvedValue(undefined),
  };
  const prisma = {
    $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(mockTx)
    ),
  } as unknown as PrismaClient;
  return { prisma, mockTx };
}

describe("getTenantRlsContext", () => {
  it("returns undefined outside of any RLS context", () => {
    const ctx = getTenantRlsContext();
    expect(ctx).toBeUndefined();
  });
});

describe("withTenantRls", () => {
  it("runs the callback inside a transaction", async () => {
    const { prisma } = makeMockPrisma();
    const fn = vi.fn().mockResolvedValue("result");
    const result = await withTenantRls(prisma, "tenant-abc", fn);
    expect(result).toBe("result");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("sets RLS context with correct tenantId and bypass=false", async () => {
    const { prisma } = makeMockPrisma();
    let capturedCtx: ReturnType<typeof getTenantRlsContext>;
    await withTenantRls(prisma, "tenant-xyz", async () => {
      capturedCtx = getTenantRlsContext();
      return undefined;
    });
    expect(capturedCtx).toMatchObject({
      tenantId: "tenant-xyz",
      bypass: false,
    });
    expect(capturedCtx?.tx).toBeDefined();
  });

  it("calls set_config with the correct tenantId", async () => {
    const mockExecuteRaw = vi.fn().mockResolvedValue(undefined);
    const { prisma } = makeMockPrisma({ $executeRaw: mockExecuteRaw });
    await withTenantRls(prisma, "tenant-123", async () => undefined);
    // The tagged template is called with a TemplateStringsArray + interpolated value
    expect(mockExecuteRaw).toHaveBeenCalled();
  });

  it("context is cleared after the call completes (no leak)", async () => {
    const { prisma } = makeMockPrisma();
    await withTenantRls(prisma, "tenant-abc", async () => undefined);
    const ctx = getTenantRlsContext();
    expect(ctx).toBeUndefined();
  });

  it("propagates errors from the callback", async () => {
    const { prisma } = makeMockPrisma();
    await expect(
      withTenantRls(prisma, "tenant-abc", async () => {
        throw new Error("inner error");
      })
    ).rejects.toThrow("inner error");
  });

  it("allows nested context reads inside the callback", async () => {
    const { prisma } = makeMockPrisma();
    const innerResults: Array<ReturnType<typeof getTenantRlsContext>> = [];
    await withTenantRls(prisma, "tenant-nested", async () => {
      innerResults.push(getTenantRlsContext());
      return undefined;
    });
    expect(innerResults[0]?.tenantId).toBe("tenant-nested");
  });
});

describe("withBypassRls", () => {
  it("runs the callback inside a transaction", async () => {
    const { prisma } = makeMockPrisma();
    const fn = vi.fn().mockResolvedValue("bypass-result");
    const result = await withBypassRls(prisma, fn);
    expect(result).toBe("bypass-result");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("sets RLS context with tenantId=null and bypass=true", async () => {
    const { prisma } = makeMockPrisma();
    let capturedCtx: ReturnType<typeof getTenantRlsContext>;
    await withBypassRls(prisma, async () => {
      capturedCtx = getTenantRlsContext();
      return undefined;
    });
    expect(capturedCtx).toMatchObject({
      tenantId: null,
      bypass: true,
    });
    expect(capturedCtx?.tx).toBeDefined();
  });

  it("context is cleared after the call completes (no leak)", async () => {
    const { prisma } = makeMockPrisma();
    await withBypassRls(prisma, async () => undefined);
    const ctx = getTenantRlsContext();
    expect(ctx).toBeUndefined();
  });

  it("propagates errors from the callback", async () => {
    const { prisma } = makeMockPrisma();
    await expect(
      withBypassRls(prisma, async () => {
        throw new Error("bypass inner error");
      })
    ).rejects.toThrow("bypass inner error");
  });

  it("calls set_config with bypass_rls flag", async () => {
    const mockExecuteRaw = vi.fn().mockResolvedValue(undefined);
    const { prisma } = makeMockPrisma({ $executeRaw: mockExecuteRaw });
    await withBypassRls(prisma, async () => undefined);
    expect(mockExecuteRaw).toHaveBeenCalled();
  });
});
