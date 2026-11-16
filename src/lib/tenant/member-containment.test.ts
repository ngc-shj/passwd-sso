import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/tenant-rls", () => ({ isBypassRlsActive: () => true }));
vi.mock("@/lib/audit/audit", () => ({
  logAuditBulkInTx: vi.fn(async () => {}),
  tenantAuditBase: vi.fn(() => ({ scope: "TENANT" })),
}));

import { logAuditBulkInTx } from "@/lib/audit/audit";
import {
  FOOTHOLD_MODEL,
  containMemberInTx,
  listMemberContainment,
  mayContainKind,
  refusedContainmentKinds,
  toContainmentRequest,
  FOOTHOLD_KIND,
} from "./member-containment";

const TENANT = "tenant-1";
const TARGET = "target-1";
const NOW = new Date("2026-11-10T00:00:00Z");

const MODEL_OF_KIND = FOOTHOLD_MODEL;

/**
 * A fake transaction recording every call's `where` per model and method.
 * A bulk write returns one row per id it names, or the rows `returns` gives
 * for its model.
 */
function recordingTx(
  returns: Record<string, (where: Record<string, unknown>) => unknown[]> = {},
  counts: Record<string, number> = {},
) {
  const wheres: Record<string, Record<string, unknown[]>> = {};
  const selects: Record<string, unknown[]> = {};
  const updates: Record<string, unknown[]> = {};
  const tx = new Proxy(
    {},
    {
      get: (_t, model: string) => {
        const record = (method: string) => async (args: { where: { id?: { in: string[] } }; select?: unknown; data?: unknown }) => {
          ((wheres[model] ??= {})[method] ??= []).push(args.where);
          if (method === "findMany") (selects[model] ??= []).push(args.select);
          if (method === "updateManyAndReturn") (updates[model] ??= []).push(args.data);
          const rows = () =>
            returns[model]?.(args.where) ??
            (args.where.id?.in ?? []).map((id) => ({ id, tenantId: TENANT, serviceAccountId: "sa", clientId: "c", targetUserId: "x", granteeId: null, url: "https://hooks.example.com/in?token=s" }));
          if (method === "count") return counts[model] ?? 0;
          if (method === "findMany" || method === "updateManyAndReturn") return rows();
          if (method === "deleteMany") return { count: (args.where.id?.in ?? []).length };
          return { count: 1 };
        };
        return {
          findMany: record("findMany"),
          updateMany: record("updateMany"),
          updateManyAndReturn: record("updateManyAndReturn"),
          deleteMany: record("deleteMany"),
          count: record("count"),
        };
      },
    },
  );
  return { tx: tx as never, wheres, selects, updates };
}

const ALL_KINDS_INPUT = {
  revoke: {
    scimTokenIds: ["id-1"],
    serviceAccountIds: ["id-2"],
    serviceAccountTokenIds: ["id-3"],
    mcpClientIds: ["id-4"],
    breakglassGrantIds: ["id-5"],
    tenantWebhookIds: ["id-7"],
    vaultResetIds: ["id-8"],
    emergencyAccessGrantIds: ["id-6"],
  },
};

const containArgs = (request: NonNullable<ReturnType<typeof toContainmentRequest>>) => ({
  req: new NextRequest("http://localhost/"),
  actorUserId: "admin-1",
  tenantId: TENANT,
  targetUserId: TARGET,
  request,
  role: "OWNER" as const,
  now: NOW,
});

describe("member containment predicates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("the writes match exactly the rows the listing calls live, for every kind", async () => {
    const listing = recordingTx();
    await listMemberContainment(listing.tx, { tenantId: TENANT, targetUserId: TARGET, role: "OWNER", now: NOW });

    const writes = recordingTx();
    const request = toContainmentRequest(ALL_KINDS_INPUT);
    expect(request).not.toBeNull();
    await containMemberInTx(writes.tx, containArgs(request!));

    for (const [kind, model] of Object.entries(MODEL_OF_KIND)) {
      const [live] = listing.wheres[model].findMany;
      if (model === "emergencyAccessGrant") {
        // Read on the predicate, then written one by one through transition():
        // the owner predicate plus its allowed from-states.
        const [candidates] = writes.wheres[model].findMany;
        expect(candidates, kind).toEqual({ id: { in: [expect.any(String)] }, ...(live as object) });
        const [write] = writes.wheres[model].updateMany;
        expect(write).toMatchObject({ id: expect.any(String), ownerId: TARGET });
      } else if (model === "tenantWebhook") {
        // Read on the predicate, then deleted by the ids read and the predicate.
        const [candidates] = writes.wheres[model].findMany;
        expect(candidates, kind).toEqual({ id: { in: [expect.any(String)] }, ...(live as object) });
        const [removal] = writes.wheres[model].deleteMany;
        expect(removal, kind).toEqual({ id: { in: [expect.any(String)] }, ...(live as object) });
      } else {
        // One compare-and-set statement on the named ids and the same predicate.
        // (A contained service account's own token revocation is keyed by its
        // service account, not a token id.)
        const write = writes.wheres[model].updateManyAndReturn.find((w) => "id" in (w as object));
        expect(write, kind).toEqual({ id: { in: [expect.any(String)] }, ...(live as object) });
      }
    }
  });

  it("the remaining count of every kind uses the listing's predicate", async () => {
    const listing = recordingTx();
    await listMemberContainment(listing.tx, { tenantId: TENANT, targetUserId: TARGET, role: "OWNER", now: NOW });
    const writes = recordingTx();
    await containMemberInTx(writes.tx, containArgs(toContainmentRequest(ALL_KINDS_INPUT)!));
    for (const [kind, model] of Object.entries(MODEL_OF_KIND)) {
      expect(writes.wheres[model].count, kind).toEqual([listing.wheres[model].findMany[0]]);
    }
  });

  it("revokes a contained service account's and MCP client's tokens by the parents the write returned, not the ids requested", async () => {
    // Of two named, only one matches live.
    const writes = recordingTx({
      serviceAccount: () => [{ id: "sa-live" }],
      mcpClient: () => [{ id: "mcp-live" }],
      serviceAccountToken: () => [],
      mcpAccessToken: () => [],
      mcpRefreshToken: () => [],
    });
    const request = toContainmentRequest({ revoke: { serviceAccountIds: ["sa-live", "sa-dead"], mcpClientIds: ["mcp-live", "mcp-dead"] } });
    const result = await containMemberInTx(writes.tx, containArgs(request!));

    expect(writes.wheres.serviceAccountToken.updateManyAndReturn).toEqual([
      { serviceAccountId: { in: ["sa-live"] }, tenantId: TENANT, revokedAt: null },
    ]);
    for (const model of ["mcpAccessToken", "mcpRefreshToken"]) {
      expect(writes.wheres[model].updateManyAndReturn).toEqual([{ clientId: { in: ["mcp-live"] }, tenantId: TENANT, revokedAt: null }]);
    }
    expect(result.contained).toEqual({ serviceAccounts: { revoked: 1, skipped: 1 }, mcpClients: { revoked: 1, skipped: 1 } });
  });

  it("audits exactly the rows each bulk write returned, in one batch per kind", async () => {
    const writes = recordingTx({ scimToken: () => [{ id: "scim-a" }, { id: "scim-b" }] });
    const request = toContainmentRequest({ revoke: { scimTokenIds: ["scim-a", "scim-b", "scim-gone"] } });
    const result = await containMemberInTx(writes.tx, containArgs(request!));

    expect(logAuditBulkInTx).toHaveBeenCalledTimes(1);
    const [, tenant, rows] = vi.mocked(logAuditBulkInTx).mock.calls[0];
    expect(tenant).toBe(TENANT);
    expect(rows.map((r) => r.targetId)).toEqual(["scim-a", "scim-b"]);
    expect(result.contained).toEqual({ scimTokens: { revoked: 2, skipped: 1 } });
  });

  it("counts a token revoked with its service account as contained only when it was the member's and unexpired", async () => {
    const LATER = new Date(NOW.getTime() + 60_000);
    const writes = recordingTx({
      serviceAccount: () => [{ id: "sa-1" }],
      // The service account's statement revokes all three; the token statement then finds none live.
      serviceAccountToken: (where) =>
        "serviceAccountId" in where
          ? [
              { id: "tok-member", serviceAccountId: "sa-1", createdById: TARGET, expiresAt: LATER },
              { id: "tok-bystander", serviceAccountId: "sa-1", createdById: "someone-else", expiresAt: LATER },
              { id: "tok-expired", serviceAccountId: "sa-1", createdById: TARGET, expiresAt: NOW },
            ]
          : [],
    });
    const request = toContainmentRequest({
      revoke: { serviceAccountIds: ["sa-1"], serviceAccountTokenIds: ["tok-member", "tok-bystander", "tok-expired"] },
    });
    const result = await containMemberInTx(writes.tx, containArgs(request!));

    expect(result.contained.serviceAccountTokens).toEqual({ revoked: 1, skipped: 2 });
    const tokenRows = vi
      .mocked(logAuditBulkInTx)
      .mock.calls.flatMap(([, , rows]) => rows)
      .filter((r) => r.action === "SERVICE_ACCOUNT_TOKEN_REVOKE");
    expect(tokenRows.map((r) => [r.targetId, r.metadata?.revokedWithServiceAccount])).toEqual([["tok-member", true]]);
  });

  it("refuses to count accounts the delete did not remove: the containment rolls back", async () => {
    const writes = recordingTx({ account: () => [{ id: "acc-1", tenantId: TENANT }, { id: "acc-2", tenantId: "other" }] });
    // The delete removes one of the two rows read.
    const tx = new Proxy(writes.tx as object, {
      get: (target, model: string) =>
        model === "account"
          ? { ...(target as Record<string, object>)[model], deleteMany: async () => ({ count: 1 }) }
          : (target as Record<string, unknown>)[model],
    });
    const request = toContainmentRequest({ unlinkAccountIds: ["acc-1", "acc-2"] });
    await expect(containMemberInTx(tx as never, containArgs(request!))).rejects.toThrow(/1 of 2 accounts/);
  });

  it("every tenant-owned kind names the admin's tenant; the user's kinds match on the user", async () => {
    const listing = recordingTx();
    await listMemberContainment(listing.tx, { tenantId: TENANT, targetUserId: TARGET, role: "OWNER", now: NOW });
    for (const model of ["scimToken", "serviceAccount", "serviceAccountToken", "mcpClient", "personalLogAccessGrant"]) {
      expect(listing.wheres[model].findMany[0]).toMatchObject({ tenantId: TENANT });
    }
    expect(listing.wheres.emergencyAccessGrant.findMany[0]).toEqual({ ownerId: TARGET, status: { notIn: ["REVOKED", "REJECTED"] } });
    expect(listing.wheres.account.findMany[0]).toEqual({ userId: TARGET });
  });
});

describe("tenant webhooks and vault resets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists a webhook without its secret and a reset without its token or recorded email", async () => {
    const listing = recordingTx();
    await listMemberContainment(listing.tx, { tenantId: TENANT, targetUserId: TARGET, role: "OWNER", now: NOW });
    const select = (model: string) => (listing.selects[model] ?? [])[0] as Record<string, unknown>;
    expect(select("tenantWebhook")).toEqual({ id: true, url: true, isActive: true, createdAt: true });
    expect(select("adminVaultReset")).toEqual({
      id: true,
      targetUserId: true,
      targetUser: { select: { name: true, email: true } },
      createdAt: true,
      expiresAt: true,
    });
    for (const model of ["tenantWebhook", "adminVaultReset"]) {
      for (const secret of ["secretEncrypted", "secretIv", "secretAuthTag", "tokenHash", "encryptedToken", "targetEmailAtInitiate"]) {
        expect(JSON.stringify(select(model)), `${model}.${secret}`).not.toContain(secret);
      }
    }
  });

  it("matches a reset only while it is pending: unapproved, unexecuted, unrevoked, unexpired, initiated by the member", async () => {
    const listing = recordingTx();
    await listMemberContainment(listing.tx, { tenantId: TENANT, targetUserId: TARGET, role: "OWNER", now: NOW });
    expect(listing.wheres.adminVaultReset.findMany[0]).toEqual({
      tenantId: TENANT,
      initiatedById: TARGET,
      approvedAt: null,
      executedAt: null,
      revokedAt: null,
      expiresAt: { gt: NOW },
    });
    expect(listing.wheres.tenantWebhook.findMany[0]).toEqual({ tenantId: TENANT, createdById: TARGET });
  });

  it("deletes the webhooks it read and audits each, with the url masked and the member named", async () => {
    const writes = recordingTx({ tenantWebhook: () => [{ id: "wh-a", url: "https://hooks.example.com/in?token=secret" }] });
    const result = await containMemberInTx(
      writes.tx,
      containArgs(toContainmentRequest({ revoke: { tenantWebhookIds: ["wh-a", "wh-gone"] } })!),
    );

    expect(writes.wheres.tenantWebhook.deleteMany).toEqual([
      { id: { in: ["wh-a"] }, tenantId: TENANT, createdById: TARGET },
    ]);
    const [, , rows] = vi.mocked(logAuditBulkInTx).mock.calls[0];
    expect(rows).toEqual([
      expect.objectContaining({
        action: "TENANT_WEBHOOK_DELETE",
        metadata: { webhookId: "wh-a", url: "https://hooks.example.com/in", targetUserId: TARGET },
      }),
    ]);
    expect(result.contained.tenantWebhooks).toEqual({ revoked: 1, skipped: 1 });
  });

  it("rolls back when the webhook delete removes fewer rows than were read", async () => {
    const writes = recordingTx({ tenantWebhook: () => [{ id: "a", url: "https://x.example" }, { id: "b", url: "https://y.example" }] });
    const tx = new Proxy(writes.tx as object, {
      get: (target, model: string) =>
        model === "tenantWebhook"
          ? { ...(target as Record<string, object>)[model], deleteMany: async () => ({ count: 1 }) }
          : (target as Record<string, unknown>)[model],
    });
    await expect(
      containMemberInTx(tx as never, containArgs(toContainmentRequest({ revoke: { tenantWebhookIds: ["a", "b"] } })!)),
    ).rejects.toThrow(/1 of 2 webhooks/);
  });

  it("revokes resets clearing the token, and audits each against its target user", async () => {
    const writes = recordingTx({ adminVaultReset: () => [{ id: "vr-a", targetUserId: "victim" }] });
    const result = await containMemberInTx(
      writes.tx,
      containArgs(toContainmentRequest({ revoke: { vaultResetIds: ["vr-a", "vr-gone"] } })!),
    );

    expect(writes.updates.adminVaultReset).toEqual([{ revokedAt: NOW, encryptedToken: null }]);
    const [, , rows] = vi.mocked(logAuditBulkInTx).mock.calls[0];
    expect(rows).toEqual([
      expect.objectContaining({
        action: "ADMIN_VAULT_RESET_REVOKE",
        targetType: "User",
        targetId: "victim",
        metadata: { resetId: "vr-a", initiatedById: TARGET, revokedById: "admin-1" },
      }),
    ]);
    expect(result.contained.vaultResets).toEqual({ revoked: 1, skipped: 1 });
  });

  it("reports what is still live per kind after the writes, including kinds the request did not name", async () => {
    const writes = recordingTx({}, { scimToken: 2, tenantWebhook: 1, adminVaultReset: 0 });
    const result = await containMemberInTx(
      writes.tx,
      containArgs(toContainmentRequest({ revoke: { vaultResetIds: ["vr-a"] } })!),
    );
    expect(result.remaining).toMatchObject({ scimTokens: 2, tenantWebhooks: 1, vaultResets: 0, mcpClients: 0 });
  });

  it("omits the kinds the actor may not contain from remaining", async () => {
    const writes = recordingTx();
    const result = await containMemberInTx(writes.tx, {
      ...containArgs(toContainmentRequest({ revoke: { scimTokenIds: ["s"] } })!),
      role: "ADMIN",
    });
    expect(result.remaining).not.toHaveProperty("breakglassGrants");
    expect(result.remaining).toHaveProperty("tenantWebhooks");
  });
});

describe("toContainmentRequest", () => {
  it.each([[null], [{}], [{ unlinkAccountIds: [], revoke: {} }], [{ revoke: { scimTokenIds: [] } }]])(
    "is null when the body names nothing (%j)",
    (input) => {
      expect(toContainmentRequest(input)).toBeNull();
    },
  );

  it("deduplicates ids and fills every kind", () => {
    expect(toContainmentRequest({ unlinkAccountIds: ["a", "a"], revoke: { mcpClientIds: ["m"] } })).toEqual({
      unlinkAccountIds: ["a"],
      revoke: {
        scimTokens: [],
        serviceAccounts: [],
        serviceAccountTokens: [],
        mcpClients: ["m"],
        breakglassGrants: [],
        tenantWebhooks: [],
        vaultResets: [],
        emergencyAccessGrants: [],
      },
    });
  });
});

describe("mayContainKind", () => {
  it("lets an OWNER contain every kind", () => {
    for (const kind of Object.values(FOOTHOLD_KIND)) expect(mayContainKind("OWNER", kind)).toBe(true);
  });

  it("refuses break-glass grants to an ADMIN, and nothing else", () => {
    expect(Object.values(FOOTHOLD_KIND).filter((k) => !mayContainKind("ADMIN", k))).toEqual([FOOTHOLD_KIND.BREAKGLASS_GRANTS]);
  });

  it("refusedContainmentKinds names only kinds the request names", () => {
    const request = toContainmentRequest({ revoke: { breakglassGrantIds: ["b"], scimTokenIds: ["s"] } })!;
    expect(refusedContainmentKinds("ADMIN", request)).toEqual([FOOTHOLD_KIND.BREAKGLASS_GRANTS]);
    expect(refusedContainmentKinds("ADMIN", toContainmentRequest({ revoke: { scimTokenIds: ["s"] } })!)).toEqual([]);
  });
});
