import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { MS_PER_MINUTE } from "@/lib/constants/time";

const { mockSessionFindUnique, mockCredentialCount, mockWithBypassRls } =
  vi.hoisted(() => ({
    mockSessionFindUnique: vi.fn(),
    mockCredentialCount: vi.fn(),
    mockWithBypassRls: vi.fn(),
  }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    session: {
      findUnique: mockSessionFindUnique,
    },
    webAuthnCredential: {
      count: mockCredentialCount,
    },
  },
}));

vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  withBypassRls: mockWithBypassRls,
}));

import {
  evaluateStepUpFreshness,
  requireRecentCurrentAuthMethod,
  canRecoverSessionWithPasskey,
} from "./recent-current-auth-method";

function makeRequest(cookie = "authjs.session-token=sess-1") {
  return new NextRequest("http://localhost:3000/api/test", {
    headers: { cookie },
  });
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * MS_PER_MINUTE);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWithBypassRls.mockImplementation(
    (prisma: unknown, fn: (tx: unknown) => unknown, _purpose: string) =>
      fn(prisma),
  );
});

describe("evaluateStepUpFreshness", () => {
  it("returns invalid when the session row is missing", async () => {
    mockSessionFindUnique.mockResolvedValue(null);

    await expect(evaluateStepUpFreshness("sess-1")).resolves.toBe("invalid");
  });

  it("judges webauthn sessions on passkeyVerifiedAt: fresh within the window", async () => {
    mockSessionFindUnique.mockResolvedValue({
      provider: "webauthn",
      createdAt: minutesAgo(120),
      passkeyVerifiedAt: minutesAgo(5),
    });

    // Load-bearing security case: fresh passkeyVerifiedAt + OLD createdAt is
    // fresh — the ceremony (not session age) carries the freshness evidence.
    await expect(evaluateStepUpFreshness("sess-1")).resolves.toBe("fresh");
  });

  it("judges webauthn sessions on passkeyVerifiedAt: stale past the window", async () => {
    mockSessionFindUnique.mockResolvedValue({
      provider: "webauthn",
      createdAt: minutesAgo(5),
      passkeyVerifiedAt: minutesAgo(20),
    });

    await expect(evaluateStepUpFreshness("sess-1")).resolves.toBe("stale");
  });

  it("maps webauthn with NULL passkeyVerifiedAt to stale, not invalid", async () => {
    mockSessionFindUnique.mockResolvedValue({
      provider: "webauthn",
      createdAt: minutesAgo(5),
      passkeyVerifiedAt: null,
    });

    await expect(evaluateStepUpFreshness("sess-1")).resolves.toBe("stale");
  });

  it("judges non-webauthn sessions on createdAt: fresh within the window", async () => {
    mockSessionFindUnique.mockResolvedValue({
      provider: "google",
      createdAt: minutesAgo(5),
      passkeyVerifiedAt: null,
    });

    await expect(evaluateStepUpFreshness("sess-1")).resolves.toBe("fresh");
  });

  it("judges non-webauthn sessions on createdAt: stale past the window", async () => {
    mockSessionFindUnique.mockResolvedValue({
      provider: "google",
      createdAt: minutesAgo(20),
      passkeyVerifiedAt: null,
    });

    await expect(evaluateStepUpFreshness("sess-1")).resolves.toBe("stale");
  });

  it("treats provider null (pre-provenance session) like the createdAt branch", async () => {
    mockSessionFindUnique.mockResolvedValue({
      provider: null,
      createdAt: minutesAgo(20),
      passkeyVerifiedAt: null,
    });

    await expect(evaluateStepUpFreshness("sess-1")).resolves.toBe("stale");
  });

  it("honors a custom maxAgeMs on the createdAt branch", async () => {
    mockSessionFindUnique.mockResolvedValue({
      provider: "google",
      createdAt: minutesAgo(20),
      passkeyVerifiedAt: null,
    });

    await expect(
      evaluateStepUpFreshness("sess-1", { maxAgeMs: 30 * MS_PER_MINUTE }),
    ).resolves.toBe("fresh");
  });

  it("honors a custom maxAgeMs on the passkeyVerifiedAt branch", async () => {
    mockSessionFindUnique.mockResolvedValue({
      provider: "webauthn",
      createdAt: minutesAgo(120),
      passkeyVerifiedAt: minutesAgo(20),
    });

    await expect(
      evaluateStepUpFreshness("sess-1", { maxAgeMs: 30 * MS_PER_MINUTE }),
    ).resolves.toBe("fresh");
  });
});

describe("requireRecentCurrentAuthMethod", () => {
  it("returns 401 when the request has no session cookie", async () => {
    const result = await requireRecentCurrentAuthMethod(makeRequest(""));

    expect(result?.status).toBe(401);
    expect(mockSessionFindUnique).not.toHaveBeenCalled();
  });

  it("returns 401 when the cookie is valid but the session row is missing (DB miss)", async () => {
    mockSessionFindUnique.mockResolvedValue(null);

    const result = await requireRecentCurrentAuthMethod(makeRequest());

    expect(result?.status).toBe(401);
  });

  it("returns null for a fresh session", async () => {
    mockSessionFindUnique.mockResolvedValue({
      provider: "google",
      createdAt: minutesAgo(5),
      passkeyVerifiedAt: null,
    });

    await expect(
      requireRecentCurrentAuthMethod(makeRequest()),
    ).resolves.toBeNull();
  });

  it("returns 403 SESSION_STEP_UP_REQUIRED for a stale session by default", async () => {
    mockSessionFindUnique.mockResolvedValue({
      provider: "google",
      createdAt: minutesAgo(20),
      passkeyVerifiedAt: null,
    });

    const result = await requireRecentCurrentAuthMethod(makeRequest());

    expect(result?.status).toBe(403);
    const body = (await result?.json()) as { error: string };
    expect(body.error).toBe(API_ERROR.SESSION_STEP_UP_REQUIRED);
  });

  it("preserves a caller-supplied errorCode on the stale 403 (operator-tokens contract)", async () => {
    mockSessionFindUnique.mockResolvedValue({
      provider: "webauthn",
      createdAt: minutesAgo(5),
      passkeyVerifiedAt: minutesAgo(20),
    });

    const result = await requireRecentCurrentAuthMethod(makeRequest(), {
      errorCode: API_ERROR.OPERATOR_TOKEN_STALE_SESSION,
    });

    expect(result?.status).toBe(403);
    const body = (await result?.json()) as { error: string };
    expect(body.error).toBe(API_ERROR.OPERATOR_TOKEN_STALE_SESSION);
  });
});

describe("canRecoverSessionWithPasskey", () => {
  it("returns true for a webauthn session with at least one credential", async () => {
    mockSessionFindUnique.mockResolvedValue({ provider: "webauthn" });
    mockCredentialCount.mockResolvedValue(2);

    await expect(
      canRecoverSessionWithPasskey("sess-1", "user-1"),
    ).resolves.toBe(true);
  });

  it("returns false for a webauthn session whose credentials were all deleted", async () => {
    mockSessionFindUnique.mockResolvedValue({ provider: "webauthn" });
    mockCredentialCount.mockResolvedValue(0);

    await expect(
      canRecoverSessionWithPasskey("sess-1", "user-1"),
    ).resolves.toBe(false);
  });

  it("returns false for a non-webauthn session without counting credentials", async () => {
    mockSessionFindUnique.mockResolvedValue({ provider: "google" });

    await expect(
      canRecoverSessionWithPasskey("sess-1", "user-1"),
    ).resolves.toBe(false);
    expect(mockCredentialCount).not.toHaveBeenCalled();
  });

  it("returns false when the session row is missing", async () => {
    mockSessionFindUnique.mockResolvedValue(null);

    await expect(
      canRecoverSessionWithPasskey("sess-1", "user-1"),
    ).resolves.toBe(false);
  });
});
