import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Prisma } from "@prisma/client";

const { mockLogAuditBulkInTx } = vi.hoisted(() => ({ mockLogAuditBulkInTx: vi.fn() }));
vi.mock("@/lib/audit/audit", () => ({ logAuditBulkInTx: mockLogAuditBulkInTx }));

import { endCreatorFootholdsInTx } from "./departure-footholds";

const TENANT = "tenant-1";
const ACTOR = { userId: "actor", actorType: "HUMAN" as const, ip: "10.0.0.1", userAgent: "ua" };

function footholdTx({ tokens = [] as unknown[], resets = [] as unknown[] } = {}) {
  const raw = {
    serviceAccountToken: { updateManyAndReturn: vi.fn().mockResolvedValue(tokens) },
    adminVaultReset: { updateManyAndReturn: vi.fn().mockResolvedValue(resets) },
  };
  return { tx: raw as unknown as Prisma.TransactionClient, raw };
}

describe("endCreatorFootholdsInTx", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("touches nothing for no users", async () => {
    const { tx, raw } = footholdTx();

    await endCreatorFootholdsInTx(tx, TENANT, [], ACTOR);

    expect(raw.serviceAccountToken.updateManyAndReturn).not.toHaveBeenCalled();
    expect(raw.adminVaultReset.updateManyAndReturn).not.toHaveBeenCalled();
    expect(mockLogAuditBulkInTx).not.toHaveBeenCalled();
  });

  it("revokes only the live service-account tokens the users minted in the tenant", async () => {
    const { tx, raw } = footholdTx();

    await endCreatorFootholdsInTx(tx, TENANT, ["u1", "u2"], ACTOR);

    expect(raw.serviceAccountToken.updateManyAndReturn).toHaveBeenCalledWith({
      where: { tenantId: TENANT, createdById: { in: ["u1", "u2"] }, revokedAt: null, expiresAt: { gt: expect.any(Date) } },
      data: { revokedAt: expect.any(Date) },
      select: { id: true, serviceAccountId: true, createdById: true },
    });
  });

  it("revokes only the unapproved, unexecuted, unrevoked, unexpired resets the users initiated, and clears the token", async () => {
    const { tx, raw } = footholdTx();

    await endCreatorFootholdsInTx(tx, TENANT, ["u1"], ACTOR);

    expect(raw.adminVaultReset.updateManyAndReturn).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        initiatedById: { in: ["u1"] },
        approvedAt: null,
        executedAt: null,
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { revokedAt: expect.any(Date), encryptedToken: null },
      select: { id: true, targetUserId: true, initiatedById: true },
    });
  });

  it("audits one row per revoked token and per revoked reset, as the departure's actor, one enqueue per action", async () => {
    const { tx } = footholdTx({
      tokens: [
        { id: "tok-1", serviceAccountId: "sa-1", createdById: "u1" },
        { id: "tok-2", serviceAccountId: "sa-2", createdById: "u2" },
      ],
      resets: [{ id: "reset-1", targetUserId: "target-1", initiatedById: "u1" }],
    });

    await endCreatorFootholdsInTx(tx, TENANT, ["u1", "u2"], ACTOR);

    expect(mockLogAuditBulkInTx).toHaveBeenCalledTimes(2);
    for (const [calledTx, tenantId] of mockLogAuditBulkInTx.mock.calls) {
      expect(calledTx).toBe(tx);
      expect(tenantId).toBe(TENANT);
    }
    const rows = mockLogAuditBulkInTx.mock.calls.flatMap((call) => call[2]);
    expect(rows).toEqual([
      expect.objectContaining({
        ...ACTOR,
        scope: "TENANT",
        tenantId: TENANT,
        action: "SERVICE_ACCOUNT_TOKEN_REVOKE",
        targetType: "ServiceAccountToken",
        targetId: "tok-1",
        metadata: { serviceAccountId: "sa-1", targetUserId: "u1", reason: "CREATOR_DEPARTED" },
      }),
      expect.objectContaining({
        action: "SERVICE_ACCOUNT_TOKEN_REVOKE",
        targetId: "tok-2",
        metadata: { serviceAccountId: "sa-2", targetUserId: "u2", reason: "CREATOR_DEPARTED" },
      }),
      expect.objectContaining({
        ...ACTOR,
        scope: "TENANT",
        tenantId: TENANT,
        action: "ADMIN_VAULT_RESET_REVOKE",
        targetType: "User",
        targetId: "target-1",
        metadata: { resetId: "reset-1", initiatedById: "u1", reason: "INITIATOR_DEPARTED" },
      }),
    ]);
  });

  it("writes no audit row when nothing was revoked", async () => {
    const { tx } = footholdTx();

    await endCreatorFootholdsInTx(tx, TENANT, ["u1"], ACTOR);

    expect(mockLogAuditBulkInTx).toHaveBeenCalledWith(tx, TENANT, []);
  });
});
