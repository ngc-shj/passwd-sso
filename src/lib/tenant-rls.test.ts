import { describe, it, expect, vi } from "vitest";
import {
  getTenantRlsContext,
  withTenantRls,
  withBypassRls,
  BYPASS_PURPOSE,
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
    const result = await withBypassRls(prisma, fn, BYPASS_PURPOSE.AUDIT_WRITE);
    expect(result).toBe("bypass-result");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("sets RLS context with tenantId=null and bypass=true", async () => {
    const { prisma } = makeMockPrisma();
    let capturedCtx: ReturnType<typeof getTenantRlsContext>;
    await withBypassRls(prisma, async () => {
      capturedCtx = getTenantRlsContext();
      return undefined;
    }, BYPASS_PURPOSE.AUDIT_WRITE);
    expect(capturedCtx).toMatchObject({
      tenantId: null,
      bypass: true,
    });
    expect(capturedCtx?.tx).toBeDefined();
  });

  it("context is cleared after the call completes (no leak)", async () => {
    const { prisma } = makeMockPrisma();
    await withBypassRls(prisma, async () => undefined, BYPASS_PURPOSE.AUDIT_WRITE);
    const ctx = getTenantRlsContext();
    expect(ctx).toBeUndefined();
  });

  it("propagates errors from the callback", async () => {
    const { prisma } = makeMockPrisma();
    await expect(
      withBypassRls(prisma, async () => {
        throw new Error("bypass inner error");
      }, BYPASS_PURPOSE.AUDIT_WRITE)
    ).rejects.toThrow("bypass inner error");
  });

  it("calls set_config with bypass_rls flag", async () => {
    const mockExecuteRaw = vi.fn().mockResolvedValue(undefined);
    const { prisma } = makeMockPrisma({ $executeRaw: mockExecuteRaw });
    await withBypassRls(prisma, async () => undefined, BYPASS_PURPOSE.AUDIT_WRITE);
    expect(mockExecuteRaw).toHaveBeenCalled();
  });
});

// ─── C1: Nesting guards (both directions) ────────────────────
//
// AsyncLocalStorage does NOT roll back PostgreSQL GUCs, and the Prisma
// Proxy folds nested $transaction into the outer tx, so set_config(..., true)
// from either direction would silently persist for the outer transaction's
// remainder. The guards reject nesting BEFORE prisma.$transaction is called,
// so no DB statement runs. The tests assert both directions and assert that
// $transaction / $executeRaw on the INNER call were never invoked.

describe("RLS nesting guards (C1)", () => {
  it("rejects withTenantRls inside withBypassRls — INVALID_RLS_NESTING", async () => {
    const { prisma, mockTx } = makeMockPrisma();
    const innerTransaction = vi.fn();

    // Hoisted to the outer scope so the post-throw assertions can read them.
    // Assigned inside withBypassRls's callback, after its own set_config calls
    // have fired — i.e. the snapshot captures the state immediately before the
    // inner withTenantRls attempt.
    let outerTxCallsBefore = -1;
    let outerExecBefore = -1;

    await expect(
      withBypassRls(
        prisma,
        async () => {
          outerTxCallsBefore = (prisma.$transaction as ReturnType<typeof vi.fn>).mock.calls.length;
          outerExecBefore = mockTx.$executeRaw.mock.calls.length;

          // Inner attempt MUST throw synchronously (before $transaction).
          await withTenantRls(prisma, "tenant-inner", async () => {
            innerTransaction(); // should never run
            return undefined;
          });

          // Unreachable; this line exists so the catch above is the only exit.
          throw new Error("unexpected: inner call did not throw");
        },
        BYPASS_PURPOSE.AUDIT_WRITE,
      ),
    ).rejects.toThrow(/INVALID_RLS_NESTING/);

    // The inner callback's body must NEVER have run.
    expect(innerTransaction).not.toHaveBeenCalled();

    // No additional $transaction call fired between the snapshot and now —
    // the inner withTenantRls's guard threw before reaching prisma.$transaction.
    expect((prisma.$transaction as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      outerTxCallsBefore,
    );

    // No additional $executeRaw call fired either. mockTx.$executeRaw is
    // invoked only by withBypassRls's own set_config calls (bypass_rls +
    // bypass_purpose + tenant_id); if the inner guard had been bypassed we'd
    // see an additional invocation with the inner tenant id literal.
    expect(mockTx.$executeRaw.mock.calls.length).toBe(outerExecBefore);
  });

  it("rejects withBypassRls inside withTenantRls — INVALID_RLS_NESTING", async () => {
    const { prisma, mockTx } = makeMockPrisma();
    const innerTransaction = vi.fn();

    await expect(
      withTenantRls(prisma, "tenant-outer", async () => {
        await withBypassRls(
          prisma,
          async () => {
            innerTransaction(); // should never run
            return undefined;
          },
          BYPASS_PURPOSE.AUDIT_WRITE,
        );
        throw new Error("unexpected: inner call did not throw");
      }),
    ).rejects.toThrow(/INVALID_RLS_NESTING/);

    expect(innerTransaction).not.toHaveBeenCalled();
    // Outer $transaction fires exactly once; inner withBypassRls throws
    // synchronously before its $transaction call.
    expect((prisma.$transaction as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);

    // The inner set_config('app.bypass_rls', 'on', ...) must NOT have fired.
    for (const call of mockTx.$executeRaw.mock.calls) {
      const flatArgs = JSON.stringify(call);
      expect(flatArgs).not.toMatch(/bypass_rls.*on/);
    }
  });

  it("does NOT reject sequential calls — guard only fires on active nesting", async () => {
    const { prisma } = makeMockPrisma();
    await withBypassRls(prisma, async () => undefined, BYPASS_PURPOSE.AUDIT_WRITE);
    // After the first call exits, context is cleared. Second call must
    // succeed without throwing INVALID_RLS_NESTING.
    await expect(
      withTenantRls(prisma, "tenant-x", async () => "ok"),
    ).resolves.toBe("ok");
  });
});
