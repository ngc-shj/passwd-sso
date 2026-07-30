import { describe, it, expect, vi, beforeEach } from "vitest";

// A NEW file, deliberately not tenant-management.test.ts: that file's
// factory mock of "@/lib/tenant/tenant-claim" would shadow the real
// normaliser this suite needs to exercise (RT5). No mock on
// tenant-claim-registry.ts here — normalizeTenantClaim / storableClaimSchema
// run for real.

const mockPrisma = vi.hoisted(() => ({
  tenantClaim: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  tenant: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  // The fold probe added in round-5 F2. Present on the mock surface because
  // the resolver now reaches it on the no-match path.
  $queryRaw: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mockPrisma,
}));

import { resolveTenantByClaim } from "./tenant-management";
// Real producer: `ClaimRefusalDiagnosis` is branded (round-6 SEC-R6-3), so this
// expectation cannot be spelled as a literal.
import { claimRefusal } from "./claim-refusal";

describe("resolveTenantByClaim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The fold probe (round-5 F2) runs only after both lookups miss. Default
    // it to "no collision" so the pre-existing cases keep testing what they
    // name; the collision case overrides it.
    mockPrisma.$queryRaw.mockResolvedValue([]);
  });

  it("resolves a registered claim to its tenant", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue({
      tenantId: "tenant-1",
      revokedAt: null,
    });

    const result = await resolveTenantByClaim("alias.example");

    expect(result).toEqual({ kind: "tenant", id: "tenant-1" });
    expect(mockPrisma.tenantClaim.findUnique).toHaveBeenCalledWith({
      where: { claim: "alias.example" },
      select: { tenantId: true, revokedAt: true },
    });
  });

  it("reports an unregistered claim with no externalId match, asserting zero writes (I5)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.findUnique.mockResolvedValue(null);

    const result = await resolveTenantByClaim("unregistered.example");

    expect(result).toEqual({ kind: "unregistered" });
    expect(mockPrisma.tenant.create).not.toHaveBeenCalled();
    expect(mockPrisma.tenantClaim.create).not.toHaveBeenCalled();
    expect(mockPrisma.tenantClaim.update).not.toHaveBeenCalled();
  });

  it("resolves the row stored as alias.example when queried as Alias.Example (real normaliser)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue({
      tenantId: "tenant-2",
      revokedAt: null,
    });

    const result = await resolveTenantByClaim("Alias.Example");

    expect(result).toEqual({ kind: "tenant", id: "tenant-2" });
    expect(mockPrisma.tenantClaim.findUnique).toHaveBeenCalledWith({
      where: { claim: "alias.example" },
      select: { tenantId: true, revokedAt: true },
    });
  });

  it("resolves a registered non-domain claim (NF2)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue({
      tenantId: "tenant-3",
      revokedAt: null,
    });

    const result = await resolveTenantByClaim("acmecorp");

    expect(result).toEqual({ kind: "tenant", id: "tenant-3" });
  });

  it("reports an UNSTORABLE claim distinctly from an unregistered one", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.findUnique.mockResolvedValue(null);

    // Round-5 F3. "café.example" normalises to a non-ASCII value
    // storableClaimSchema rejects, so no `tenant-domain add` can ever
    // register it. Reporting it as `unregistered` made the dispatch emit
    // `tenant_claim_unmapped`, and `tenant-domain unmapped` then printed it
    // under "run tenant-domain add" — a command guaranteed to refuse it. The
    // resolver is now the single adjudicator of "is this registrable at all".
    // Round-6 F1: the arm carries the DIAGNOSIS, derived from the schema's own
    // issue rather than written here, because `tenant-domain unmapped` buckets
    // on whether `claimRefusal` is set — without it this population printed
    // under "registered to a DIFFERENT tenant — move it with `add --from`".
    // The message is `storableClaimSchema`'s, so a refinement whose wording
    // changes is described correctly without an edit here.
    await expect(resolveTenantByClaim("café.example")).resolves.toEqual({
      kind: "unstorable",
      refusal: claimRefusal("claim must be printable ASCII"),
    });
    // Still no writes, and the probe is not reached: an unstorable claim
    // cannot collide with anything.
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("reports a fold COLLISION with the colliding tenant, after both lookups miss", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.findUnique.mockResolvedValue(null);
    mockPrisma.$queryRaw.mockResolvedValue([{ id: "tenant-folded-owner" }]);

    const result = await resolveTenantByClaim("Alias.Example");

    // Round-5 F2: without this arm the dispatch filed a fold-collision denial
    // under the USER's tenant while the no-membership path filed the same
    // lockout under the colliding tenant — one incident, two `unmapped`
    // groups.
    expect(result).toEqual({ kind: "collision", tenantId: "tenant-folded-owner" });
  });

  it("does not run the fold probe when the claim resolves", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue({ tenantId: "tenant-1", revokedAt: null });

    await resolveTenantByClaim("alias.example");

    // An ordinary sign-in must not pay for the two extra reads the refusal
    // arms need.
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    expect(mockPrisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it("reports a revoked claim row WITH its owner, and does NOT consult the externalId fallback", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue({
      tenantId: "tenant-revoked-owner",
      revokedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const result = await resolveTenantByClaim("alias.example");

    // Round-4 F1: `revoked` and `unregistered` were the same `null`, and the
    // caller filed its denial under the USER's tenant for both — while the
    // no-membership path filed the identical lockout under the CLAIM's owner.
    // `tenant-domain unmapped` groups by (tenant_id, claim), so one incident
    // arrived as two groups. Carrying the owner is what lets the dispatch
    // agree with itself.
    expect(result).toEqual({ kind: "revoked", tenantId: "tenant-revoked-owner" });
    expect(mockPrisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it("resolves through the externalId fallback when no claim row exists (D1 release-1 case)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.findUnique.mockResolvedValue({ id: "tenant-legacy" });

    const result = await resolveTenantByClaim("alias.example");

    expect(result).toEqual({ kind: "tenant", id: "tenant-legacy" });
    expect(mockPrisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { externalId: "alias.example" },
      select: { id: true },
    });
  });

  // Round-1 M12: "alias.example" is its own normal form, so the case above
  // holds whether the fallback is passed the raw or the normalised claim. D-3
  // makes the RAW spelling load-bearing — the fallback is what keeps NF2 true
  // in release 1 for a deployment whose tenants.external_id was stored
  // un-normalised, and those rows are invisible to a folded lookup.
  it("queries the externalId fallback with the RAW claim while the registry gets the normalised one (D-3)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);
    mockPrisma.tenant.findUnique.mockResolvedValue({ id: "tenant-legacy-mixed" });

    const result = await resolveTenantByClaim("Alias.Example");

    expect(result).toEqual({ kind: "tenant", id: "tenant-legacy-mixed" });
    expect(mockPrisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { externalId: "Alias.Example" },
      select: { id: true },
    });
    expect(mockPrisma.tenantClaim.findUnique).toHaveBeenCalledWith({
      where: { claim: "alias.example" },
      select: { tenantId: true, revokedAt: true },
    });
  });
});
