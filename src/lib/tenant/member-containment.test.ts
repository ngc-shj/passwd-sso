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

const MODEL_OF_KIND = {
  scimTokens: "scimToken",
  serviceAccounts: "serviceAccount",
  serviceAccountTokens: "serviceAccountToken",
  mcpClients: "mcpClient",
  breakglassGrants: "personalLogAccessGrant",
  emergencyAccessGrants: "emergencyAccessGrant",
} as const;

/**
 * A fake transaction recording every call's `where` per model and method.
 * A bulk write returns one row per id it names, or the rows `returns` gives
 * for its model.
 */
function recordingTx(returns: Record<string, (where: Record<string, unknown>) => unknown[]> = {}) {
  const wheres: Record<string, Record<string, unknown[]>> = {};
  const tx = new Proxy(
    {},
    {
      get: (_t, model: string) => {
        const record = (method: string) => async (args: { where: { id?: { in: string[] } } }) => {
          ((wheres[model] ??= {})[method] ??= []).push(args.where);
          const rows = () =>
            returns[model]?.(args.where) ??
            (args.where.id?.in ?? []).map((id) => ({ id, tenantId: TENANT, serviceAccountId: "sa", clientId: "c", targetUserId: "x", granteeId: null }));
          if (method === "findMany" || method === "updateManyAndReturn") return rows();
          if (method === "deleteMany") return { count: (args.where.id?.in ?? []).length };
          return { count: 1 };
        };
        return {
          findMany: record("findMany"),
          updateMany: record("updateMany"),
          updateManyAndReturn: record("updateManyAndReturn"),
          deleteMany: record("deleteMany"),
        };
      },
    },
  );
  return { tx: tx as never, wheres };
}

const ALL_KINDS_INPUT = {
  revoke: {
    scimTokenIds: ["id-1"],
    serviceAccountIds: ["id-2"],
    serviceAccountTokenIds: ["id-3"],
    mcpClientIds: ["id-4"],
    breakglassGrantIds: ["id-5"],
    emergencyAccessGrantIds: ["id-6"],
  },
};

const containArgs = (request: NonNullable<ReturnType<typeof toContainmentRequest>>) => ({
  req: new NextRequest("http://localhost/"),
  actorUserId: "admin-1",
  tenantId: TENANT,
  targetUserId: TARGET,
  request,
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
      } else {
        // One compare-and-set statement on the named ids and the same predicate.
        // (A contained service account's own token revocation is keyed by its
        // service account, not a token id.)
        const write = writes.wheres[model].updateManyAndReturn.find((w) => "id" in (w as object));
        expect(write, kind).toEqual({ id: { in: [expect.any(String)] }, ...(live as object) });
      }
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
