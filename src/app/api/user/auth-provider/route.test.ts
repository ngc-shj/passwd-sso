import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaAccount, mockWithBypassRls } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaAccount: { findMany: vi.fn() },
  mockWithBypassRls: vi.fn(
    async (_prisma: unknown, fn: () => unknown) => fn(),
  ),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { account: mockPrismaAccount },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

import { GET } from "./route";

describe("GET /api/user/auth-provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", "http://localhost/api/user/auth-provider"),
    );
    expect(res.status).toBe(401);
  });

  it("returns canPasskeySignIn: true for passkey-only user (no accounts)", async () => {
    mockPrismaAccount.findMany.mockResolvedValue([]);
    const res = await GET(
      createRequest("GET", "http://localhost/api/user/auth-provider"),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.canPasskeySignIn).toBe(true);
  });

  it("returns canPasskeySignIn: false for google-only user", async () => {
    mockPrismaAccount.findMany.mockResolvedValue([
      { provider: "google" },
    ]);
    const res = await GET(
      createRequest("GET", "http://localhost/api/user/auth-provider"),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.canPasskeySignIn).toBe(false);
  });

  it("returns canPasskeySignIn: false for saml-jackson-only user", async () => {
    mockPrismaAccount.findMany.mockResolvedValue([
      { provider: "saml-jackson" },
    ]);
    const res = await GET(
      createRequest("GET", "http://localhost/api/user/auth-provider"),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.canPasskeySignIn).toBe(false);
  });

  it("returns canPasskeySignIn: true for user with google + nodemailer", async () => {
    mockPrismaAccount.findMany.mockResolvedValue([
      { provider: "google" },
      { provider: "nodemailer" },
    ]);
    const res = await GET(
      createRequest("GET", "http://localhost/api/user/auth-provider"),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.canPasskeySignIn).toBe(true);
  });

  it("returns canPasskeySignIn: true for nodemailer-only user", async () => {
    mockPrismaAccount.findMany.mockResolvedValue([
      { provider: "nodemailer" },
    ]);
    const res = await GET(
      createRequest("GET", "http://localhost/api/user/auth-provider"),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.canPasskeySignIn).toBe(true);
  });

  it("returns 500 on DB error", async () => {
    mockPrismaAccount.findMany.mockRejectedValue(new Error("DB error"));
    const res = await GET(
      createRequest("GET", "http://localhost/api/user/auth-provider"),
    );
    expect(res.status).toBe(500);
  });

  it("uses withBypassRls with AUTH_FLOW purpose", async () => {
    mockPrismaAccount.findMany.mockResolvedValue([]);
    await GET(
      createRequest("GET", "http://localhost/api/user/auth-provider"),
    );
    expect(mockWithBypassRls).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      "auth_flow",
    );
  });
});
