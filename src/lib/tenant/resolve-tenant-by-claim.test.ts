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

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock("@/lib/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logger")>()),
  getLogger: () => ({ warn: mockWarn, error: vi.fn(), info: vi.fn() }),
}));

import {
  adjudicateClaimBinding,
  resolveTenantByClaim,
  type ClaimBindingVerdict,
  type ClaimRow,
} from "./tenant-management";
import { CLAIM_BINDING_MODE, type ClaimBindingMode } from "@/lib/auth/jackson-providers";
// Real producer: `ClaimRefusalDiagnosis` is branded (round-6 SEC-R6-3), so this
// expectation cannot be spelled as a literal.
import { claimRefusal } from "./claim-refusal";

const SIGN_IN_PROVIDER = "google";

function claimRow(row: ClaimRow): ClaimRow {
  return row;
}

describe("resolveTenantByClaim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves a registered claim to its tenant", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(
      claimRow({ tenantId: "tenant-1", revokedAt: null, provider: SIGN_IN_PROVIDER }),
    );

    const result = await resolveTenantByClaim("alias.example", SIGN_IN_PROVIDER, CLAIM_BINDING_MODE.OFF);

    expect(result).toEqual({ kind: "tenant", id: "tenant-1" });
    expect(mockPrisma.tenantClaim.findUnique).toHaveBeenCalledWith({
      where: { claim: "alias.example" },
      select: { tenantId: true, revokedAt: true, provider: true },
    });
  });

  it("reports an unregistered claim when no claim row exists, asserting zero writes (I5)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(null);

    const result = await resolveTenantByClaim("unregistered.example", SIGN_IN_PROVIDER, CLAIM_BINDING_MODE.OFF);

    expect(result).toEqual({ kind: "unregistered" });
    expect(mockPrisma.tenantClaim.create).not.toHaveBeenCalled();
    expect(mockPrisma.tenantClaim.update).not.toHaveBeenCalled();
  });

  it("resolves the row stored as alias.example when queried as Alias.Example (real normaliser)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(
      claimRow({ tenantId: "tenant-2", revokedAt: null, provider: SIGN_IN_PROVIDER }),
    );

    const result = await resolveTenantByClaim("Alias.Example", SIGN_IN_PROVIDER, CLAIM_BINDING_MODE.OFF);

    expect(result).toEqual({ kind: "tenant", id: "tenant-2" });
    expect(mockPrisma.tenantClaim.findUnique).toHaveBeenCalledWith({
      where: { claim: "alias.example" },
      select: { tenantId: true, revokedAt: true, provider: true },
    });
  });

  it("resolves a registered non-domain claim (NF2)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(
      claimRow({ tenantId: "tenant-3", revokedAt: null, provider: SIGN_IN_PROVIDER }),
    );

    const result = await resolveTenantByClaim("acmecorp", SIGN_IN_PROVIDER, CLAIM_BINDING_MODE.OFF);

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
    await expect(resolveTenantByClaim("café.example", SIGN_IN_PROVIDER, CLAIM_BINDING_MODE.OFF)).resolves.toEqual({
      kind: "unstorable",
      refusal: claimRefusal("claim must be printable ASCII"),
    });
  });

  it("reports a revoked claim row WITH its owner (D2)", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(
      claimRow({ tenantId: "tenant-revoked-owner", revokedAt: new Date("2026-01-01T00:00:00Z"), provider: SIGN_IN_PROVIDER }),
    );

    const result = await resolveTenantByClaim("alias.example", SIGN_IN_PROVIDER, CLAIM_BINDING_MODE.OFF);

    // Round-4 F1: `revoked` and `unregistered` were the same `null`, and the
    // caller filed its denial under the USER's tenant for both — while the
    // no-membership path filed the identical lockout under the CLAIM's owner.
    // `tenant-domain unmapped` groups by (tenant_id, claim), so one incident
    // arrived as two groups. Carrying the owner is what lets the dispatch
    // agree with itself.
    expect(result).toEqual({ kind: "revoked", tenantId: "tenant-revoked-owner" });
  });
});

/**
 * The binding adjudicator's arms (plan sso-claim-connection-binding, C4). One
 * case per verdict kind, typed so a new arm cannot be added without a case,
 * each paired with the adjacent allow where one exists.
 */
describe("adjudicateClaimBinding", () => {
  const BOUND_A = "saml-jackson-a";
  const BOUND_B = "saml-jackson-b";
  const REVOKED_AT = new Date("2026-01-01T00:00:00Z");

  type ArmCase = {
    row: ClaimRow;
    signInProvider: string;
    mode: ClaimBindingMode;
    expected: ClaimBindingVerdict;
  };

  const ARMS = {
    tenant: {
      row: { tenantId: "t-1", revokedAt: null, provider: BOUND_A },
      signInProvider: BOUND_A,
      mode: CLAIM_BINDING_MODE.STRICT,
      expected: { kind: "tenant", id: "t-1", unenforcedMismatch: null },
    },
    revoked: {
      // Revoked wins over a mismatch: the arm order puts it first.
      row: { tenantId: "t-1", revokedAt: REVOKED_AT, provider: BOUND_B },
      signInProvider: BOUND_A,
      mode: CLAIM_BINDING_MODE.STRICT,
      expected: { kind: "revoked", tenantId: "t-1" },
    },
    unbound: {
      row: { tenantId: "t-1", revokedAt: null, provider: null },
      signInProvider: BOUND_A,
      mode: CLAIM_BINDING_MODE.STRICT,
      expected: { kind: "unbound", tenantId: "t-1" },
    },
    provider_mismatch: {
      row: { tenantId: "t-1", revokedAt: null, provider: BOUND_B },
      signInProvider: BOUND_A,
      mode: CLAIM_BINDING_MODE.STRICT,
      expected: { kind: "provider_mismatch", tenantId: "t-1", boundProvider: BOUND_B },
    },
  } satisfies Record<ClaimBindingVerdict["kind"], ArmCase>;

  it.each(Object.entries(ARMS))("%s", (_kind, arm: ArmCase) => {
    expect(adjudicateClaimBinding(arm.row, arm.signInProvider, arm.mode)).toEqual(arm.expected);
  });

  it("off mode resolves a NULL row (strict's unbound arm)", () => {
    expect(
      adjudicateClaimBinding(ARMS.unbound.row, BOUND_A, CLAIM_BINDING_MODE.OFF),
    ).toEqual({ kind: "tenant", id: "t-1", unenforcedMismatch: null });
  });

  it("off mode resolves a row bound elsewhere, naming the unenforced mismatch", () => {
    expect(
      adjudicateClaimBinding(ARMS.provider_mismatch.row, BOUND_A, CLAIM_BINDING_MODE.OFF),
    ).toEqual({ kind: "tenant", id: "t-1", unenforcedMismatch: BOUND_B });
  });

  it("off mode still refuses a revoked row", () => {
    expect(
      adjudicateClaimBinding(ARMS.revoked.row, BOUND_A, CLAIM_BINDING_MODE.OFF),
    ).toEqual({ kind: "revoked", tenantId: "t-1" });
  });
});

describe("resolveTenantByClaim — binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("strict: a row bound to another provider is a mismatch carrying the owner", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(
      claimRow({ tenantId: "owner", revokedAt: null, provider: "saml-jackson-b" }),
    );
    await expect(
      resolveTenantByClaim("alias.example", "saml-jackson-a", CLAIM_BINDING_MODE.STRICT),
    ).resolves.toEqual({ kind: "provider_mismatch", tenantId: "owner", boundProvider: "saml-jackson-b" });
  });

  it("strict: a NULL row is unbound carrying the owner", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(
      claimRow({ tenantId: "owner", revokedAt: null, provider: null }),
    );
    await expect(
      resolveTenantByClaim("alias.example", "saml-jackson-a", CLAIM_BINDING_MODE.STRICT),
    ).resolves.toEqual({ kind: "unbound", tenantId: "owner" });
  });

  it("off: a mismatch on a bound row resolves and logs provider ids and tenant id only", async () => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(
      claimRow({ tenantId: "owner", revokedAt: null, provider: "saml-jackson-b" }),
    );
    await expect(
      resolveTenantByClaim("alias.example", "saml-jackson-a", CLAIM_BINDING_MODE.OFF),
    ).resolves.toEqual({ kind: "tenant", id: "owner" });
    const call = mockWarn.mock.calls.find(([, msg]) => msg === "auth.tenant_claim.provider_mismatch");
    expect(call?.[0]).toEqual({
      tenantId: "owner",
      boundProvider: "saml-jackson-b",
      signInProvider: "saml-jackson-a",
    });
  });

  it.each([
    ["bound to the same provider", "saml-jackson-a"],
    ["unbound", null],
  ] as const)("off: no mismatch warning for a row %s", async (_label, provider) => {
    mockPrisma.tenantClaim.findUnique.mockResolvedValue(
      claimRow({ tenantId: "owner", revokedAt: null, provider }),
    );
    await resolveTenantByClaim("alias.example", "saml-jackson-a", CLAIM_BINDING_MODE.OFF);
    expect(mockWarn).not.toHaveBeenCalled();
  });
});
