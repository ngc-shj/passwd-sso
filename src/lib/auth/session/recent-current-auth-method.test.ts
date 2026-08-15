import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { MS_PER_MINUTE } from "@/lib/constants/time";

const { mockSessionFindUnique, mockCredentialFindFirst, mockWithBypassRls } =
  vi.hoisted(() => ({
    mockSessionFindUnique: vi.fn(),
    mockCredentialFindFirst: vi.fn(),
    mockWithBypassRls: vi.fn(),
  }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    session: {
      findUnique: mockSessionFindUnique,
    },
    webAuthnCredential: {
      findFirst: mockCredentialFindFirst,
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
      authCredentialId: "cred-row-1",
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
      authCredentialId: "cred-row-1",
    });

    await expect(evaluateStepUpFreshness("sess-1")).resolves.toBe("stale");
  });

  it("maps webauthn with NULL passkeyVerifiedAt to stale, not invalid", async () => {
    mockSessionFindUnique.mockResolvedValue({
      provider: "webauthn",
      createdAt: minutesAgo(5),
      passkeyVerifiedAt: null,
      authCredentialId: "cred-row-1",
    });

    await expect(evaluateStepUpFreshness("sess-1")).resolves.toBe("stale");
  });

  it("C5 member 0: maps webauthn with NULL authCredentialId to stale, even with a fresh timestamp", async () => {
    mockSessionFindUnique.mockResolvedValue({
      provider: "webauthn",
      createdAt: minutesAgo(120),
      passkeyVerifiedAt: minutesAgo(5),
      authCredentialId: null,
    });

    // The criterion the previous revision could not fail (finding M4):
    // nulling ONLY the binding on an otherwise-fresh row must flip the verdict.
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
      authCredentialId: "cred-row-1",
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
      authCredentialId: "cred-row-1",
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
  it("returns true for a webauthn session whose bound credential row still exists", async () => {
    mockSessionFindUnique.mockResolvedValue({
      provider: "webauthn",
      userId: "user-1",
      authCredentialId: "cred-row-1",
    });
    mockCredentialFindFirst.mockResolvedValue({ id: "cred-row-1" });

    await expect(
      canRecoverSessionWithPasskey("sess-1", "user-1"),
    ).resolves.toBe(true);
    expect(mockCredentialFindFirst).toHaveBeenCalledWith({
      where: { id: "cred-row-1", userId: "user-1" },
      select: { id: true },
    });
  });

  // C5 member 1: "the account has some credential" is the wrong question —
  // the bound row specifically must still exist, even if the user has other
  // registered credentials.
  it("returns false when the bound credential row was deleted", async () => {
    mockSessionFindUnique.mockResolvedValue({
      provider: "webauthn",
      userId: "user-1",
      authCredentialId: "cred-row-deleted",
    });
    mockCredentialFindFirst.mockResolvedValue(null);

    await expect(
      canRecoverSessionWithPasskey("sess-1", "user-1"),
    ).resolves.toBe(false);
  });

  it("returns false for an unbound webauthn session without querying credentials", async () => {
    mockSessionFindUnique.mockResolvedValue({
      provider: "webauthn",
      userId: "user-1",
      authCredentialId: null,
    });

    await expect(
      canRecoverSessionWithPasskey("sess-1", "user-1"),
    ).resolves.toBe(false);
    expect(mockCredentialFindFirst).not.toHaveBeenCalled();
  });

  it("returns false when the session row belongs to a different user (parameter binding)", async () => {
    mockSessionFindUnique.mockResolvedValue({
      provider: "webauthn",
      userId: "someone-else",
      authCredentialId: "cred-row-1",
    });

    await expect(
      canRecoverSessionWithPasskey("sess-1", "user-1"),
    ).resolves.toBe(false);
    expect(mockCredentialFindFirst).not.toHaveBeenCalled();
  });

  it("returns false for a non-webauthn session without querying credentials", async () => {
    mockSessionFindUnique.mockResolvedValue({
      provider: "google",
      userId: "user-1",
      authCredentialId: null,
    });

    await expect(
      canRecoverSessionWithPasskey("sess-1", "user-1"),
    ).resolves.toBe(false);
    expect(mockCredentialFindFirst).not.toHaveBeenCalled();
  });

  it("returns false when the session row is missing", async () => {
    mockSessionFindUnique.mockResolvedValue(null);

    await expect(
      canRecoverSessionWithPasskey("sess-1", "user-1"),
    ).resolves.toBe(false);
  });
});
