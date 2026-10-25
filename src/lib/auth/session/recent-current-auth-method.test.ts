import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { hashSessionToken } from "./session-cache";

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
import { TEST_SESSION_TOKEN } from "@/__tests__/helpers/fixtures";

// The user the route's auth() resolved.
const USER_ID = "user-1";

function makeRequest(cookie = `authjs.session-token=${TEST_SESSION_TOKEN}`) {
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

    await expect(evaluateStepUpFreshness("sess-1", USER_ID)).resolves.toBe("invalid");
  });

  // The row must belong to the user auth() resolved. Each cell differs from
  // its "fresh" counterpart below only in the owner.
  it.each([
    ["a fresh createdAt row", { provider: "google", createdAt: minutesAgo(5), passkeyVerifiedAt: null }],
    [
      "a freshly verified webauthn row",
      { provider: "webauthn", createdAt: minutesAgo(120), passkeyVerifiedAt: minutesAgo(5), authCredentialId: "cred-row-1" },
    ],
  ])("returns invalid for %s owned by another user", async (_label, row) => {
    mockSessionFindUnique.mockResolvedValue({ userId: "someone-else", ...row });

    await expect(evaluateStepUpFreshness("sess-1", USER_ID)).resolves.toBe("invalid");
    expect(mockSessionFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ userId: true }) }),
    );
  });

  it("judges webauthn sessions on passkeyVerifiedAt: fresh within the window", async () => {
    mockSessionFindUnique.mockResolvedValue({
      userId: USER_ID,
      provider: "webauthn",
      createdAt: minutesAgo(120),
      passkeyVerifiedAt: minutesAgo(5),
      authCredentialId: "cred-row-1",
    });

    // Load-bearing security case: fresh passkeyVerifiedAt + OLD createdAt is
    // fresh — the ceremony (not session age) carries the freshness evidence.
    await expect(evaluateStepUpFreshness("sess-1", USER_ID)).resolves.toBe("fresh");
  });

  it("judges webauthn sessions on passkeyVerifiedAt: stale past the window", async () => {
    mockSessionFindUnique.mockResolvedValue({
      userId: USER_ID,
      provider: "webauthn",
      createdAt: minutesAgo(5),
      passkeyVerifiedAt: minutesAgo(20),
      authCredentialId: "cred-row-1",
    });

    await expect(evaluateStepUpFreshness("sess-1", USER_ID)).resolves.toBe("stale");
  });

  it("maps webauthn with NULL passkeyVerifiedAt to stale, not invalid", async () => {
    mockSessionFindUnique.mockResolvedValue({
      userId: USER_ID,
      provider: "webauthn",
      createdAt: minutesAgo(5),
      passkeyVerifiedAt: null,
      authCredentialId: "cred-row-1",
    });

    await expect(evaluateStepUpFreshness("sess-1", USER_ID)).resolves.toBe("stale");
  });

  it("C5 member 0: maps webauthn with NULL authCredentialId to stale, even with a fresh timestamp", async () => {
    mockSessionFindUnique.mockResolvedValue({
      userId: USER_ID,
      provider: "webauthn",
      createdAt: minutesAgo(120),
      passkeyVerifiedAt: minutesAgo(5),
      authCredentialId: null,
    });

    // The criterion the previous revision could not fail (finding M4):
    // nulling ONLY the binding on an otherwise-fresh row must flip the verdict.
    await expect(evaluateStepUpFreshness("sess-1", USER_ID)).resolves.toBe("stale");
  });

  it("judges non-webauthn sessions on createdAt: fresh within the window", async () => {
    mockSessionFindUnique.mockResolvedValue({
      userId: USER_ID,
      provider: "google",
      createdAt: minutesAgo(5),
      passkeyVerifiedAt: null,
    });

    await expect(evaluateStepUpFreshness("sess-1", USER_ID)).resolves.toBe("fresh");
  });

  it("judges non-webauthn sessions on createdAt: stale past the window", async () => {
    mockSessionFindUnique.mockResolvedValue({
      userId: USER_ID,
      provider: "google",
      createdAt: minutesAgo(20),
      passkeyVerifiedAt: null,
    });

    await expect(evaluateStepUpFreshness("sess-1", USER_ID)).resolves.toBe("stale");
  });

  it("treats provider null (pre-provenance session) like the createdAt branch", async () => {
    mockSessionFindUnique.mockResolvedValue({
      userId: USER_ID,
      provider: null,
      createdAt: minutesAgo(20),
      passkeyVerifiedAt: null,
    });

    await expect(evaluateStepUpFreshness("sess-1", USER_ID)).resolves.toBe("stale");
  });

  it("honors a custom maxAgeMs on the createdAt branch", async () => {
    mockSessionFindUnique.mockResolvedValue({
      userId: USER_ID,
      provider: "google",
      createdAt: minutesAgo(20),
      passkeyVerifiedAt: null,
    });

    await expect(
      evaluateStepUpFreshness("sess-1", USER_ID, { maxAgeMs: 30 * MS_PER_MINUTE }),
    ).resolves.toBe("fresh");
  });

  it("honors a custom maxAgeMs on the passkeyVerifiedAt branch", async () => {
    mockSessionFindUnique.mockResolvedValue({
      userId: USER_ID,
      provider: "webauthn",
      createdAt: minutesAgo(120),
      passkeyVerifiedAt: minutesAgo(20),
      authCredentialId: "cred-row-1",
    });

    await expect(
      evaluateStepUpFreshness("sess-1", USER_ID, { maxAgeMs: 30 * MS_PER_MINUTE }),
    ).resolves.toBe("fresh");
  });
});

describe("requireRecentCurrentAuthMethod", () => {
  // The cookie fixtures use the plain name, the configured one over http.
  beforeEach(() => {
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // auth() authenticates the FIRST of two same-named cookies; a reader that
  // took the last could evaluate a fresh session B for a request running as
  // a stale session A. Both cells see the same fresh row, so only the
  // header decides.
  describe("duplicated session cookie", () => {
    beforeEach(() => {
      mockSessionFindUnique.mockResolvedValue({
        userId: USER_ID,
        provider: "google",
        createdAt: minutesAgo(5),
        passkeyVerifiedAt: null,
      });
    });

    it("control: a single session cookie is evaluated (fresh → null)", async () => {
      await expect(
        requireRecentCurrentAuthMethod(makeRequest("authjs.session-token=bbbb"), USER_ID),
      ).resolves.toBeNull();
    });

    it("evaluates the first session, the one auth() authenticates (stale → 403)", async () => {
      // First = stale, second = fresh: reading the last would answer null.
      mockSessionFindUnique.mockImplementation(async ({ where }: { where: { sessionToken: string } }) =>
        where.sessionToken === hashSessionToken("aaaa")
          ? { userId: USER_ID, provider: "google", createdAt: minutesAgo(60), passkeyVerifiedAt: null }
          : { userId: USER_ID, provider: "google", createdAt: minutesAgo(5), passkeyVerifiedAt: null },
      );

      const result = await requireRecentCurrentAuthMethod(
        makeRequest("authjs.session-token=aaaa; authjs.session-token=bbbb"),
        USER_ID,
      );

      expect(result?.status).toBe(403);
      expect(mockSessionFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { sessionToken: hashSessionToken("aaaa") } }),
      );
    });
  });

  it("returns 401 when the request has no session cookie", async () => {
    const result = await requireRecentCurrentAuthMethod(makeRequest(""), USER_ID);

    expect(result?.status).toBe(401);
    expect(mockSessionFindUnique).not.toHaveBeenCalled();
  });

  // Refused side of the reader: the 401 must come from the refusal, before
  // any lookup, not from a row the lookup failed to find.
  it.each([
    ["a chunk-named cookie", `authjs.session-token.0=${TEST_SESSION_TOKEN}`],
    ["a quoted value", `authjs.session-token="${TEST_SESSION_TOKEN}"`],
  ])("returns 401 without a lookup for %s", async (_label, cookie) => {
    mockSessionFindUnique.mockResolvedValue({
      userId: USER_ID,
      provider: "google",
      createdAt: minutesAgo(5),
      passkeyVerifiedAt: null,
    });

    const result = await requireRecentCurrentAuthMethod(makeRequest(cookie), USER_ID);

    expect(result?.status).toBe(401);
    expect(mockSessionFindUnique).not.toHaveBeenCalled();
  });

  it("returns 401 when the cookie is valid but the session row is missing (DB miss)", async () => {
    mockSessionFindUnique.mockResolvedValue(null);

    const result = await requireRecentCurrentAuthMethod(makeRequest(), USER_ID);

    expect(result?.status).toBe(401);
    // The 401 is the lookup's miss, not a refused cookie.
    expect(mockSessionFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sessionToken: hashSessionToken(TEST_SESSION_TOKEN) } }),
    );
  });

  // Paired with the fresh (null) and stale (403) cells below, which differ
  // from this one only in the owner.
  it("returns 401 when the session row belongs to another user, even when fresh", async () => {
    mockSessionFindUnique.mockResolvedValue({
      userId: "someone-else",
      provider: "google",
      createdAt: minutesAgo(5),
      passkeyVerifiedAt: null,
    });

    const result = await requireRecentCurrentAuthMethod(makeRequest(), USER_ID);

    expect(result?.status).toBe(401);
  });

  it("returns null for a fresh session", async () => {
    mockSessionFindUnique.mockResolvedValue({
      userId: USER_ID,
      provider: "google",
      createdAt: minutesAgo(5),
      passkeyVerifiedAt: null,
    });

    await expect(
      requireRecentCurrentAuthMethod(makeRequest(), USER_ID),
    ).resolves.toBeNull();
  });

  it("returns 403 SESSION_STEP_UP_REQUIRED for a stale session by default", async () => {
    mockSessionFindUnique.mockResolvedValue({
      userId: USER_ID,
      provider: "google",
      createdAt: minutesAgo(20),
      passkeyVerifiedAt: null,
    });

    const result = await requireRecentCurrentAuthMethod(makeRequest(), USER_ID);

    expect(result?.status).toBe(403);
    const body = (await result?.json()) as { error: string };
    expect(body.error).toBe(API_ERROR.SESSION_STEP_UP_REQUIRED);
  });

  it("preserves a caller-supplied errorCode on the stale 403 (operator-tokens contract)", async () => {
    mockSessionFindUnique.mockResolvedValue({
      userId: USER_ID,
      provider: "webauthn",
      createdAt: minutesAgo(5),
      passkeyVerifiedAt: minutesAgo(20),
      authCredentialId: "cred-row-1",
    });

    const result = await requireRecentCurrentAuthMethod(makeRequest(), USER_ID, {
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
