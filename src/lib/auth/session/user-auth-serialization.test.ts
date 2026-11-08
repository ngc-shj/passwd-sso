import { describe, it, expect, vi } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { TEST_SESSION_TOKEN } from "@/__tests__/helpers/fixtures";
import { hashSessionToken } from "@/lib/auth/session/session-cache";
import { isSessionRowLive, isTokenRowLive, lockUserAuthArtifacts } from "./user-auth-serialization";

const USER = "user-1";

function sessionTx(row: { id: string } | null) {
  const findFirst = vi.fn().mockResolvedValue(row);
  return { tx: { session: { findFirst } } as never, findFirst };
}

describe("lockUserAuthArtifacts", () => {
  it("takes the transaction-scoped advisory lock under the user's namespaced credential key", async () => {
    const $executeRaw = vi.fn().mockResolvedValue(1);
    await lockUserAuthArtifacts({ $executeRaw } as never, USER);

    expect(String($executeRaw.mock.calls[0][0])).toContain("pg_advisory_xact_lock");
    expect($executeRaw.mock.calls[0][1]).toBe(`user-auth:${USER}`);
  });
});

describe("isSessionRowLive", () => {
  const withCookie = () =>
    createRequest("POST", "http://localhost/api/x", {
      headers: { cookie: `authjs.session-token=${TEST_SESSION_TOKEN}` },
    });

  it("reads the request's own session by its stored digest, for this user, unexpired", async () => {
    const { tx, findFirst } = sessionTx({ id: "s1" });

    expect(await isSessionRowLive(tx, withCookie(), USER)).toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: { sessionToken: hashSessionToken(TEST_SESSION_TOKEN), userId: USER, expires: { gt: expect.any(Date) } },
      select: { id: true },
    });
  });

  it("is false once the session row is gone", async () => {
    const { tx } = sessionTx(null);
    expect(await isSessionRowLive(tx, withCookie(), USER)).toBe(false);
  });

  it("is false without a session cookie, without reading", async () => {
    const { tx, findFirst } = sessionTx({ id: "s1" });

    expect(await isSessionRowLive(tx, createRequest("POST", "http://localhost/api/x"), USER)).toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("isTokenRowLive", () => {
  it("is true only for this user's unrevoked, unexpired token row", async () => {
    const findFirst = vi.fn().mockResolvedValueOnce({ id: "t1" }).mockResolvedValueOnce(null);
    const tx = { extensionToken: { findFirst } } as never;

    expect(await isTokenRowLive(tx, "t1", USER)).toBe(true);
    expect(await isTokenRowLive(tx, "t1", USER)).toBe(false);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "t1", userId: USER, revokedAt: null, expiresAt: { gt: expect.any(Date) } },
      select: { id: true },
    });
  });
});
