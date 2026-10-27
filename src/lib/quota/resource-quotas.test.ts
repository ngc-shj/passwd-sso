import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockTenantWebhookCount, mockTeamWebhookCount } = vi.hoisted(() => ({
  mockTenantWebhookCount: vi.fn(),
  mockTeamWebhookCount: vi.fn(),
}));

const tx = {
  tenantWebhook: { count: mockTenantWebhookCount },
  teamWebhook: { count: mockTeamWebhookCount },
};

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: vi.fn(async (_prisma: unknown, fn: (client: unknown) => unknown) => fn(tx)),
}));

import { assertQuotaAvailable, QuotaExceededError } from "./resource-quotas";

describe("assertQuotaAvailable — webhooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("QUOTA_MAX_WEBHOOKS_PER_TENANT", "10");
    // Distinct counts, so a sum that read one table twice lands on a different total.
    mockTenantWebhookCount.mockResolvedValue(3);
    mockTeamWebhookCount.mockResolvedValue(4);
  });

  it("allows a create that brings tenant + team webhooks exactly to the limit", async () => {
    await expect(assertQuotaAvailable({ tenantId: "tenant-1" }, "webhooks", 3)).resolves.toBeUndefined();
  });

  it("refuses a create past the limit, reporting the summed usage", async () => {
    const err = await assertQuotaAvailable({ tenantId: "tenant-1" }, "webhooks", 4).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(QuotaExceededError);
    expect(err).toMatchObject({ resource: "webhooks", current: 7, max: 10 });
  });

  it("counts both webhook tables under the tenant", async () => {
    await assertQuotaAvailable({ tenantId: "tenant-1" }, "webhooks", 1);

    expect(mockTenantWebhookCount).toHaveBeenCalledWith({ where: { tenantId: "tenant-1" } });
    expect(mockTeamWebhookCount).toHaveBeenCalledWith({ where: { tenantId: "tenant-1" } });
  });

  it("requires a tenant scope", async () => {
    await expect(assertQuotaAvailable({ userId: "user-1" }, "webhooks", 1)).rejects.toThrow(
      "webhooks quota requires tenantId",
    );
  });
});
