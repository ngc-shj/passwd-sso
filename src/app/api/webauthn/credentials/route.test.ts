import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

// ── Hoisted mocks ────────────────────────────────────────────

const {
  mockAuth,
  mockPrismaFindMany,
  mockWithUserTenantRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaFindMany: vi.fn(),
  mockWithUserTenantRls: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    webAuthnCredential: { findMany: mockPrismaFindMany },
  },
}));

vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));

vi.mock("@/lib/api-error-codes", () => ({
  API_ERROR: { UNAUTHORIZED: "UNAUTHORIZED" },
}));

vi.mock("@/lib/with-request-log", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRequestLog: (fn: any) => fn,
}));

import { GET } from "./route";

// ── Test data ────────────────────────────────────────────────

const ROUTE_URL = "http://localhost:3000/api/webauthn/credentials";

const mockCredentials = [
  {
    id: "cred-1",
    credentialId: "cred-id-1",
    nickname: "MacBook Pro",
    deviceType: "multiDevice",
    backedUp: true,
    discoverable: true,
    transports: ["internal", "hybrid"],
    prfSupported: true,
    registeredDevice: "Chrome on macOS",
    lastUsedDevice: null,
    createdAt: new Date("2026-03-15T00:00:00Z"),
    lastUsedAt: null,
  },
  {
    id: "cred-2",
    credentialId: "cred-id-2",
    nickname: "YubiKey",
    deviceType: "singleDevice",
    backedUp: false,
    discoverable: null,
    transports: ["usb"],
    prfSupported: false,
    registeredDevice: null,
    lastUsedDevice: null,
    createdAt: new Date("2026-03-14T00:00:00Z"),
    lastUsedAt: null,
  },
];

// ── Setup ────────────────────────────────────────────────────

describe("GET /api/webauthn/credentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockPrismaFindMany.mockResolvedValue(mockCredentials);
    mockWithUserTenantRls.mockImplementation(
      (_userId: string, fn: () => unknown) => fn(),
    );
  });

  it("returns credentials with discoverable field", async () => {
    const req = createRequest("GET", ROUTE_URL);
    const { status, json } = await parseResponse(await GET(req));

    expect(status).toBe(200);
    expect(json).toHaveLength(2);

    // First credential: discoverable = true
    expect(json[0]).toHaveProperty("discoverable", true);

    // Second credential: discoverable = null (legacy, no credProps)
    expect(json[1]).toHaveProperty("discoverable", null);
  });

  it("queries Prisma with discoverable in select", async () => {
    const req = createRequest("GET", ROUTE_URL);
    await GET(req);

    expect(mockPrismaFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ discoverable: true }),
      }),
    );
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("GET", ROUTE_URL);
    const { status, json } = await parseResponse(await GET(req));

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 200 with empty array when no credentials exist", async () => {
    mockPrismaFindMany.mockResolvedValue([]);

    const req = createRequest("GET", ROUTE_URL);
    const { status, json } = await parseResponse(await GET(req));

    expect(status).toBe(200);
    expect(json).toEqual([]);
  });
});
