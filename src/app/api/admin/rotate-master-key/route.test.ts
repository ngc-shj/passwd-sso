import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";

const V1_KEY = randomBytes(32).toString("hex");
const V2_KEY = randomBytes(32).toString("hex");
const ADMIN_TOKEN = randomBytes(32).toString("hex");

const {
  mockFindMany,
  mockUpdateMany,
  mockShareUpdateMany,
  mockUserFindUnique,
  mockCheck,
  mockLogAudit,
} = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockUpdateMany: vi.fn(),
  mockShareUpdateMany: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue(true),
  mockLogAudit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organization: { findMany: mockFindMany, updateMany: mockUpdateMany },
    passwordShare: { updateMany: mockShareUpdateMany },
    user: { findUnique: mockUserFindUnique },
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
}));

// Set up env before importing route
const savedEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    savedEnv[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

import { POST } from "./route";

function createRequest(
  body: unknown,
  token?: string
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": "10.0.0.1",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return new NextRequest("http://localhost/api/admin/rotate-master-key", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/rotate-master-key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue(true);

    setEnv({
      ORG_MASTER_KEY: V1_KEY,
      ORG_MASTER_KEY_V2: V2_KEY,
      ORG_MASTER_KEY_CURRENT_VERSION: "2",
      ADMIN_API_TOKEN: ADMIN_TOKEN,
    });
  });

  afterEach(() => {
    restoreEnv();
  });

  it("returns 401 without authorization header", async () => {
    const req = createRequest({ targetVersion: 2, operatorId: "user-1" });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid token", async () => {
    const req = createRequest(
      { targetVersion: 2, operatorId: "user-1" },
      "0".repeat(64)
    );
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockCheck.mockResolvedValue(false);
    const req = createRequest(
      { targetVersion: 2, operatorId: "user-1" },
      ADMIN_TOKEN
    );
    const res = await POST(req);
    expect(res.status).toBe(429);
  });

  it("returns 400 for invalid body", async () => {
    const req = createRequest({ targetVersion: "abc" }, ADMIN_TOKEN);
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when targetVersion does not match current", async () => {
    const req = createRequest(
      { targetVersion: 3, operatorId: "user-1" },
      ADMIN_TOKEN
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("does not match");
  });

  it("returns 400 when operatorId does not exist", async () => {
    mockUserFindUnique.mockResolvedValue(null);
    const req = createRequest(
      { targetVersion: 2, operatorId: "nonexistent" },
      ADMIN_TOKEN
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("operatorId");
  });

  it("rotates org keys successfully", async () => {
    mockUserFindUnique.mockResolvedValue({ id: "user-1" });

    // Use real crypto for this test
    const { generateOrgKey, wrapOrgKey } = await import(
      "@/lib/crypto-server"
    );

    // Simulate V1 wrapped org
    setEnv({ ORG_MASTER_KEY_CURRENT_VERSION: "1" });
    const orgKey = generateOrgKey();
    const wrappedV1 = wrapOrgKey(orgKey);
    setEnv({ ORG_MASTER_KEY_CURRENT_VERSION: "2" });

    mockFindMany.mockResolvedValue([
      {
        id: "org-1",
        encryptedOrgKey: wrappedV1.ciphertext,
        orgKeyIv: wrappedV1.iv,
        orgKeyAuthTag: wrappedV1.authTag,
        masterKeyVersion: 1,
      },
    ]);
    mockUpdateMany.mockResolvedValue({ count: 1 });

    const req = createRequest(
      { targetVersion: 2, operatorId: "user-1" },
      ADMIN_TOKEN
    );
    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.targetVersion).toBe(2);
    expect(body.total).toBe(1);
    expect(body.rotated).toBe(1);
    expect(body.errors).toHaveLength(0);

    // Verify updateMany was called with optimistic locking
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "org-1", masterKeyVersion: 1 },
        data: expect.objectContaining({
          masterKeyVersion: 2,
        }),
      })
    );

    // Verify audit log was called
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MASTER_KEY_ROTATION",
        userId: "user-1",
        metadata: expect.objectContaining({
          targetVersion: 2,
          rotated: 1,
        }),
      })
    );
  });

  it("returns 0 rotated when all orgs already at target version", async () => {
    mockUserFindUnique.mockResolvedValue({ id: "user-1" });
    mockFindMany.mockResolvedValue([]); // no orgs with old version

    const req = createRequest(
      { targetVersion: 2, operatorId: "user-1" },
      ADMIN_TOKEN
    );
    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.total).toBe(0);
    expect(body.rotated).toBe(0);
  });

  it("revokes old shares when revokeShares is true", async () => {
    mockUserFindUnique.mockResolvedValue({ id: "user-1" });
    mockFindMany.mockResolvedValue([]);
    mockShareUpdateMany.mockResolvedValue({ count: 3 });

    const req = createRequest(
      { targetVersion: 2, operatorId: "user-1", revokeShares: true },
      ADMIN_TOKEN
    );
    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.revokedShares).toBe(3);

    expect(mockShareUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          masterKeyVersion: { lt: 2 },
          revokedAt: null,
        }),
      })
    );
  });

  it("does not call shareUpdateMany when revokeShares is false", async () => {
    mockUserFindUnique.mockResolvedValue({ id: "user-1" });
    mockFindMany.mockResolvedValue([]);

    const req = createRequest(
      { targetVersion: 2, operatorId: "user-1", revokeShares: false },
      ADMIN_TOKEN
    );
    const res = await POST(req);
    expect(res.status).toBe(200);

    expect(mockShareUpdateMany).not.toHaveBeenCalled();
  });

  it("returns 401 with non-hex token", async () => {
    const req = createRequest(
      { targetVersion: 2, operatorId: "user-1" },
      "not-a-hex-token-at-all-should-fail-immediately!!"
    );
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 when ADMIN_API_TOKEN is not set", async () => {
    setEnv({ ADMIN_API_TOKEN: undefined });
    const req = createRequest(
      { targetVersion: 2, operatorId: "user-1" },
      ADMIN_TOKEN
    );
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("reports partial failure in errors array", async () => {
    mockUserFindUnique.mockResolvedValue({ id: "user-1" });

    const { generateOrgKey, wrapOrgKey } = await import(
      "@/lib/crypto-server"
    );

    // Create two V1-wrapped orgs
    setEnv({ ORG_MASTER_KEY_CURRENT_VERSION: "1" });
    const orgKey1 = generateOrgKey();
    const wrapped1 = wrapOrgKey(orgKey1);
    const orgKey2 = generateOrgKey();
    const wrapped2 = wrapOrgKey(orgKey2);
    setEnv({ ORG_MASTER_KEY_CURRENT_VERSION: "2" });

    mockFindMany.mockResolvedValue([
      {
        id: "org-ok",
        encryptedOrgKey: wrapped1.ciphertext,
        orgKeyIv: wrapped1.iv,
        orgKeyAuthTag: wrapped1.authTag,
        masterKeyVersion: 1,
      },
      {
        id: "org-corrupt",
        encryptedOrgKey: "invalid-ciphertext",
        orgKeyIv: wrapped2.iv,
        orgKeyAuthTag: wrapped2.authTag,
        masterKeyVersion: 1,
      },
    ]);
    mockUpdateMany.mockResolvedValue({ count: 1 });

    const req = createRequest(
      { targetVersion: 2, operatorId: "user-1" },
      ADMIN_TOKEN
    );
    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.rotated).toBe(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].orgId).toBe("org-corrupt");
  });

  it("does not revoke shares when all orgs fail rotation", async () => {
    mockUserFindUnique.mockResolvedValue({ id: "user-1" });
    mockFindMany.mockResolvedValue([
      {
        id: "org-fail",
        encryptedOrgKey: "bad-data",
        orgKeyIv: "bad-iv",
        orgKeyAuthTag: "bad-tag",
        masterKeyVersion: 1,
      },
    ]);

    const req = createRequest(
      { targetVersion: 2, operatorId: "user-1", revokeShares: true },
      ADMIN_TOKEN
    );
    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.errors).toHaveLength(1);
    expect(body.revokedShares).toBe(0);
    expect(mockShareUpdateMany).not.toHaveBeenCalled();
  });

  it("checks rate limit after auth (429 only for authenticated requests)", async () => {
    mockCheck.mockResolvedValue(false);
    // Unauthenticated request should get 401, not 429
    const unauthReq = createRequest(
      { targetVersion: 2, operatorId: "user-1" }
    );
    const unauthRes = await POST(unauthReq);
    expect(unauthRes.status).toBe(401);

    // Authenticated request should get 429
    const authReq = createRequest(
      { targetVersion: 2, operatorId: "user-1" },
      ADMIN_TOKEN
    );
    const authRes = await POST(authReq);
    expect(authRes.status).toBe(429);
  });
});
