import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { DPOP_VERIFY_ERROR } from "@/lib/auth/dpop/verify";

// ─── Hoisted mocks ───────────────────────────────────────────

const { mockVerifyDpop } = vi.hoisted(() => ({
  mockVerifyDpop: vi.fn(),
}));

const { mockExtUpdate } = vi.hoisted(() => ({
  mockExtUpdate: vi.fn().mockResolvedValue({}),
}));

const { mockWithBypassRls } = vi.hoisted(() => ({
  mockWithBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
}));

vi.mock("@/lib/auth/dpop/verify", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  verifyDpopProof: mockVerifyDpop,
}));

vi.mock("@/lib/auth/dpop/jti-cache", () => ({
  getJtiCache: vi.fn(() => ({ hasOrRecord: vi.fn().mockResolvedValue(false) })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    extensionToken: {
      update: mockExtUpdate,
    },
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  withBypassRls: mockWithBypassRls,
}));

// ─── Now import the module under test ────────────────────────

import { validateExtensionTokenDpop } from "./validate-token-dpop";

// ─── Shared test fixtures ────────────────────────────────────

const USER_ID = "00000000-0000-4000-8000-000000000001";
const TENANT_ID = "00000000-0000-4000-8000-000000000002";
const FAMILY_ID = "00000000-0000-4000-8000-000000000003";
const CNF_JKT = "A".repeat(43);
const ACCESS_TOKEN = "tok_" + "x".repeat(60);

const baseRow = {
  id: "row-1",
  userId: USER_ID,
  tenantId: TENANT_ID,
  cnfJkt: CNF_JKT,
  scope: "passwords:read,vault:unlock-data",
  expiresAt: new Date(Date.now() + 60_000),
  familyId: FAMILY_ID,
  familyCreatedAt: new Date(),
  clientKind: "BROWSER_EXTENSION" as const,
};

function makeBrowserReq() {
  return createRequest("GET", "https://app.example.com/api/passwords", {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      DPoP: "fake.dpop.proof",
    },
  });
}

function makeIosReq() {
  return createRequest("GET", "https://app.example.com/api/passwords", {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      DPoP: "fake.dpop.proof",
      "user-agent": "iOS-Test/1.0",
      "x-forwarded-for": "10.0.0.1",
    },
  });
}

// ─── Tests ───────────────────────────────────────────────────

describe("validateExtensionTokenDpop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExtUpdate.mockResolvedValue({});
    // canonicalHtu (called inside validateExtensionTokenDpop) reads APP_URL.
    vi.stubEnv("APP_URL", "https://app.example.com");
    vi.stubEnv("AUTH_URL", "");
  });

  describe("success path — BROWSER_EXTENSION", () => {
    it("returns ok with ValidatedExtensionToken including cnfJkt", async () => {
      mockVerifyDpop.mockResolvedValue({
        ok: true,
        claims: { jti: "j1", htm: "GET", htu: "x", iat: 1, cnf: { jkt: CNF_JKT } },
        jkt: CNF_JKT,
      });

      const result = await validateExtensionTokenDpop({
        req: makeBrowserReq(),
        row: baseRow,
        accessToken: ACCESS_TOKEN,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual({
          tokenId: "row-1",
          userId: USER_ID,
          tenantId: TENANT_ID,
          scopes: ["passwords:read", "vault:unlock-data"],
          expiresAt: baseRow.expiresAt,
          familyId: FAMILY_ID,
          familyCreatedAt: baseRow.familyCreatedAt,
          cnfJkt: CNF_JKT,
        });
      }
    });

    it("updates lastUsedAt but NOT lastUsedIp/UA for BROWSER_EXTENSION", async () => {
      mockVerifyDpop.mockResolvedValue({
        ok: true,
        claims: { jti: "j1", htm: "GET", htu: "x", iat: 1, cnf: { jkt: CNF_JKT } },
        jkt: CNF_JKT,
      });

      await validateExtensionTokenDpop({
        req: makeBrowserReq(),
        row: baseRow,
        accessToken: ACCESS_TOKEN,
      });

      // Allow the void promise to settle.
      await new Promise((r) => setTimeout(r, 10));

      expect(mockExtUpdate).toHaveBeenCalledTimes(1);
      const call = mockExtUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
      expect(call.data.lastUsedAt).toBeInstanceOf(Date);
      // IP and UA must NOT be updated for BROWSER_EXTENSION.
      expect(call.data).not.toHaveProperty("lastUsedIp");
      expect(call.data).not.toHaveProperty("lastUsedUserAgent");
    });
  });

  describe("success path — IOS_APP", () => {
    const iosRow = { ...baseRow, clientKind: "IOS_APP" as const };

    it("updates lastUsedIp and lastUsedUserAgent for IOS_APP", async () => {
      mockVerifyDpop.mockResolvedValue({
        ok: true,
        claims: { jti: "j1", htm: "GET", htu: "x", iat: 1, cnf: { jkt: CNF_JKT } },
        jkt: CNF_JKT,
      });

      await validateExtensionTokenDpop({
        req: makeIosReq(),
        row: iosRow,
        accessToken: ACCESS_TOKEN,
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(mockExtUpdate).toHaveBeenCalledTimes(1);
      const call = mockExtUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
      expect(call.data.lastUsedAt).toBeInstanceOf(Date);
      expect(call.data.lastUsedIp).toBe("10.0.0.1");
      expect(call.data.lastUsedUserAgent).toBe("iOS-Test/1.0");
    });
  });

  describe("failure paths — all 15 DPOP_VERIFY_ERROR codes", () => {
    it.each(Object.values(DPOP_VERIFY_ERROR))(
      "maps %s → EXTENSION_TOKEN_DPOP_INVALID with dpopError preserved",
      async (errCode) => {
        mockVerifyDpop.mockResolvedValue({ ok: false, error: errCode });

        const result = await validateExtensionTokenDpop({
          req: makeBrowserReq(),
          row: baseRow,
          accessToken: ACCESS_TOKEN,
        });

        expect(result).toEqual({
          ok: false,
          error: "EXTENSION_TOKEN_DPOP_INVALID",
          dpopError: errCode,
        });
        // No DB update on failure.
        await new Promise((r) => setTimeout(r, 10));
        expect(mockExtUpdate).not.toHaveBeenCalled();
      },
    );
  });
});
