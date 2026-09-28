import { describe, it, expect, vi } from "vitest";
import { computeClientTokenExpiry, getFamilyPresenceAt } from "@/lib/auth/tokens/client-token-expiry";
import { MS_PER_MINUTE } from "@/lib/constants/time";

describe("computeClientTokenExpiry", () => {
  const now = new Date("2026-01-08T00:00:00.000Z");

  it("picks idle-from-now when it is the soonest cap", () => {
    // presenceAt in the future relative to now isolates idle-from-now as the
    // strict minimum; presenceAt <= now always holds at real call sites (a
    // presence timestamp cannot be in the future), where idle-from-presence
    // can only ever tie idle-from-now, never exceed it.
    const expiry = computeClientTokenExpiry({
      now,
      presenceAt: new Date(now.getTime() + 5 * MS_PER_MINUTE), // idle-from-presence: now + 15
      familyCreatedAt: new Date(now.getTime() - 60 * MS_PER_MINUTE), // absolute: now + 9940 (far)
      idleMinutes: 10,
      absoluteMinutes: 10_000,
    });
    expect(expiry.getTime()).toBe(now.getTime() + 10 * MS_PER_MINUTE);
  });

  it("picks idle-from-presence when presence is stale relative to now", () => {
    const presenceAt = new Date(now.getTime() - 5 * MS_PER_MINUTE);
    const expiry = computeClientTokenExpiry({
      now,
      presenceAt,
      familyCreatedAt: new Date(now.getTime() - 60 * MS_PER_MINUTE),
      idleMinutes: 10,
      absoluteMinutes: 10_000,
    });
    expect(expiry.getTime()).toBe(presenceAt.getTime() + 10 * MS_PER_MINUTE);
  });

  it("picks absolute-from-family when the family cap is the soonest", () => {
    const familyCreatedAt = new Date(now.getTime() - 9 * MS_PER_MINUTE);
    const expiry = computeClientTokenExpiry({
      now,
      presenceAt: now,
      familyCreatedAt,
      idleMinutes: 100,
      absoluteMinutes: 10,
    });
    expect(expiry.getTime()).toBe(familyCreatedAt.getTime() + 10 * MS_PER_MINUTE);
  });

  it("boundary: presence exactly idleMinutes stale yields an expiry of exactly now (already expired)", () => {
    const presenceAt = new Date(now.getTime() - 10 * MS_PER_MINUTE);
    const expiry = computeClientTokenExpiry({
      now,
      presenceAt,
      familyCreatedAt: presenceAt,
      idleMinutes: 10,
      absoluteMinutes: 10_000,
    });
    expect(expiry.getTime()).toBe(now.getTime());
  });

  it("boundary: family age exactly at the absolute cap yields an expiry of exactly now", () => {
    const familyCreatedAt = new Date(now.getTime() - 10 * MS_PER_MINUTE);
    const expiry = computeClientTokenExpiry({
      now,
      presenceAt: now,
      familyCreatedAt,
      idleMinutes: 1_000,
      absoluteMinutes: 10,
    });
    expect(expiry.getTime()).toBe(now.getTime());
  });
});

describe("getFamilyPresenceAt", () => {
  function txWithMax(lastPresenceAt: Date | null) {
    return {
      extensionToken: {
        aggregate: vi.fn().mockResolvedValue({ _max: { lastPresenceAt } }),
      },
    } as unknown as Parameters<typeof getFamilyPresenceAt>[0];
  }

  it("returns MAX(lastPresenceAt) across the family when present", async () => {
    const presence = new Date("2026-01-01T00:00:00.000Z");
    const tx = txWithMax(presence);
    const result = await getFamilyPresenceAt(tx, "family-1", new Date("2025-01-01T00:00:00.000Z"));
    expect(result).toEqual(presence);
  });

  it("falls back to familyCreatedAt when no row has ever recorded presence", async () => {
    const familyCreatedAt = new Date("2025-01-01T00:00:00.000Z");
    const tx = txWithMax(null);
    const result = await getFamilyPresenceAt(tx, "family-1", familyCreatedAt);
    expect(result).toEqual(familyCreatedAt);
  });

  it("queries without a revokedAt filter (MAX must include revoked rows)", async () => {
    const tx = txWithMax(new Date());
    await getFamilyPresenceAt(tx, "family-1", new Date());
    const aggregateMock = (tx as unknown as { extensionToken: { aggregate: ReturnType<typeof vi.fn> } })
      .extensionToken.aggregate;
    expect(aggregateMock).toHaveBeenCalledWith({
      where: { familyId: "family-1" },
      _max: { lastPresenceAt: true },
    });
  });
});
