import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/tenant-rls", () => ({ isBypassRlsActive: () => true }));
vi.mock("@/lib/audit/audit", () => ({
  logAuditInTx: vi.fn(async () => {}),
  tenantAuditBase: vi.fn(() => ({ scope: "TENANT" })),
}));

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

/** A fake transaction recording every call's `where` per model and method. */
function recordingTx() {
  const wheres: Record<string, Record<string, unknown[]>> = {};
  const tx = new Proxy(
    {},
    {
      get: (_t, model: string) => {
        const record = (method: string) => async (args: { where: { id?: { in: string[] } } }) => {
          ((wheres[model] ??= {})[method] ??= []).push(args.where);
          if (method === "findMany") return (args.where.id?.in ?? []).map((id) => ({ id, tenantId: TENANT, serviceAccountId: "sa", targetUserId: "x", granteeId: null }));
          return { count: 1 };
        };
        return { findMany: record("findMany"), updateMany: record("updateMany"), deleteMany: record("deleteMany") };
      },
    },
  );
  return { tx: tx as never, wheres };
}

describe("member containment predicates", () => {
  it("the writes match exactly the rows the listing calls live, for every kind", async () => {
    const listing = recordingTx();
    await listMemberContainment(listing.tx, { tenantId: TENANT, targetUserId: TARGET, role: "OWNER", now: NOW });

    const writes = recordingTx();
    const request = toContainmentRequest({
      revoke: {
        scimTokenIds: ["id-1"],
        serviceAccountIds: ["id-2"],
        serviceAccountTokenIds: ["id-3"],
        mcpClientIds: ["id-4"],
        breakglassGrantIds: ["id-5"],
        emergencyAccessGrantIds: ["id-6"],
      },
    });
    expect(request).not.toBeNull();
    await containMemberInTx(writes.tx, {
      req: new NextRequest("http://localhost/"),
      actorUserId: "admin-1",
      tenantId: TENANT,
      targetUserId: TARGET,
      request: request!,
      now: NOW,
    });

    for (const [kind, model] of Object.entries(MODEL_OF_KIND)) {
      const [live] = listing.wheres[model].findMany;
      const [candidates] = writes.wheres[model].findMany;
      expect(candidates, kind).toEqual({ id: { in: [expect.any(String)] }, ...(live as object) });
      // The compare-and-set write re-checks the same predicate on the row.
      // (A contained service account's own token revocation is keyed by its
      // service account, not a token id.)
      const write = writes.wheres[model].updateMany.find((w) => "id" in (w as object));
      if (model === "emergencyAccessGrant") {
        // Through transition(): the owner predicate plus its allowed from-states.
        expect(write).toMatchObject({ id: expect.any(String), ownerId: TARGET });
      } else {
        expect(write, kind).toEqual({ id: expect.any(String), ...(live as object) });
      }
    }
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
