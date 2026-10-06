import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TxOrPrisma } from "@/lib/prisma";

const { mockPrisma, mockSlugifyTenant, mockAdvisoryXactLock } = vi.hoisted(() => {
  const mockPrisma = {
    tenant: {
      create: vi.fn(),
    },
    tenantClaim: {
      findUnique: vi.fn(),
    },
    $executeRaw: vi.fn(),
  };
  return {
    mockPrisma,
    mockSlugifyTenant: vi.fn(),
    mockAdvisoryXactLock: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/tenant/tenant-claim", () => ({
  slugifyTenant: mockSlugifyTenant,
}));

vi.mock("@/lib/tenant-rls", () => ({
  advisoryXactLock: mockAdvisoryXactLock,
}));

import { findOrCreateTenantForClaim } from "./tenant-management";

// findOrCreateTenantForClaim's `db` parameter is REQUIRED (no `= prisma`
// default — see the doc comment: a default would let the advisory lock run
// in autocommit mode outside a real transaction). Every call below passes
// the mocked client explicitly, cast the same way other tests in this repo
// cast a mock object to TxOrPrisma (see scim-group-service.test.ts).
const db = mockPrisma as unknown as TxOrPrisma;

describe("findOrCreateTenantForClaim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSlugifyTenant.mockReturnValue("acme-com");
    mockAdvisoryXactLock.mockResolvedValue(undefined);
    mockPrisma.$executeRaw.mockResolvedValue(1);
  });

  it("resolves an already-registered claim via the claim registry, without creating", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue({
      tenantId: "tenant-1",
      revokedAt: null,
    });

    const result = await findOrCreateTenantForClaim("acme.com", db);

    expect(result).toEqual({ kind: "tenant", id: "tenant-1" });
    expect(mockPrisma.tenantClaim.findUnique).toHaveBeenCalledWith({
      where: { claim: "acme.com" },
      select: { tenantId: true, revokedAt: true },
    });
    expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
  });

  it("creates a new tenant with its claim row in one nested create when not found", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.create.mockResolvedValue({ id: "tenant-new" });

    const result = await findOrCreateTenantForClaim("acme.com", db);

    expect(result).toEqual({ kind: "tenant", id: "tenant-new" });
    expect(mockPrisma.tenant.create).toHaveBeenCalledWith({
      data: {
        name: "acme.com",
        slug: "acme-com",
        claims: { create: { claim: "acme.com", createdBy: "signin" } },
      },
      select: { id: true },
    });
  });

  // Round-3's ":62 retries findUnique after P2002 on externalId" is deleted,
  // not adjusted: the advisory lock removes the concurrent claim-key race
  // this test existed to cover — two concurrent creators for the same claim
  // now serialise at advisoryXactLock and the second observes the first's
  // committed row at the resolve step, so a P2002 on tenant_claims_claim_key
  // is no longer reachable at all.

  it("retries with a fallback slug on slug collision (SAVEPOINT arm)", async () => {
    const { Prisma } = await import("@prisma/client");
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.create
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("unique", {
          code: "P2002",
          clientVersion: "7.0.0",
        }),
      )
      .mockResolvedValueOnce({ id: "tenant-fallback" });

    const result = await findOrCreateTenantForClaim("acme.com", db);

    expect(result).toEqual({ kind: "tenant", id: "tenant-fallback" });
    expect(mockPrisma.tenant.create).toHaveBeenCalledTimes(2);
    const secondCreate = mockPrisma.tenant.create.mock.calls[1][0];
    expect(secondCreate.data.slug).toMatch(/^acme-com-[0-9a-f]{8}$/);
    expect(secondCreate.data.claims).toEqual({
      create: { claim: "acme.com", createdBy: "signin" },
    });
    // SAVEPOINT, then ROLLBACK TO SAVEPOINT (on the P2002), then RELEASE
    // SAVEPOINT (after the retry succeeds). Asserted by SQL text and by
    // invocation order against tenant.create, NOT by call count (round-1 M9):
    // a count of three survives moving the SAVEPOINT *after* the create,
    // which is the exact round-4 N6 regression — a savepoint opened after an
    // aborting statement cannot recover the session. `$executeRaw` is a
    // tagged template, so each call's first argument is the
    // TemplateStringsArray and [0] is its literal SQL.
    const sql = mockPrisma.$executeRaw.mock.calls.map((c) => c[0][0]);
    expect(sql.slice(0, 3)).toEqual([
      "SAVEPOINT tenant_claim_create",
      "ROLLBACK TO SAVEPOINT tenant_claim_create",
      "RELEASE SAVEPOINT tenant_claim_create",
    ]);
    expect(mockPrisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrisma.tenant.create.mock.invocationCallOrder[0],
    );

    // The routing-history write (SC11 / #743) is the fourth statement, and its
    // position is the contract, not an incidental ordering: it must come AFTER
    // `RELEASE SAVEPOINT`. Both `tenant.create` calls above are mutually
    // exclusive alternatives of ONE logical registration — the second runs only
    // after the rollback undid the first — so an event written inside either arm
    // would double-emit, or record a tenant that no longer exists. Asserted by
    // position rather than by presence, because presence survives moving it into
    // the try block, which is the regression this pins.
    expect(sql).toHaveLength(4);
    expect(sql[3]).toContain("INSERT INTO tenant_claim_events");
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(4);
  });

  it("returns claim_invalid when the normalised claim fails storableClaimSchema, with no create (I5)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);

    // Truthy-but-invalid fixture (round-3 M27): src/auth.ts:53 is
    // `if (!tenantClaim)`, so an empty string never reaches this function.
    // A whitespace-only string is truthy but normalises to "", which
    // storableClaimSchema rejects (min length 1).
    const result = await findOrCreateTenantForClaim(" ", db);

    // Distinct from claim_taken (round-1 M1/M2): this arm is the SC9
    // narrowing, and src/auth.ts maps it to tenant_mismatch, not to
    // tenant_claim_unmapped.
    // tenantId is null by construction: no tenant exists for an unstorable
    // claim, so there is nothing for the caller's audit row to bind to.
    // Round-6 F1: the arm carries the diagnosis, taken from the schema's own
    // issue, because `tenant-domain unmapped` buckets on that field. `" "`
    // normalises to the empty string, so the issue is the min-length one rather
    // than the printable-ASCII one — which is the point of deriving it.
    expect(result).toEqual({
      kind: "claim_invalid",
      tenantId: null,
      refusal: expect.stringMatching(/^refused: /) as unknown as string,
    });
    expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
  });

  // Round-3's ":111 returns null on double P2002 collision" is deleted, not
  // restated: it modeled the OLD externalId-race retry path (two racing
  // creators both getting P2002 on the now-dropped external-id unique index).
  // That path is gone — the advisory lock serialises same-claim creation, and a second
  // P2002 from the SAVEPOINT retry (different-claim slug collision, twice)
  // is no longer specially handled; it propagates like any other error,
  // already covered by the "throws non-P2002 errors" shape below.

  it("throws non-P2002 errors", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.create.mockRejectedValueOnce(new Error("DB down"));

    await expect(findOrCreateTenantForClaim("acme.com", db)).rejects.toThrow(
      "DB down",
    );
  });

  it("creates a tenant for a non-domain claim like acmecorp (NF2)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockSlugifyTenant.mockReturnValue("acmecorp");
    mockPrisma.tenant.create.mockResolvedValue({ id: "tenant-nf2" });

    const result = await findOrCreateTenantForClaim("acmecorp", db);

    expect(result).toEqual({ kind: "tenant", id: "tenant-nf2" });
    expect(mockPrisma.tenant.create).toHaveBeenCalledWith({
      data: {
        name: "acmecorp",
        slug: "acmecorp",
        claims: { create: { claim: "acmecorp", createdBy: "signin" } },
      },
      select: { id: true },
    });
  });

  it("calls advisoryXactLock before resolving, keyed on the normalised claim", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue({
      tenantId: "tenant-1",
      revokedAt: null,
    });

    await findOrCreateTenantForClaim("Alias.Example", db);

    expect(mockAdvisoryXactLock).toHaveBeenCalledWith(db, "tenant-claim:alias.example");
    const lockOrder = mockAdvisoryXactLock.mock.invocationCallOrder[0];
    const resolveOrder = mockPrisma.tenantClaim.findUnique.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(resolveOrder);
  });

  it("returns claim_taken for a revoked claim row and does not create (D2)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue({
      tenantId: "tenant-owner",
      revokedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const result = await findOrCreateTenantForClaim("alias.example", db);

    // claim_taken, NOT claim_invalid: src/auth.ts maps this one to
    // tenant_claim_unmapped so `tenant-domain unmapped` can see the lockout.
    // The owning tenant rides along so the caller's emitAuthLoginFailure can
    // bind the audit row. Without it logAuditAsync files the row under
    // SYSTEM_TENANT_ID on a first-ever sign-in (no user row for
    // SYSTEM_ACTOR_ID) and the denial never reaches `tenant-domain unmapped`
    // — which groups by tenant_id, so it shows under `__system__` instead of
    // under the tenant that owns the contested claim.
    expect(result).toEqual({ kind: "claim_taken", tenantId: "tenant-owner" });
    // A revoked row is taken, not "not found" — no create either.
    expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
  });
});
