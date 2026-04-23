import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaUser,
  mockCheckLockout,
  mockRecordFailure,
  mockLogAudit,
  mockVerifyPassphraseVerifier,
  mockWithUserTenantRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaUser: { findUnique: vi.fn(), update: vi.fn() },
  mockCheckLockout: vi.fn(),
  mockRecordFailure: vi.fn(),
  mockLogAudit: vi.fn(),
  mockVerifyPassphraseVerifier: vi.fn((client: string, stored: string) => client === stored),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: mockPrismaUser },
}));
vi.mock("@/lib/auth/account-lockout", () => ({
  checkLockout: mockCheckLockout,
  recordFailure: mockRecordFailure,
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));
vi.mock("@/lib/crypto-server", () => ({
  verifyPassphraseVerifier: mockVerifyPassphraseVerifier,
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (fn: (...args: unknown[]) => unknown) => fn,
}));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET } from "./route";
import { POST as EnablePOST } from "./enable/route";
import { POST as DisablePOST } from "./disable/route";

const VALID_VERIFIER_HASH = "a".repeat(64);

// ────────────────────────────────────────────────────────────────
// GET /api/travel-mode
// ────────────────────────────────────────────────────────────────
describe("GET /api/travel-mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(createRequest("GET", "http://localhost:3000/api/travel-mode"));
    expect(res.status).toBe(401);
  });

  it("returns travel mode status (active: false)", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      travelModeActive: false,
      travelModeActivatedAt: null,
    });

    const res = await GET(createRequest("GET", "http://localhost:3000/api/travel-mode"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.active).toBe(false);
    expect(json.activatedAt).toBeNull();
  });

  it("returns travel mode status (active: true with activatedAt)", async () => {
    const activatedAt = new Date("2025-06-01T12:00:00Z");
    mockPrismaUser.findUnique.mockResolvedValue({
      travelModeActive: true,
      travelModeActivatedAt: activatedAt,
    });

    const res = await GET(createRequest("GET", "http://localhost:3000/api/travel-mode"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.active).toBe(true);
    expect(json.activatedAt).toBe(activatedAt.toISOString());
  });

  it("returns 404 when user not found", async () => {
    mockPrismaUser.findUnique.mockResolvedValue(null);

    const res = await GET(createRequest("GET", "http://localhost:3000/api/travel-mode"));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe("USER_NOT_FOUND");
  });
});

// ────────────────────────────────────────────────────────────────
// POST /api/travel-mode/enable
// ────────────────────────────────────────────────────────────────
describe("POST /api/travel-mode/enable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockPrismaUser.update.mockResolvedValue({});
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await EnablePOST(
      createRequest("POST", "http://localhost:3000/api/travel-mode/enable"),
    );
    expect(res.status).toBe(401);
  });

  it("enables travel mode and returns { active: true }", async () => {
    const res = await EnablePOST(
      createRequest("POST", "http://localhost:3000/api/travel-mode/enable"),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.active).toBe(true);
  });

  it("calls prisma.user.update with correct data", async () => {
    await EnablePOST(
      createRequest("POST", "http://localhost:3000/api/travel-mode/enable"),
    );

    expect(mockPrismaUser.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-1" },
        data: expect.objectContaining({
          travelModeActive: true,
          travelModeActivatedAt: expect.any(Date),
        }),
      }),
    );
  });

  it("calls logAuditAsync after enabling travel mode", async () => {
    await EnablePOST(
      createRequest("POST", "http://localhost:3000/api/travel-mode/enable"),
    );

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TRAVEL_MODE_ENABLE",
        userId: "user-1",
      }),
    );
  });
});

// ────────────────────────────────────────────────────────────────
// POST /api/travel-mode/disable
// ────────────────────────────────────────────────────────────────
describe("POST /api/travel-mode/disable", () => {
  const makeDisableRequest = (body: unknown = { verifierHash: VALID_VERIFIER_HASH }) =>
    createRequest("POST", "http://localhost:3000/api/travel-mode/disable", { body });

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockCheckLockout.mockResolvedValue({ locked: false, lockedUntil: null });
    mockRecordFailure.mockResolvedValue({ locked: false, lockedUntil: null, attempts: 1 });
    mockPrismaUser.findUnique.mockResolvedValue({
      passphraseVerifierHmac: VALID_VERIFIER_HASH,
      travelModeActive: true,
    });
    mockPrismaUser.update.mockResolvedValue({});
    // By default verifier matches: client === stored
    mockVerifyPassphraseVerifier.mockImplementation(
      (client: string, stored: string) => client === stored,
    );
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DisablePOST(makeDisableRequest());
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid JSON", async () => {
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost:3000/api/travel-mode/disable", {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await DisablePOST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 for invalid verifierHash format", async () => {
    const res = await DisablePOST(makeDisableRequest({ verifierHash: "short" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBeDefined();
  });

  it("returns 403 when account is locked", async () => {
    const lockedUntil = new Date(Date.now() + 60_000);
    mockCheckLockout.mockResolvedValue({ locked: true, lockedUntil });

    const res = await DisablePOST(makeDisableRequest());
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error).toBe("ACCOUNT_LOCKED");
    expect(json.lockedUntil).toBe(lockedUntil.toISOString());
  });

  it("returns 400 when vault not setup (no verifier)", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      passphraseVerifierHmac: null,
      travelModeActive: true,
    });

    const res = await DisablePOST(makeDisableRequest());
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("VAULT_NOT_SETUP");
  });

  it("returns 401 for wrong passphrase", async () => {
    mockVerifyPassphraseVerifier.mockReturnValue(false);

    const res = await DisablePOST(makeDisableRequest({ verifierHash: "b".repeat(64) }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe("INVALID_PASSPHRASE");
  });

  it("returns { active: false } when already not in travel mode (no-op)", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      passphraseVerifierHmac: VALID_VERIFIER_HASH,
      travelModeActive: false,
    });

    const res = await DisablePOST(makeDisableRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.active).toBe(false);
    // Should not call update when travel mode is already off
    expect(mockPrismaUser.update).not.toHaveBeenCalled();
  });

  it("disables travel mode on correct passphrase", async () => {
    const res = await DisablePOST(makeDisableRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.active).toBe(false);
    expect(mockPrismaUser.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-1" },
        data: expect.objectContaining({
          travelModeActive: false,
          travelModeActivatedAt: null,
        }),
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TRAVEL_MODE_DISABLE",
        userId: "user-1",
      }),
    );
  });

  it("records failure on wrong passphrase", async () => {
    mockVerifyPassphraseVerifier.mockReturnValue(false);

    await DisablePOST(makeDisableRequest({ verifierHash: "f".repeat(64) }));

    expect(mockRecordFailure).toHaveBeenCalledWith("user-1", expect.anything());
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TRAVEL_MODE_DISABLE_FAILED",
        userId: "user-1",
      }),
    );
  });
});
