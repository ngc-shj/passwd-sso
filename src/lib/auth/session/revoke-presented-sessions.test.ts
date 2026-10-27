import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDeleteMany, mockWithBypassRls, mockInvalidateCachedSessions } = vi.hoisted(() => ({
  mockDeleteMany: vi.fn(),
  mockWithBypassRls: vi.fn(),
  mockInvalidateCachedSessions: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/tenant-rls", () => ({ withBypassRls: mockWithBypassRls }));
vi.mock("@/lib/tenant-rls-grants", () => ({ BYPASS_GRANT: { AUTH_SESSION_LIFECYCLE: "AUTH_SESSION_LIFECYCLE" } }));
vi.mock("@/lib/auth/session/session-cache", () => ({
  hashSessionToken: (raw: string) => `hashed:${raw}`,
}));
vi.mock("@/lib/auth/session/session-cache-helpers", () => ({
  invalidateCachedSessions: mockInvalidateCachedSessions,
}));

import { revokePresentedSessions } from "./revoke-presented-sessions";

describe("revokePresentedSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithBypassRls.mockImplementation(async (_prisma: unknown, fn: (tx: unknown) => unknown) =>
      fn({ session: { deleteMany: mockDeleteMany } }),
    );
  });

  it("deletes each named session by digest, in the lifecycle grant's bypass scope", async () => {
    mockDeleteMany.mockResolvedValue({ count: 1 });

    await revokePresentedSessions(["tok-a", "tok-b"]);

    expect(mockDeleteMany.mock.calls.map(([arg]) => arg)).toEqual([
      { where: { sessionToken: "hashed:tok-a" } },
      { where: { sessionToken: "hashed:tok-b" } },
    ]);
    expect(mockWithBypassRls).toHaveBeenCalledWith(expect.anything(), expect.any(Function), "AUTH_SESSION_LIFECYCLE");
  });

  // A token that named no session gets no tombstone.
  it("invalidates the cache only for the sessions it deleted", async () => {
    mockDeleteMany.mockImplementation(async ({ where }: { where: { sessionToken: string } }) => ({
      count: where.sessionToken === "hashed:live" ? 1 : 0,
    }));

    await revokePresentedSessions(["live", "gone"]);

    expect(mockInvalidateCachedSessions).toHaveBeenCalledWith(["hashed:live"]);
  });

  it("does nothing when the request named no session", async () => {
    await revokePresentedSessions([]);

    expect(mockWithBypassRls).not.toHaveBeenCalled();
    expect(mockInvalidateCachedSessions).not.toHaveBeenCalled();
  });
});
