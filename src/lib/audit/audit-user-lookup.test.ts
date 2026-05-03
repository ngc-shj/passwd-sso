import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findMany: vi.fn(),
    },
  },
}));

// Pass-through: the helper uses withBypassRls for RLS scoping; for unit tests
// we let the inner function run directly so we can observe the prisma call.
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: vi.fn(async (_prisma: unknown, fn: () => Promise<unknown>) => fn()),
  BYPASS_PURPOSE: { AUDIT_WRITE: "audit_write" },
}));

import { fetchAuditUserMap } from "./audit-user-lookup";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { ANONYMOUS_ACTOR_ID, SYSTEM_ACTOR_ID } from "@/lib/constants/app";

const REAL_USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const REAL_USER_ID_2 = "660e8400-e29b-41d4-a716-446655440001";

const mockedFindMany = vi.mocked(prisma.user.findMany);
const mockedBypass = vi.mocked(withBypassRls);

describe("fetchAuditUserMap", () => {
  beforeEach(() => {
    mockedFindMany.mockReset();
    mockedBypass.mockClear();
  });

  it("returns empty Map when input is empty", async () => {
    const map = await fetchAuditUserMap([]);
    expect(map.size).toBe(0);
    expect(mockedFindMany).not.toHaveBeenCalled();
  });

  it("returns empty Map when input contains only null/undefined", async () => {
    const map = await fetchAuditUserMap([null, undefined, null]);
    expect(map.size).toBe(0);
    expect(mockedFindMany).not.toHaveBeenCalled();
  });

  it("filters out ANONYMOUS_ACTOR_ID sentinel", async () => {
    const map = await fetchAuditUserMap([ANONYMOUS_ACTOR_ID]);
    expect(map.size).toBe(0);
    expect(mockedFindMany).not.toHaveBeenCalled();
  });

  it("filters out SYSTEM_ACTOR_ID sentinel", async () => {
    const map = await fetchAuditUserMap([SYSTEM_ACTOR_ID]);
    expect(map.size).toBe(0);
    expect(mockedFindMany).not.toHaveBeenCalled();
  });

  it("queries only real user IDs (sentinels filtered)", async () => {
    mockedFindMany.mockResolvedValue([
      { id: REAL_USER_ID, name: "Alice", email: "alice@example.com", image: null },
      // Cast to bypass full Prisma User shape — `select` narrows the real
      // result, but the mock typing requires the full type.
    ] as unknown as Awaited<ReturnType<typeof mockedFindMany>>);

    await fetchAuditUserMap([
      REAL_USER_ID,
      ANONYMOUS_ACTOR_ID,
      SYSTEM_ACTOR_ID,
      null,
    ]);

    expect(mockedFindMany).toHaveBeenCalledOnce();
    expect(mockedFindMany).toHaveBeenCalledWith({
      where: { id: { in: [REAL_USER_ID] } },
      select: { id: true, name: true, email: true, image: true },
    });
  });

  it("deduplicates repeated real user IDs", async () => {
    mockedFindMany.mockResolvedValue([
      { id: REAL_USER_ID, name: "Alice", email: "alice@example.com", image: null },
      // Cast to bypass full Prisma User shape — `select` narrows the real
      // result, but the mock typing requires the full type.
    ] as unknown as Awaited<ReturnType<typeof mockedFindMany>>);

    await fetchAuditUserMap([REAL_USER_ID, REAL_USER_ID, REAL_USER_ID]);

    expect(mockedFindMany).toHaveBeenCalledOnce();
    const callArg = mockedFindMany.mock.calls[0]?.[0] as { where: { id: { in: string[] } } };
    expect(callArg.where.id.in).toEqual([REAL_USER_ID]);
  });

  it("returns userId → user info Map keyed by id", async () => {
    mockedFindMany.mockResolvedValue([
      { id: REAL_USER_ID, name: "Alice", email: "alice@example.com", image: "img-a" },
      { id: REAL_USER_ID_2, name: "Bob", email: "bob@example.com", image: null },
    ] as unknown as Awaited<ReturnType<typeof mockedFindMany>>);

    const map = await fetchAuditUserMap([REAL_USER_ID, REAL_USER_ID_2]);

    expect(map.size).toBe(2);
    expect(map.get(REAL_USER_ID)).toEqual({
      id: REAL_USER_ID,
      name: "Alice",
      email: "alice@example.com",
      image: "img-a",
    });
    expect(map.get(REAL_USER_ID_2)).toEqual({
      id: REAL_USER_ID_2,
      name: "Bob",
      email: "bob@example.com",
      image: null,
    });
  });

  it("returns empty Map when DB returns no users (deleted user fallback)", async () => {
    mockedFindMany.mockResolvedValue([]);
    const map = await fetchAuditUserMap([REAL_USER_ID]);

    expect(map.size).toBe(0);
    // Caller (e.g. audit-log-stream) treats Map.get() returning undefined as "deleted"
    expect(map.get(REAL_USER_ID)).toBeUndefined();
  });

  it("partial result: existing user returned, deleted user absent from Map", async () => {
    mockedFindMany.mockResolvedValue([
      { id: REAL_USER_ID, name: "Alice", email: "alice@example.com", image: null },
      // Cast to bypass full Prisma User shape — `select` narrows the real
      // result, but the mock typing requires the full type.
    ] as unknown as Awaited<ReturnType<typeof mockedFindMany>>);

    const map = await fetchAuditUserMap([REAL_USER_ID, REAL_USER_ID_2]);

    expect(map.get(REAL_USER_ID)).toBeDefined();
    expect(map.get(REAL_USER_ID_2)).toBeUndefined();
  });

  it("invokes withBypassRls with AUDIT_WRITE purpose", async () => {
    mockedFindMany.mockResolvedValue([]);
    await fetchAuditUserMap([REAL_USER_ID]);

    expect(mockedBypass).toHaveBeenCalledOnce();
    const purpose = mockedBypass.mock.calls[0]?.[2];
    expect(purpose).toBe(BYPASS_PURPOSE.AUDIT_WRITE);
  });
});
