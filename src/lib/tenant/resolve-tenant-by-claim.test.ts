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

  it("reports an unregistered claim when no claim row exists, asserting zero writes (I5)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);

    const result = await resolveTenantByClaim("unregistered.example");

    expect(result).toEqual({ kind: "unregistered" });
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

    // "café.example" normalises to a non-ASCII value storableClaimSchema
    // rejects, so no `tenant-domain add` can ever register it. Reporting it
    // as `unregistered` made the dispatch emit `tenant_claim_unmapped`, and
    // `tenant-domain unmapped` then printed it under "run tenant-domain add"
    // — a command guaranteed to refuse it. The resolver is the single
    // adjudicator of "is this registrable at all".
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
  });

  it("reports a revoked claim row WITH its owner (D2)", async () => {
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
  });
});
