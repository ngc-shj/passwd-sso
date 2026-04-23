import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
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

function seedUser(params: {
  tenantId?: string;
  tenantIdle?: number;
  tenantAbsolute?: number;
  teams?: Array<{ idle?: number | null; absolute?: number | null }>;
}) {
  mockFindUnique.mockResolvedValue({
    tenantId: params.tenantId ?? "tenant-1",
    tenant: {
      sessionIdleTimeoutMinutes: params.tenantIdle ?? 480,
      sessionAbsoluteTimeoutMinutes: params.tenantAbsolute ?? 43200,
    },
    teamMemberships: (params.teams ?? []).map((t) => ({
      team: {
        policy: {
          sessionIdleTimeoutMinutes: t.idle ?? null,
          sessionAbsoluteTimeoutMinutes: t.absolute ?? null,
        },
      },
    })),
  });
}

beforeEach(() => {
  mockFindUnique.mockReset();
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

  it("clamps to AAL3 ceilings when sessionProvider is webauthn", async () => {
    seedUser({
      tenantIdle: 480,
      tenantAbsolute: 43200,
    });
    const result = await resolveEffectiveSessionTimeouts("user-5", "webauthn");
    expect(result.idleMinutes).toBe(15);
    expect(result.absoluteMinutes).toBe(720);
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

  it("AAL3 clamp takes the min of policy and AAL3 ceiling (does not loosen policy)", async () => {
    seedUser({
      tenantIdle: 10, // already stricter than AAL3 idle (15)
      tenantAbsolute: 360, // already stricter than AAL3 absolute (720)
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
    expect(mockFindUnique).toHaveBeenCalledTimes(1);
  });

  it("cache entry is per-provider-agnostic; AAL3 clamp is applied at read time from cached values", async () => {
    seedUser({
      tenantIdle: 480,
      tenantAbsolute: 43200,
    });
    // First call caches the non-clamped (google) values
    const google = await resolveEffectiveSessionTimeouts("user-9", "google");
    expect(google.idleMinutes).toBe(480);
    // Second call reads cache but applies AAL3 clamp
    const webauthn = await resolveEffectiveSessionTimeouts("user-9", "webauthn");
    expect(webauthn.idleMinutes).toBe(15);
    expect(webauthn.absoluteMinutes).toBe(720);
    expect(mockFindUnique).toHaveBeenCalledTimes(1);
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
