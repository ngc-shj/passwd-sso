import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFindUnique, mockDeleteMany, mockWithBypassRls, mockInvalidateCachedSessions } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
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

// An in-memory session table: digest -> owner.
function seed(rows: Record<string, string>) {
  const table = new Map(Object.entries(rows));
  mockFindUnique.mockImplementation(async ({ where }: { where: { sessionToken: string } }) =>
    table.has(where.sessionToken) ? { sessionToken: where.sessionToken, userId: table.get(where.sessionToken) } : null,
  );
  mockDeleteMany.mockImplementation(async ({ where }: { where: { sessionToken: string } }) => ({
    count: table.delete(where.sessionToken) ? 1 : 0,
  }));
  return table;
}

describe("revokePresentedSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithBypassRls.mockImplementation(async (_prisma: unknown, fn: (tx: unknown) => unknown) =>
      fn({ session: { findUnique: mockFindUnique, deleteMany: mockDeleteMany } }),
    );
  });

  it("deletes each named session by digest, whoever owns it, in the lifecycle grant's bypass scope", async () => {
    const table = seed({ "hashed:tok-a": "user-1", "hashed:tok-b": "user-2" });

    await revokePresentedSessions(["tok-a", "tok-b"]);

    expect(table.size).toBe(0);
    expect(mockDeleteMany.mock.calls.map(([arg]) => arg)).toEqual([
      { where: { sessionToken: "hashed:tok-a" } },
      { where: { sessionToken: "hashed:tok-b" } },
    ]);
    expect(mockWithBypassRls).toHaveBeenCalledWith(expect.anything(), expect.any(Function), "AUTH_SESSION_LIFECYCLE");
  });

  // The sign-out audits the sessions it ended from this list.
  it("returns the deleted rows with their owners, and only those", async () => {
    seed({ "hashed:live-a": "user-1", "hashed:live-b": "user-2" });

    expect(await revokePresentedSessions(["live-a", "gone", "live-b"])).toEqual([
      { sessionToken: "hashed:live-a", userId: "user-1" },
      { sessionToken: "hashed:live-b", userId: "user-2" },
    ]);
  });

  // A token that named no session gets no tombstone.
  it("invalidates the cache only for the sessions it deleted", async () => {
    seed({ "hashed:live": "user-1" });

    await revokePresentedSessions(["live", "gone"]);

    expect(mockInvalidateCachedSessions).toHaveBeenCalledWith(["hashed:live"]);
  });

  // A concurrent delete (another sign-out, the retention sweep) removed the
  // row between the read and the delete: this call ended nothing, so it
  // reports nothing and writes no tombstone.
  it("returns nothing and invalidates nothing when the row vanished before its delete", async () => {
    mockFindUnique.mockResolvedValue({ sessionToken: "hashed:raced", userId: "user-1" });
    mockDeleteMany.mockResolvedValue({ count: 0 });

    expect(await revokePresentedSessions(["raced"])).toEqual([]);

    expect(mockDeleteMany).toHaveBeenCalledWith({ where: { sessionToken: "hashed:raced" } });
    expect(mockInvalidateCachedSessions).not.toHaveBeenCalled();
  });

  it("does nothing when the request named no session", async () => {
    expect(await revokePresentedSessions([])).toEqual([]);

    expect(mockWithBypassRls).not.toHaveBeenCalled();
    expect(mockInvalidateCachedSessions).not.toHaveBeenCalled();
  });
});
