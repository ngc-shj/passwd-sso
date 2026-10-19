/**
 * A refused RLS nesting is logged before it throws, so a caller that swallows
 * the error (best-effort notification, lockout audit) still leaves a record.
 * The log names the two helpers and nothing the caller supplied.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

const { mockError } = vi.hoisted(() => ({ mockError: vi.fn() }));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ error: mockError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { withTenantRls, withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";

const TENANT_ID = "77777777-7777-4777-8777-777777777777";

function makePrisma() {
  const tx = { $executeRaw: vi.fn().mockResolvedValue(undefined) };
  return {
    $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient;
}

beforeEach(() => {
  mockError.mockClear();
});

describe("RLS nesting refusal log", () => {
  it("does not log when no RLS context is active", async () => {
    await withTenantRls(makePrisma(), TENANT_ID, async () => undefined);
    expect(mockError).not.toHaveBeenCalled();
  });

  it("logs a structured error naming both helpers, then throws INVALID_RLS_NESTING", async () => {
    const prisma = makePrisma();
    await expect(
      withTenantRls(prisma, TENANT_ID, () =>
        withBypassRls(prisma, async () => undefined, BYPASS_PURPOSE.AUDIT_WRITE),
      ),
    ).rejects.toThrow("INVALID_RLS_NESTING: withBypassRls inside withTenantRls is forbidden");

    expect(mockError).toHaveBeenCalledOnce();
    const [fields, message] = mockError.mock.calls[0];
    expect(fields).toEqual({ event: "rls.nesting_refused", opening: "withBypassRls", active: "withTenantRls" });
    expect(message).toBe("RLS context refused: another RLS context is active");
  });

  it("logs the refusal even when the caller swallows the error", async () => {
    const prisma = makePrisma();
    await withBypassRls(
      prisma,
      async () => {
        await withTenantRls(prisma, TENANT_ID, async () => undefined).catch(() => null);
      },
      BYPASS_PURPOSE.AUDIT_WRITE,
    );
    expect(mockError).toHaveBeenCalledOnce();
    expect(mockError.mock.calls[0][0]).toEqual({
      event: "rls.nesting_refused",
      opening: "withTenantRls",
      active: "withBypassRls",
    });
    // Nothing the caller supplied reaches the log.
    expect(JSON.stringify(mockError.mock.calls)).not.toContain(TENANT_ID);
  });
});
