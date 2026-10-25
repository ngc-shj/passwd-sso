import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockSessionFindUnique,
  mockWithBypassRls,
} = vi.hoisted(() => ({
  mockSessionFindUnique: vi.fn(),
  mockWithBypassRls: vi.fn(),
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

import { requireRecentSession, STEP_UP_WINDOW_MS } from "./step-up";
import { hashSessionToken } from "./session-cache";
import { TEST_SESSION_TOKEN } from "@/__tests__/helpers/fixtures";

// The user the route's auth() resolved.
const USER_ID = "user-1";

function makeRequest(cookie = `authjs.session-token=${TEST_SESSION_TOKEN}`) {
  return new NextRequest("http://localhost:3000/api/test", {
    headers: { cookie },
  });
}

describe("requireRecentSession", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // The cookie fixtures use the plain name, the configured one over http.
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
    mockWithBypassRls.mockImplementation(
      (prisma: unknown, fn: (tx: unknown) => unknown, _purpose: string) => fn(prisma),
    );
  });

  it("returns null when the session was created within the allowed window", async () => {
    mockSessionFindUnique.mockResolvedValue({
      userId: USER_ID,
      createdAt: new Date(Date.now() - STEP_UP_WINDOW_MS + 30_000),
    });

    const result = await requireRecentSession(makeRequest(), USER_ID);
    expect(result).toBeNull();
  });

  it("returns 403 when the session is stale", async () => {
    mockSessionFindUnique.mockResolvedValue({
      userId: USER_ID,
      createdAt: new Date(Date.now() - STEP_UP_WINDOW_MS - 30_000),
    });

    const result = await requireRecentSession(makeRequest(), USER_ID);
    expect(result?.status).toBe(403);
    await expect(result?.json()).resolves.toEqual({
      error: "SESSION_STEP_UP_REQUIRED",
    });
  });

  it("returns 401 when the request has no session cookie", async () => {
    const result = await requireRecentSession(makeRequest(""), USER_ID);
    expect(result?.status).toBe(401);
  });

  // Refused side of the reader: the 401 must come from the refusal, before
  // any lookup, not from a row the lookup failed to find.
  it.each([
    ["a chunk-named cookie", `authjs.session-token.0=${TEST_SESSION_TOKEN}`],
    ["a quoted value", `authjs.session-token="${TEST_SESSION_TOKEN}"`],
  ])("returns 401 without a lookup for %s", async (_label, cookie) => {
    mockSessionFindUnique.mockResolvedValue({ userId: USER_ID, createdAt: new Date() });

    const result = await requireRecentSession(makeRequest(cookie), USER_ID);
    expect(result?.status).toBe(401);
    expect(mockSessionFindUnique).not.toHaveBeenCalled();
  });

  // auth() authenticates the FIRST of two same-named cookies; a reader that
  // took the last could evaluate a fresh session B for a request running as
  // a stale session A. Both cells see the same fresh row.
  it("control: a single session cookie is evaluated (fresh → null)", async () => {
    mockSessionFindUnique.mockResolvedValue({ userId: USER_ID, createdAt: new Date() });

    const result = await requireRecentSession(makeRequest("authjs.session-token=bbbb"), USER_ID);
    expect(result).toBeNull();
  });

  it("evaluates the first of a duplicated session cookie, the one auth() authenticates", async () => {
    // First = stale, second = fresh. Reading the last (RequestCookies) would
    // answer null; the first answers 403.
    const stale = new Date(Date.now() - STEP_UP_WINDOW_MS - 60_000);
    mockSessionFindUnique.mockImplementation(async ({ where }: { where: { sessionToken: string } }) =>
      where.sessionToken === hashSessionToken("aaaa")
        ? { userId: USER_ID, createdAt: stale }
        : { userId: USER_ID, createdAt: new Date() },
    );

    const result = await requireRecentSession(
      makeRequest("authjs.session-token=aaaa; authjs.session-token=bbbb"),
      USER_ID,
    );
    expect(result?.status).toBe(403);
    expect(mockSessionFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sessionToken: hashSessionToken("aaaa") } }),
    );
  });

  it("returns 401 when the session row does not exist", async () => {
    mockSessionFindUnique.mockResolvedValue(null);

    const result = await requireRecentSession(makeRequest(), USER_ID);
    expect(result?.status).toBe(401);
    // The 401 is the lookup's miss, not a refused cookie.
    expect(mockSessionFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sessionToken: hashSessionToken(TEST_SESSION_TOKEN) } }),
    );
  });

  // The row must be the session auth() authenticated. Paired with the fresh
  // and stale cells above, which differ from this one only in the owner.
  it("returns 401 when the session row belongs to another user, even when fresh", async () => {
    mockSessionFindUnique.mockResolvedValue({ userId: "someone-else", createdAt: new Date() });

    const result = await requireRecentSession(makeRequest(), USER_ID);
    expect(result?.status).toBe(401);
    expect(mockSessionFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ userId: true }) }),
    );
  });

  it("returns 401 when the session row belongs to another user and is stale", async () => {
    mockSessionFindUnique.mockResolvedValue({
      userId: "someone-else",
      createdAt: new Date(Date.now() - STEP_UP_WINDOW_MS - 30_000),
    });

    const result = await requireRecentSession(makeRequest(), USER_ID);
    expect(result?.status).toBe(401);
  });
});
