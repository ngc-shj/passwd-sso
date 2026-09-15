import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    // The tenant policy is loaded by id now, not traversed through the
    // `user.tenant` relation — the relation follows the stale column.
    tenant: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: vi.fn(async (prisma: unknown, fn: (tx: unknown) => unknown) => fn(prisma)),
  BYPASS_PURPOSE: { AUTH_FLOW: "auth_flow" },
}));

import { prisma } from "@/lib/prisma";
import {
  resolveEffectiveSessionTimeouts,
  invalidateSessionTimeoutCache,
  invalidateSessionTimeoutCacheForTenant,
  _internal,
} from "./session-timeout";

const mockFindUnique = prisma.user.findUnique as ReturnType<typeof vi.fn>;
const mockTenantFindUnique = prisma.tenant.findUnique as ReturnType<typeof vi.fn>;

//
// `membershipTenantId` defaults to `tenantId` so every existing cell keeps the
// agreeing fixture it was written against; only the divergent cell below splits
// them, and it replaces the tenant stub with one that answers per id.
function seedUser(params: {
  tenantId?: string;
  membershipTenantId?: string;
  tenantIdle?: number;
  tenantAbsolute?: number;
  teams?: Array<{ idle?: number | null; absolute?: number | null }>;
}) {
  const tenantId = params.tenantId ?? "tenant-1";
  const membershipTenantId = params.membershipTenantId ?? tenantId;
  // Two distinct user reads now, keyed off the select so each returns only its
  // own fields as Prisma would: `resolveOwningTenantIdFromClient`'s
  // (tenantId + active memberships), then the teamMemberships one. The
  // membership row must carry the tenant id — a column-only mock would resolve
  // through the FALLBACK while reading like the ordinary case.
  mockFindUnique.mockImplementation(
    async ({ select }: { select: Record<string, unknown> }) =>
      "tenantMemberships" in select
        ? { tenantId, tenantMemberships: [{ tenantId: membershipTenantId }] }
        : {
            teamMemberships: (params.teams ?? []).map((t) => ({
              team: {
                policy: {
                  sessionIdleTimeoutMinutes: t.idle ?? null,
                  sessionAbsoluteTimeoutMinutes: t.absolute ?? null,
                },
              },
            })),
          },
  );
  mockTenantFindUnique.mockResolvedValue({
    sessionIdleTimeoutMinutes: params.tenantIdle ?? 480,
    sessionAbsoluteTimeoutMinutes: params.tenantAbsolute ?? 43200,
  });
}

beforeEach(() => {
  mockFindUnique.mockReset();
  mockTenantFindUnique.mockReset();
  _internal.clear();
});

describe("resolveEffectiveSessionTimeouts", () => {
  it("returns tenant defaults when user has no team memberships", async () => {
    seedUser({ tenantIdle: 480, tenantAbsolute: 43200 });
    const result = await resolveEffectiveSessionTimeouts("user-1", null);
    expect(result).toEqual({
      idleMinutes: 480,
      absoluteMinutes: 43200,
      tenantId: "tenant-1",
    });
  });

  it("ignores teams that have null session fields", async () => {
    seedUser({
      tenantIdle: 480,
      tenantAbsolute: 43200,
      teams: [{ idle: null, absolute: null }],
    });
    const result = await resolveEffectiveSessionTimeouts("user-2", null);
    expect(result.idleMinutes).toBe(480);
    expect(result.absoluteMinutes).toBe(43200);
  });

  it("applies a stricter team idle value", async () => {
    seedUser({
      tenantIdle: 480,
      tenantAbsolute: 43200,
      teams: [{ idle: 60, absolute: null }],
    });
    const result = await resolveEffectiveSessionTimeouts("user-3", null);
    expect(result.idleMinutes).toBe(60);
    expect(result.absoluteMinutes).toBe(43200);
  });

  it("takes the minimum across multiple stricter teams", async () => {
    seedUser({
      tenantIdle: 480,
      tenantAbsolute: 43200,
      teams: [
        { idle: 120, absolute: 720 },
        { idle: 60, absolute: 1440 },
        { idle: null, absolute: 240 },
      ],
    });
    const result = await resolveEffectiveSessionTimeouts("user-4", null);
    expect(result.idleMinutes).toBe(60);
    expect(result.absoluteMinutes).toBe(240);
  });

  it("returns tenant policy for webauthn sessions (no AAL3-style clamp post D1)", async () => {
    seedUser({
      tenantIdle: 480,
      tenantAbsolute: 43200,
    });
    const result = await resolveEffectiveSessionTimeouts("user-5", "webauthn");
    expect(result.idleMinutes).toBe(480);
    expect(result.absoluteMinutes).toBe(43200);
  });

  it("does NOT clamp for non-webauthn providers", async () => {
    seedUser({
      tenantIdle: 480,
      tenantAbsolute: 43200,
    });
    const google = await resolveEffectiveSessionTimeouts("user-6", "google");
    expect(google.idleMinutes).toBe(480);
    expect(google.absoluteMinutes).toBe(43200);

    _internal.clear();
    seedUser({
      tenantIdle: 480,
      tenantAbsolute: 43200,
    });
    const unknown = await resolveEffectiveSessionTimeouts("user-7", null);
    expect(unknown.idleMinutes).toBe(480);
    expect(unknown.absoluteMinutes).toBe(43200);
  });

  it("preserves stricter policy values for webauthn sessions", async () => {
    seedUser({
      tenantIdle: 10,
      tenantAbsolute: 360,
    });
    const result = await resolveEffectiveSessionTimeouts("user-8", "webauthn");
    expect(result.idleMinutes).toBe(10);
    expect(result.absoluteMinutes).toBe(360);
  });

  it("caches the resolution and returns the cached value on second call", async () => {
    seedUser({
      tenantIdle: 480,
      tenantAbsolute: 43200,
    });
    await resolveEffectiveSessionTimeouts("user-cache", null);
    await resolveEffectiveSessionTimeouts("user-cache", null);
    // One uncached resolution is TWO user reads now (the tenant-id resolve plus
    // the teamMemberships read) and one tenant read; the second call adds none.
    expect(mockFindUnique).toHaveBeenCalledTimes(2);
    expect(mockTenantFindUnique).toHaveBeenCalledTimes(1);
  });

  it("cache entry is per-provider-agnostic and returns the same resolved values", async () => {
    seedUser({
      tenantIdle: 480,
      tenantAbsolute: 43200,
    });
    const google = await resolveEffectiveSessionTimeouts("user-9", "google");
    expect(google.idleMinutes).toBe(480);
    const webauthn = await resolveEffectiveSessionTimeouts("user-9", "webauthn");
    expect(webauthn.idleMinutes).toBe(480);
    expect(webauthn.absoluteMinutes).toBe(43200);
    // Two user reads for the single uncached resolution — see above.
    expect(mockFindUnique).toHaveBeenCalledTimes(2);
  });

  it("ignores team values that are <= 0 (defensive)", async () => {
    seedUser({
      tenantIdle: 480,
      tenantAbsolute: 43200,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      teams: [{ idle: 0 as any, absolute: -5 as any }],
    });
    const result = await resolveEffectiveSessionTimeouts("user-10", null);
    expect(result.idleMinutes).toBe(480);
    expect(result.absoluteMinutes).toBe(43200);
  });

  it("loads the timeout policy from the active membership, not User.tenantId", async () => {
    // Every cell above seeds the same id in both places and a tenant stub that
    // returns one policy for any id, so the resolved timeouts are identical
    // whichever source is read — the fixture cannot see precedence.
    //
    // Here the two ids carry different policies, so the returned minutes are the
    // discriminator, not merely the id echoed back in `result.tenantId`. Reading
    // the stale column would hand the user the tenant's OLD, laxer idle window,
    // and cache it under a tenant id that
    // `invalidateSessionTimeoutCacheForTenant` on their real tenant never sweeps.
    seedUser({
      tenantId: "stale-home-tenant",
      membershipTenantId: "scim-provisioned-tenant",
    });
    mockTenantFindUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        where.id === "scim-provisioned-tenant"
          ? { sessionIdleTimeoutMinutes: 15, sessionAbsoluteTimeoutMinutes: 600 }
          : { sessionIdleTimeoutMinutes: 480, sessionAbsoluteTimeoutMinutes: 43200 },
    );

    const result = await resolveEffectiveSessionTimeouts("user-scim-moved", null);

    expect(result).toEqual({
      idleMinutes: 15,
      absoluteMinutes: 600,
      tenantId: "scim-provisioned-tenant",
    });
    // The cache key the tenant-wide invalidation matches on is this same id.
    expect(_internal.cache.get("user-scim-moved")?.tenantId).toBe("scim-provisioned-tenant");
  });

  it("falls back to restrictive values when the user is not found", async () => {
    mockFindUnique.mockResolvedValue(null);
    const result = await resolveEffectiveSessionTimeouts("missing", null);
    expect(result.idleMinutes).toBe(1);
    expect(result.absoluteMinutes).toBe(1);
  });
});

describe("invalidateSessionTimeoutCache", () => {
  it("removes a single user's cached entry", async () => {
    seedUser({ tenantIdle: 480, tenantAbsolute: 43200 });
    await resolveEffectiveSessionTimeouts("user-a", null);
    expect(_internal.cache.size).toBe(1);

    invalidateSessionTimeoutCache("user-a");
    expect(_internal.cache.size).toBe(0);
  });

  it("is a no-op when the user is not cached", () => {
    invalidateSessionTimeoutCache("nobody");
    expect(_internal.cache.size).toBe(0);
  });
});

describe("invalidateSessionTimeoutCacheForTenant", () => {
  it("removes all entries for a given tenantId and preserves others", async () => {
    seedUser({ tenantId: "tenant-a", tenantIdle: 480, tenantAbsolute: 43200 });
    await resolveEffectiveSessionTimeouts("user-tenant-a", null);

    seedUser({ tenantId: "tenant-b", tenantIdle: 60, tenantAbsolute: 720 });
    await resolveEffectiveSessionTimeouts("user-tenant-b", null);

    expect(_internal.cache.size).toBe(2);

    invalidateSessionTimeoutCacheForTenant("tenant-a");
    expect(_internal.cache.size).toBe(1);
    expect(_internal.cache.get("user-tenant-a")).toBeUndefined();
    expect(_internal.cache.get("user-tenant-b")).toBeDefined();
  });
});

describe("session timeout cache eviction — TTL sweep before FIFO", () => {
  beforeEach(() => {
    _internal.clear();
    mockFindUnique.mockReset();
    mockTenantFindUnique.mockReset();
  });

  it("evicts expired entries first when the cache fills, preserving fresh entries", async () => {
    const now = Date.now();
    // Pre-fill the cache to capacity. Half expired, half fresh, interleaved.
    for (let i = 0; i < _internal.MAX_SIZE; i++) {
      _internal.cache.set(`user-${i}`, {
        idleMinutes: 30,
        absoluteMinutes: 480,
        tenantId: `tenant-${i % 5}`,
        expiresAt: i % 2 === 0 ? now + 60_000 : now - 1,
      });
    }
    expect(_internal.cache.size).toBe(_internal.MAX_SIZE);

    // New user fetch triggers eviction path
    seedUser({ tenantIdle: 60, tenantAbsolute: 600 });
    await resolveEffectiveSessionTimeouts("user-new", null);

    expect(_internal.cache.has("user-new")).toBe(true);
    // After TTL sweep, all expired (odd-indexed) entries are gone; fresh
    // (even-indexed) entries survive. The fresh head ("user-0") was NOT
    // evicted as a FIFO casualty.
    expect(_internal.cache.has("user-0")).toBe(true);
    expect(_internal.cache.has("user-1")).toBe(false);
    expect(_internal.cache.has("user-2")).toBe(true);
    expect(_internal.cache.has("user-3")).toBe(false);
  });

  it("falls back to FIFO when every entry is fresh", async () => {
    const now = Date.now();
    for (let i = 0; i < _internal.MAX_SIZE; i++) {
      _internal.cache.set(`user-${i}`, {
        idleMinutes: 30,
        absoluteMinutes: 480,
        tenantId: `tenant-${i % 5}`,
        expiresAt: now + 60_000,
      });
    }
    expect(_internal.cache.size).toBe(_internal.MAX_SIZE);

    seedUser({ tenantIdle: 60, tenantAbsolute: 600 });
    await resolveEffectiveSessionTimeouts("user-new", null);

    // All fresh → sweep no-op → FIFO evicts head (user-0).
    expect(_internal.cache.has("user-0")).toBe(false);
    expect(_internal.cache.has("user-new")).toBe(true);
    expect(_internal.cache.size).toBe(_internal.MAX_SIZE);
  });
});
