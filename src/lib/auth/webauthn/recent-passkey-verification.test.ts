import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockSessionFindUnique,
  mockSessionUpdate,
  mockWithBypassRls,
} = vi.hoisted(() => ({
  mockSessionFindUnique: vi.fn(),
  mockSessionUpdate: vi.fn(),
  mockWithBypassRls: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    session: {
      findUnique: mockSessionFindUnique,
      update: mockSessionUpdate,
    },
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: mockWithBypassRls,
}));

import {
  markCurrentSessionPasskeyVerified,
  PASSKEY_VERIFICATION_WINDOW_MS,
  requireRecentPasskeyVerification,
} from "./recent-passkey-verification";

function makeRequest(cookie = "authjs.session-token=sess-1") {
  return new NextRequest("http://localhost:3000/api/test", {
    headers: { cookie },
  });
}

describe("requireRecentPasskeyVerification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithBypassRls.mockImplementation(
      (_prisma: unknown, fn: () => unknown, _purpose: string) => fn(),
    );
  });

  it("returns null when passkey freshness is still within the window", async () => {
    mockSessionFindUnique.mockResolvedValue({
      passkeyVerifiedAt: new Date(
        Date.now() - PASSKEY_VERIFICATION_WINDOW_MS + 30_000,
      ),
    });

    const result = await requireRecentPasskeyVerification(makeRequest());
    expect(result).toBeNull();
  });

  it("returns 403 when no passkey verification is recorded", async () => {
    mockSessionFindUnique.mockResolvedValue({
      passkeyVerifiedAt: null,
    });

    const result = await requireRecentPasskeyVerification(makeRequest());
    expect(result?.status).toBe(403);
    await expect(result?.json()).resolves.toEqual({
      error: "SESSION_STEP_UP_REQUIRED",
    });
  });

  it("returns 403 when passkey freshness is stale", async () => {
    mockSessionFindUnique.mockResolvedValue({
      passkeyVerifiedAt: new Date(
        Date.now() - PASSKEY_VERIFICATION_WINDOW_MS - 30_000,
      ),
    });

    const result = await requireRecentPasskeyVerification(makeRequest());
    expect(result?.status).toBe(403);
    await expect(result?.json()).resolves.toEqual({
      error: "SESSION_STEP_UP_REQUIRED",
    });
  });

  it("returns 401 when the session row does not exist", async () => {
    mockSessionFindUnique.mockResolvedValue(null);

    const result = await requireRecentPasskeyVerification(makeRequest());
    expect(result?.status).toBe(401);
  });
});

describe("markCurrentSessionPasskeyVerified", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithBypassRls.mockImplementation(
      (_prisma: unknown, fn: () => unknown, _purpose: string) => fn(),
    );
  });

  it("updates passkeyVerifiedAt on the current session row", async () => {
    const verifiedAt = new Date("2026-05-07T00:00:00Z");
    mockSessionUpdate.mockResolvedValue({});

    await markCurrentSessionPasskeyVerified("sess-1", verifiedAt);

    expect(mockSessionUpdate).toHaveBeenCalledWith({
      where: { sessionToken: "sess-1" },
      data: { passkeyVerifiedAt: verifiedAt },
    });
  });
});
