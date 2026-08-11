import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaAccount, mockWithBypassRls, mockCanRecoverSessionWithPasskey } =
  vi.hoisted(() => ({
    mockAuth: vi.fn(),
    mockPrismaAccount: { findMany: vi.fn() },
    mockWithBypassRls: vi.fn(
      async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma),
    ),
    mockCanRecoverSessionWithPasskey: vi.fn(),
  }));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { account: mockPrismaAccount },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  canRecoverSessionWithPasskey: mockCanRecoverSessionWithPasskey,
}));

import { GET } from "./route";

const ROUTE_URL = "http://localhost:3000/api/user/auth-provider";

function makeRequest(cookie = "authjs.session-token=sess-1") {
  return createRequest("GET", ROUTE_URL, { headers: { cookie } });
}

describe("GET /api/user/auth-provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockCanRecoverSessionWithPasskey.mockResolvedValue(false);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it("returns canPasskeySignIn: true for passkey-only user (no accounts)", async () => {
    mockPrismaAccount.findMany.mockResolvedValue([]);
    const res = await GET(makeRequest());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.canPasskeySignIn).toBe(true);
  });

  it("returns canPasskeySignIn: false for google-only user", async () => {
    mockPrismaAccount.findMany.mockResolvedValue([
      { provider: "google" },
    ]);
    const res = await GET(makeRequest());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.canPasskeySignIn).toBe(false);
  });

  it("returns canPasskeySignIn: false for saml-jackson-only user", async () => {
    mockPrismaAccount.findMany.mockResolvedValue([
      { provider: "saml-jackson" },
    ]);
    const res = await GET(makeRequest());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.canPasskeySignIn).toBe(false);
  });

  it("returns canPasskeySignIn: true for user with google + nodemailer", async () => {
    mockPrismaAccount.findMany.mockResolvedValue([
      { provider: "google" },
      { provider: "nodemailer" },
    ]);
    const res = await GET(makeRequest());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.canPasskeySignIn).toBe(true);
  });

  it("returns canPasskeySignIn: true for nodemailer-only user", async () => {
    mockPrismaAccount.findMany.mockResolvedValue([
      { provider: "nodemailer" },
    ]);
    const res = await GET(makeRequest());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.canPasskeySignIn).toBe(true);
  });

  it("returns 500 on DB error", async () => {
    mockPrismaAccount.findMany.mockRejectedValue(new Error("DB error"));
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
  });

  it("uses withBypassRls with AUTH_FLOW purpose", async () => {
    mockPrismaAccount.findMany.mockResolvedValue([]);
    await GET(makeRequest());
    expect(mockWithBypassRls).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      "auth_flow",
    );
  });

  // C5 member 2: canPasskeyReauth answers for THIS request's own session,
  // computed from the same predicate C5 member 1 exposes.
  describe("canPasskeyReauth", () => {
    it("returns true when the requesting session can recover via passkey", async () => {
      mockPrismaAccount.findMany.mockResolvedValue([]);
      mockCanRecoverSessionWithPasskey.mockResolvedValue(true);

      const res = await GET(makeRequest("authjs.session-token=sess-bound"));

      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.canPasskeyReauth).toBe(true);
      expect(mockCanRecoverSessionWithPasskey).toHaveBeenCalledWith(
        "sess-bound",
        "user-1",
      );
    });

    it("returns false when the requesting session's binding cannot recover", async () => {
      mockPrismaAccount.findMany.mockResolvedValue([]);
      mockCanRecoverSessionWithPasskey.mockResolvedValue(false);

      const res = await GET(makeRequest("authjs.session-token=sess-unbound"));

      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.canPasskeyReauth).toBe(false);
    });

    it("returns false without consulting the predicate when no session cookie is present", async () => {
      mockPrismaAccount.findMany.mockResolvedValue([]);

      const res = await GET(makeRequest(""));

      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.canPasskeyReauth).toBe(false);
      expect(mockCanRecoverSessionWithPasskey).not.toHaveBeenCalled();
    });
  });
});
