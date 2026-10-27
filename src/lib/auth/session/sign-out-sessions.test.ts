import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDeleteMany, mockWithBypassRls, mockInvalidateCachedSessions } = vi.hoisted(() => ({
  mockDeleteMany: vi.fn(),
  mockWithBypassRls: vi.fn(),
  mockInvalidateCachedSessions: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/tenant-rls", () => ({ withBypassRls: mockWithBypassRls }));
vi.mock("@/lib/auth/session/session-cache", () => ({
  hashSessionToken: (raw: string) => `hashed:${raw}`,
}));
vi.mock("@/lib/auth/session/session-cache-helpers", () => ({
  invalidateCachedSessions: mockInvalidateCachedSessions,
}));

import { revokeSignedOutUserSessions } from "./sign-out-sessions";

describe("revokeSignedOutUserSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithBypassRls.mockImplementation(async (_prisma: unknown, fn: (tx: unknown) => unknown) =>
      fn({ session: { deleteMany: mockDeleteMany } }),
    );
  });

  it("deletes each named session only where it belongs to the signed-out user", async () => {
    mockDeleteMany.mockResolvedValue({ count: 1 });

    await revokeSignedOutUserSessions("user-1", ["tok-a", "tok-b"]);

    expect(mockDeleteMany.mock.calls.map(([arg]) => arg)).toEqual([
      { where: { sessionToken: "hashed:tok-a", userId: "user-1" } },
      { where: { sessionToken: "hashed:tok-b", userId: "user-1" } },
    ]);
  });

  // A tombstone would cut off a session left alive (another user's, or one
  // already gone) for the tombstone's lifetime.
  it("invalidates the cache only for the sessions it deleted", async () => {
    mockDeleteMany.mockImplementation(async ({ where }: { where: { sessionToken: string } }) => ({
      count: where.sessionToken === "hashed:own" ? 1 : 0,
    }));

    await revokeSignedOutUserSessions("user-1", ["own", "foreign"]);

    expect(mockInvalidateCachedSessions).toHaveBeenCalledWith(["hashed:own"]);
  });

  it("does nothing when the request named no session", async () => {
    await revokeSignedOutUserSessions("user-1", []);

    expect(mockWithBypassRls).not.toHaveBeenCalled();
    expect(mockInvalidateCachedSessions).not.toHaveBeenCalled();
  });
});
