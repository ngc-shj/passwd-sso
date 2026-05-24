import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "../../helpers/request-builder";

const VALID_CNF_JKT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabb";

const {
  mockValidateExtensionToken,
  mockWithUserTenantRls,
  mockWithBypassRls,
  mockSessionFindFirst,
  mockTenantFindUnique,
  mockTransaction,
  mockRateLimitCheck,
  mockCheckRateLimitOrFail,
  mockEnforceAccessRestriction,
  mockRevokeExtensionTokenFamily,
} = vi.hoisted(() => ({
  mockValidateExtensionToken: vi.fn(),
  mockWithUserTenantRls: vi.fn(),
  mockWithBypassRls: vi.fn(),
  mockSessionFindFirst: vi.fn(),
  mockTenantFindUnique: vi.fn(),
  mockTransaction: vi.fn(),
  mockRateLimitCheck: vi.fn(),
  mockCheckRateLimitOrFail: vi.fn(),
  mockEnforceAccessRestriction: vi.fn(),
  mockRevokeExtensionTokenFamily: vi.fn(),
}));

vi.mock("@/lib/auth/tokens/extension-token", () => ({
  validateExtensionToken: mockValidateExtensionToken,
  revokeExtensionTokenFamily: mockRevokeExtensionTokenFamily,
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
  BYPASS_PURPOSE: { TOKEN_LIFECYCLE: "TOKEN_LIFECYCLE" },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    session: { findFirst: mockSessionFindFirst },
    tenant: { findUnique: mockTenantFindUnique },
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: vi.fn(() => ({ check: mockRateLimitCheck, clear: vi.fn() })),
}));
vi.mock("@/lib/security/rate-limit-audit", () => ({
  checkRateLimitOrFail: mockCheckRateLimitOrFail,
}));
vi.mock("@/lib/auth/policy/access-restriction", () => ({
  enforceAccessRestriction: mockEnforceAccessRestriction,
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  generateShareToken: vi.fn(() => "new-token-plain"),
  hashToken: vi.fn(() => "new-hash"),
}));

import { POST } from "@/app/api/extension/token/refresh/route";

const VALIDATED_TOKEN = {
  tokenId: "token-id-1",
  userId: "user-1",
  tenantId: "tenant-1",
  scopes: ["extension:read"],
  familyId: "family-1",
  familyCreatedAt: new Date(Date.now() - 60_000),
  expiresAt: new Date(Date.now() + 3_600_000),
  cnfJkt: VALID_CNF_JKT,
};

describe("POST /api/extension/token/refresh — cnfJkt preservation (C10)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimitOrFail.mockResolvedValue(null);
    mockEnforceAccessRestriction.mockResolvedValue(null);

    mockWithUserTenantRls.mockImplementation(
      (_userId: string, fn: () => unknown) => fn(),
    );
    mockWithBypassRls.mockImplementation(
      (_prisma: unknown, fn: (tx: unknown) => unknown) =>
        fn({ tenant: { findUnique: mockTenantFindUnique } }),
    );

    mockSessionFindFirst.mockResolvedValue({ id: "session-1", tenantId: "tenant-1" });
    mockTenantFindUnique.mockResolvedValue({
      extensionTokenIdleTimeoutMinutes: 60,
      extensionTokenAbsoluteTimeoutMinutes: 1440,
    });
  });

  it("carries cnfJkt forward to the rotated token row", async () => {
    mockValidateExtensionToken.mockResolvedValue({
      ok: true,
      data: VALIDATED_TOKEN,
    });

    const newToken = {
      expiresAt: new Date(Date.now() + 3_600_000),
      scope: "extension:read",
      cnfJkt: VALID_CNF_JKT,
    };

    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const txMock = {
        extensionToken: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          create: vi.fn().mockResolvedValue(newToken),
        },
      };
      return fn(txMock);
    });

    const req = createRequest(
      "POST",
      "http://localhost:3000/api/extension/token/refresh",
      { headers: { "authorization": "Bearer old-token", "dpop": "proof" } },
    );

    const res = await POST(req);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    // Response carries cnfJkt (C3b)
    expect(json.cnfJkt).toBe(VALID_CNF_JKT);

    // The tx.extensionToken.create must have been called with cnfJkt
    const createCalls = (mockTransaction.mock.calls[0][0] as (tx: {
      extensionToken: { updateMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
    }) => unknown);
    // Re-examine by inspecting the mock transaction's inner create call
    const txMock = {
      extensionToken: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockResolvedValue(newToken),
      },
    };
    await createCalls(txMock);
    expect(txMock.extensionToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cnfJkt: VALID_CNF_JKT }),
      }),
    );
  });

  it("returns 401 when validateExtensionToken fails (no DPoP)", async () => {
    mockValidateExtensionToken.mockResolvedValue({
      ok: false,
      error: "EXTENSION_TOKEN_DPOP_INVALID",
    });

    const req = createRequest(
      "POST",
      "http://localhost:3000/api/extension/token/refresh",
      { headers: { "authorization": "Bearer old-token" } },
    );

    const res = await POST(req);
    const { status } = await parseResponse(res);

    expect(status).toBe(401);
  });
});
