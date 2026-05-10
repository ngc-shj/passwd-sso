import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockSessionFindUnique,
  mockWithBypassRls,
  mockRequireRecentPasskeyVerification,
  mockRequireRecentSession,
} = vi.hoisted(() => ({
  mockSessionFindUnique: vi.fn(),
  mockWithBypassRls: vi.fn(),
  mockRequireRecentPasskeyVerification: vi.fn(),
  mockRequireRecentSession: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    session: {
      findUnique: mockSessionFindUnique,
    },
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

vi.mock("@/lib/auth/webauthn/recent-passkey-verification", () => ({
  requireRecentPasskeyVerification: mockRequireRecentPasskeyVerification,
}));

vi.mock("./step-up", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  requireRecentSession: mockRequireRecentSession,
}));

import { requireRecentCurrentAuthMethod } from "./recent-current-auth-method";

function makeRequest(cookie = "authjs.session-token=sess-1") {
  return new NextRequest("http://localhost:3000/api/test", {
    headers: { cookie },
  });
}

describe("requireRecentCurrentAuthMethod", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithBypassRls.mockImplementation(
      (_prisma: unknown, fn: () => unknown, _purpose: string) => fn(),
    );
    mockRequireRecentPasskeyVerification.mockResolvedValue(null);
    mockRequireRecentSession.mockResolvedValue(null);
  });

  it("delegates to recent passkey verification for webauthn sessions", async () => {
    mockSessionFindUnique.mockResolvedValue({ provider: "webauthn" });

    const result = await requireRecentCurrentAuthMethod(makeRequest());

    expect(result).toBeNull();
    expect(mockRequireRecentPasskeyVerification).toHaveBeenCalledWith(
      expect.any(NextRequest),
      {},
    );
  });

  it("falls back to recent session for non-webauthn sessions", async () => {
    mockSessionFindUnique.mockResolvedValue({ provider: "google" });

    const result = await requireRecentCurrentAuthMethod(makeRequest());

    expect(result).toBeNull();
    expect(mockRequireRecentSession).toHaveBeenCalledWith(
      expect.any(NextRequest),
      {},
    );
  });

  it("returns 401 when the request has no session cookie", async () => {
    const result = await requireRecentCurrentAuthMethod(makeRequest(""));
    expect(result?.status).toBe(401);
  });

  it("returns 401 when the cookie is valid but the session row is missing (DB miss)", async () => {
    mockSessionFindUnique.mockResolvedValue(null);

    const result = await requireRecentCurrentAuthMethod(makeRequest());

    expect(result?.status).toBe(401);
    expect(mockRequireRecentPasskeyVerification).not.toHaveBeenCalled();
    expect(mockRequireRecentSession).not.toHaveBeenCalled();
  });

  it("falls back to recent session when provider is null (pre-provenance-migration session)", async () => {
    mockSessionFindUnique.mockResolvedValue({ provider: null });

    const result = await requireRecentCurrentAuthMethod(makeRequest());

    expect(result).toBeNull();
    expect(mockRequireRecentSession).toHaveBeenCalledWith(
      expect.any(NextRequest),
      {},
    );
    expect(mockRequireRecentPasskeyVerification).not.toHaveBeenCalled();
  });
});
