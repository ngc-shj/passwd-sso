/**
 * A nested RLS context refused inside another one fails the outer helper even
 * when the refusal was caught, so the transaction does not commit work that
 * skipped what the nested context was for (#909/#910). The real rollback is
 * covered against a database in the integration suite; here the helpers'
 * contract is pinned on a mocked transaction.
 */
import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { withTenantRls, withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { defineGrant } from "@/lib/tenant-rls-grants";

const TENANT_ID = "77777777-7777-4777-8777-777777777777";
const GRANT = defineGrant(BYPASS_PURPOSE.AUTH_FLOW, ["user"]);

function makePrisma() {
  const tx = { $executeRaw: vi.fn().mockResolvedValue(undefined) };
  return {
    $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient;
}

const swallowNested = (prisma: PrismaClient, inner: "tenant" | "bypass") => async () => {
  const nested =
    inner === "tenant"
      ? withTenantRls(prisma, TENANT_ID, async () => "inner")
      : withBypassRls(prisma, async () => "inner", GRANT);
  await nested.catch(() => null);
  return "outer";
};

describe("a refused nested context fails its outer transaction", () => {
  it.each([
    ["withTenantRls", "withTenantRls", "tenant"],
    ["withTenantRls", "withBypassRls", "bypass"],
    ["withBypassRls", "withTenantRls", "tenant"],
    ["withBypassRls", "withBypassRls", "bypass"],
  ] as const)("%s holding a caught %s refusal rejects", async (outer, _inner, innerKind) => {
    const prisma = makePrisma();
    const run =
      outer === "withTenantRls"
        ? withTenantRls(prisma, TENANT_ID, swallowNested(prisma, innerKind))
        : withBypassRls(prisma, swallowNested(prisma, innerKind), GRANT);
    await expect(run).rejects.toThrow(`INVALID_RLS_NESTING: a nested RLS context was refused inside this ${outer}`);
    // Only the outer transaction was opened; the nested one was refused first.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("lets the callback's own error take precedence over the nesting failure", async () => {
    const prisma = makePrisma();
    const run = withTenantRls(prisma, TENANT_ID, async () => {
      await withBypassRls(prisma, async () => null, GRANT).catch(() => null);
      throw new Error("callback failed on its own");
    });
    await expect(run).rejects.toThrow("callback failed on its own");
  });

  it("does not carry the refusal into a sibling transaction", async () => {
    const prisma = makePrisma();
    await expect(withTenantRls(prisma, TENANT_ID, swallowNested(prisma, "bypass"))).rejects.toThrow("INVALID_RLS_NESTING");
    await expect(withTenantRls(prisma, TENANT_ID, async () => "clean")).resolves.toBe("clean");
    await expect(withBypassRls(prisma, async () => "clean", GRANT)).resolves.toBe("clean");
  });

  it("resolves normally when nothing nested", async () => {
    const prisma = makePrisma();
    await expect(withTenantRls(prisma, TENANT_ID, async () => 42)).resolves.toBe(42);
    await expect(withBypassRls(prisma, async () => 43, GRANT)).resolves.toBe(43);
  });
});
