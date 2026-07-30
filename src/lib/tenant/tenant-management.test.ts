import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TxOrPrisma } from "@/lib/prisma";

const { mockPrisma, mockSlugifyTenant, mockAdvisoryXactLock } = vi.hoisted(() => {
  const mockPrisma = {
    tenant: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    tenantClaim: {
      findUnique: vi.fn(),
    },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
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

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findOrCreateTenantForClaim } from "./tenant-management";
import { EXTERNAL_ID_FOLD_SQL } from "./tenant-claim-registry";

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
    // No tenant's external_id folds onto the claim — the default for every
    // case below except the F-A collision ones, which override it.
    mockPrisma.$queryRaw.mockResolvedValue([]);
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
    mockPrisma.tenant.findUnique.mockResolvedValue(null); // externalId fallback miss
    mockPrisma.tenant.create.mockResolvedValue({ id: "tenant-new" });

    const result = await findOrCreateTenantForClaim("acme.com", db);

    expect(result).toEqual({ kind: "tenant", id: "tenant-new" });
    expect(mockPrisma.tenant.create).toHaveBeenCalledWith({
      data: {
        externalId: "acme.com", // D1: release 1 still writes it
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
    mockPrisma.tenant.findUnique.mockResolvedValue(null);
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
    expect(secondCreate.data.externalId).toBe("acme.com");
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
    expect(sql).toEqual([
      "SAVEPOINT tenant_claim_create",
      "ROLLBACK TO SAVEPOINT tenant_claim_create",
      "RELEASE SAVEPOINT tenant_claim_create",
    ]);
    expect(mockPrisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrisma.tenant.create.mock.invocationCallOrder[0],
    );
  });

  it("returns claim_invalid when the normalised claim fails storableClaimSchema, with no create (I5)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.findUnique.mockResolvedValue(null);

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
    expect(result).toEqual({ kind: "claim_invalid", tenantId: null });
    expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
  });

  // Round-3's ":111 returns null on double P2002 collision" is deleted, not
  // restated: it modeled the OLD externalId-race retry path (two racing
  // creators both getting P2002 on tenants_external_id_key). That path is
  // gone — the advisory lock serialises same-claim creation, and a second
  // P2002 from the SAVEPOINT retry (different-claim slug collision, twice)
  // is no longer specially handled; it propagates like any other error,
  // already covered by the "throws non-P2002 errors" shape below.

  it("throws non-P2002 errors", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.create.mockRejectedValueOnce(new Error("DB down"));

    await expect(findOrCreateTenantForClaim("acme.com", db)).rejects.toThrow(
      "DB down",
    );
  });

  it("creates a tenant for a non-domain claim like acmecorp (NF2)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.findUnique.mockResolvedValue(null);
    mockSlugifyTenant.mockReturnValue("acmecorp");
    mockPrisma.tenant.create.mockResolvedValue({ id: "tenant-nf2" });

    const result = await findOrCreateTenantForClaim("acmecorp", db);

    expect(result).toEqual({ kind: "tenant", id: "tenant-nf2" });
    expect(mockPrisma.tenant.create).toHaveBeenCalledWith({
      data: {
        externalId: "acmecorp",
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
    // bind the audit row. Without it logAuditAsync dead-letters on a
    // first-ever sign-in (no user row for SYSTEM_ACTOR_ID) and the denial
    // never reaches `tenant-domain unmapped`.
    expect(result).toEqual({ kind: "claim_taken", tenantId: "tenant-owner" });
    // No fallback either — a revoked row is taken, not "not found".
    expect(mockPrisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
  });

  it("resolves through the externalId fallback without creating (D1 release-1 case)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.findUnique.mockResolvedValue({ id: "tenant-legacy" });

    const result = await findOrCreateTenantForClaim("alias.example", db);

    expect(result).toEqual({ kind: "tenant", id: "tenant-legacy" });
    expect(mockPrisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { externalId: "alias.example" },
      select: { id: true },
    });
    expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
  });

  // Round-1 M12: the case above cannot distinguish raw from normalised —
  // "alias.example" is its own normal form. D-3 makes the RAW spelling
  // load-bearing: the fallback exists to keep NF2 true in release 1 for a
  // deployment whose tenants.external_id was stored un-normalised, and
  // folding the key before the lookup would miss exactly those rows.
  it("queries the externalId fallback with the RAW claim while the registry gets the normalised one (D-3)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.findUnique.mockResolvedValue({ id: "tenant-legacy-mixed" });

    const result = await findOrCreateTenantForClaim("Alias.Example", db);

    expect(result).toEqual({ kind: "tenant", id: "tenant-legacy-mixed" });
    expect(mockPrisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { externalId: "Alias.Example" },
      select: { id: true },
    });
    expect(mockPrisma.tenantClaim.findUnique).toHaveBeenCalledWith({
      where: { claim: "alias.example" },
      select: { tenantId: true, revokedAt: true },
    });
    expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
  });

  // ── Round-2 F-A: the free UNIQUE(claim) slot left by M3's collision-aware
  // backfill must not be squattable by a third spelling.

  it("returns claim_collision instead of creating when an existing tenant's external_id folds onto the claim", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null); // no claim row (M3 excluded both sides)
    mockPrisma.tenant.findUnique.mockResolvedValue(null); // "Acme.com" matches neither raw external_id
    mockPrisma.$queryRaw.mockResolvedValue([{ id: "tenant-a" }]); // but "acme.com" folds onto tenant A

    const result = await findOrCreateTenantForClaim("Acme.com", db);

    // claim_collision, NOT claim_taken: there is no row to un-revoke, and the
    // operator's entry point is `preflight`, not `list`.
    // Same binding requirement as claim_taken — here the folded owner.
    expect(result).toEqual({ kind: "claim_collision", tenantId: "tenant-a" });
    // The whole point: tenant C is never created, so the claim row that would
    // outrank A's and B's externalId fallback is never written.
    expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("binds the folded-external_id probe as a query parameter, never interpolated", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.findUnique.mockResolvedValue(null);
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.tenant.create.mockResolvedValue({ id: "tenant-new" });

    await findOrCreateTenantForClaim("Acme.com'; DROP TABLE tenants; --", db);

    // $queryRaw is a tagged template: [0] is the TemplateStringsArray, the
    // rest are the bound values. The claim must appear ONLY among the values.
    const [strings, ...values] = mockPrisma.$queryRaw.mock.calls[0];
    expect(values).toEqual(["acme.com'; drop table tenants; --"]);
    expect(strings.join("?")).not.toContain("acme.com");
    // Round-3 T8: the fold used to be a hand-copied string literal here, so
    // this assertion pinned the test's own copy against the source's — two
    // copies agreeing with each other and with nothing else. It now imports
    // the shared constant, which the registry's drift guard pins against all
    // five spellings (the migration, the backfill, both preflight queries and
    // this probe).
    expect(strings.join("?")).toContain(EXTERNAL_ID_FOLD_SQL);
  });

  it("orders the folded-external_id probe so a multi-way collision names one tenant deterministically", () => {
    // Round-3 M2. `LIMIT 1` with no `ORDER BY` lets Postgres return any side
    // of the collision, and the id it returns binds the AUTH_LOGIN_FAILURE
    // row — so one lockout would be filed under a different tenant on
    // different runs and `tenant-domain unmapped`, which groups by tenant_id,
    // would split it into two groups. The behavioural proof is in
    // tenant-claim.integration.test.ts against real Postgres; this pins the
    // clause itself, which a mock cannot exercise.
    const sql = readFileSync(
      resolve(__dirname, "tenant-management.ts"),
      "utf8",
    );
    expect(sql).toMatch(/ORDER BY created_at ASC, id ASC\s*\n\s*LIMIT 1/);
  });

  it("does not probe for a fold collision when the exact-match externalId fallback already resolved", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.findUnique.mockResolvedValue({ id: "tenant-legacy" });

    const result = await findOrCreateTenantForClaim("acme.com", db);

    expect(result).toEqual({ kind: "tenant", id: "tenant-legacy" });
    // A tenant that owns the raw spelling resolves to itself; the probe would
    // find that same tenant and turn a working sign-in into a refusal.
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
  });
});
