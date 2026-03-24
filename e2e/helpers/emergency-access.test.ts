/**
 * Unit tests for seedEmergencyGrant (emergency-access.ts).
 * Verifies token_hash computation, status-dependent timestamps,
 * and correct SQL parameters.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

// ─── pg mock ────────────────────────────────────────────────────

const mockQuery = vi.fn().mockResolvedValue({ rows: [] });

vi.mock("pg", () => ({
  default: {
    Pool: vi.fn(function () {
      return { query: mockQuery, end: vi.fn() };
    }),
  },
}));

import { seedEmergencyGrant } from "./emergency-access";
import { E2E_TENANT } from "./db";

// ─── Helpers ────────────────────────────────────────────────────

function getParams(): unknown[] {
  const call = mockQuery.mock.calls[0] as [string, unknown[]];
  return call[1];
}

// Param index reference (from the INSERT VALUES order):
// $1=id, $2=tenantId, $3=ownerId, $4=granteeId, $5=granteeEmail,
// $6=status, $7=waitDays, $8=tokenHash, $9=tokenExpiresAt,
// $10=requestedAt, $11=activatedAt, $12=waitExpiresAt,
// $13=createdAt, $14=updatedAt

const BASE_OPTIONS = {
  id: "00000000-0000-4000-a000-000000000001",
  ownerId: "00000000-0000-4000-b000-000000000001",
  granteeId: "00000000-0000-4000-c000-000000000001",
  granteeEmail: "e2e-grantee@test.local",
  waitDays: 3,
};

// ─── Tests ──────────────────────────────────────────────────────

describe("seedEmergencyGrant", () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it("calls pool.query once with INSERT INTO emergency_access_grants", async () => {
    await seedEmergencyGrant({ ...BASE_OPTIONS, status: "IDLE" });
    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO emergency_access_grants/i);
  });

  it("uses ON CONFLICT (id) DO UPDATE SET", async () => {
    await seedEmergencyGrant({ ...BASE_OPTIONS, status: "IDLE" });
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ON CONFLICT \(id\)/i);
    expect(sql).toMatch(/DO UPDATE SET/i);
  });

  it("passes E2E_TENANT.id as tenantId by default", async () => {
    await seedEmergencyGrant({ ...BASE_OPTIONS, status: "IDLE" });
    const params = getParams();
    expect(params[1]).toBe(E2E_TENANT.id);
  });

  it("passes custom tenantId when provided", async () => {
    const customId = "custom-tenant-xyz";
    await seedEmergencyGrant({
      ...BASE_OPTIONS,
      status: "IDLE",
      tenantId: customId,
    });
    const params = getParams();
    expect(params[1]).toBe(customId);
  });

  it("computes token_hash as SHA-256(SHA-256('e2e-ea-token:' + id))", async () => {
    await seedEmergencyGrant({ ...BASE_OPTIONS, status: "IDLE" });
    const params = getParams();
    const tokenHash = params[7] as string;

    // Replicate the deterministic token computation
    const rawToken = createHash("sha256")
      .update("e2e-ea-token:")
      .update(BASE_OPTIONS.id)
      .digest("hex");
    const expectedHash = createHash("sha256").update(rawToken).digest("hex");

    expect(tokenHash).toBe(expectedHash);
  });

  it("sets token_expires_at approximately 7 days in the future", async () => {
    const before = Date.now();
    await seedEmergencyGrant({ ...BASE_OPTIONS, status: "PENDING" });
    const params = getParams();
    const tokenExpiresAt = new Date(params[8] as string).getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(tokenExpiresAt).toBeGreaterThanOrEqual(before + sevenDays - 1000);
    expect(tokenExpiresAt).toBeLessThanOrEqual(before + sevenDays + 5000);
  });

  describe("status: IDLE", () => {
    it("sets status to IDLE", async () => {
      await seedEmergencyGrant({ ...BASE_OPTIONS, status: "IDLE" });
      const params = getParams();
      expect(params[5]).toBe("IDLE");
    });

    it("sets requestedAt to null", async () => {
      await seedEmergencyGrant({ ...BASE_OPTIONS, status: "IDLE" });
      const params = getParams();
      expect(params[9]).toBeNull();
    });

    it("sets activatedAt to null", async () => {
      await seedEmergencyGrant({ ...BASE_OPTIONS, status: "IDLE" });
      const params = getParams();
      expect(params[10]).toBeNull();
    });

    it("sets waitExpiresAt to null", async () => {
      await seedEmergencyGrant({ ...BASE_OPTIONS, status: "IDLE" });
      const params = getParams();
      expect(params[11]).toBeNull();
    });
  });

  describe("status: PENDING", () => {
    it("sets status to PENDING", async () => {
      await seedEmergencyGrant({ ...BASE_OPTIONS, status: "PENDING" });
      const params = getParams();
      expect(params[5]).toBe("PENDING");
    });

    it("sets all state timestamps to null (no requestedAt/activatedAt)", async () => {
      await seedEmergencyGrant({ ...BASE_OPTIONS, status: "PENDING" });
      const params = getParams();
      expect(params[9]).toBeNull();  // requestedAt
      expect(params[10]).toBeNull(); // activatedAt
      expect(params[11]).toBeNull(); // waitExpiresAt
    });
  });

  describe("status: REQUESTED", () => {
    it("sets status to REQUESTED", async () => {
      await seedEmergencyGrant({ ...BASE_OPTIONS, status: "REQUESTED" });
      const params = getParams();
      expect(params[5]).toBe("REQUESTED");
    });

    it("sets requestedAt to approximately 1 hour ago", async () => {
      const before = Date.now();
      await seedEmergencyGrant({ ...BASE_OPTIONS, status: "REQUESTED" });
      const params = getParams();
      const requestedAt = new Date(params[9] as string).getTime();
      const oneHour = 60 * 60 * 1000;
      expect(requestedAt).toBeLessThanOrEqual(before - oneHour + 1000);
      expect(requestedAt).toBeGreaterThanOrEqual(before - oneHour - 5000);
    });

    it("sets waitExpiresAt using waitDays", async () => {
      const before = Date.now();
      await seedEmergencyGrant({
        ...BASE_OPTIONS,
        status: "REQUESTED",
        waitDays: 3,
      });
      const params = getParams();
      const waitExpiresAt = new Date(params[11] as string).getTime();
      const threeDays = 3 * 24 * 60 * 60 * 1000;
      expect(waitExpiresAt).toBeGreaterThanOrEqual(
        before + threeDays - 1000
      );
      expect(waitExpiresAt).toBeLessThanOrEqual(before + threeDays + 5000);
    });

    it("uses waitExpiresInDays override when provided", async () => {
      const before = Date.now();
      await seedEmergencyGrant({
        ...BASE_OPTIONS,
        status: "REQUESTED",
        waitDays: 3,
        waitExpiresInDays: 1,
      });
      const params = getParams();
      const waitExpiresAt = new Date(params[11] as string).getTime();
      const oneDay = 1 * 24 * 60 * 60 * 1000;
      expect(waitExpiresAt).toBeGreaterThanOrEqual(before + oneDay - 1000);
      expect(waitExpiresAt).toBeLessThanOrEqual(before + oneDay + 5000);
    });

    it("sets activatedAt to null", async () => {
      await seedEmergencyGrant({ ...BASE_OPTIONS, status: "REQUESTED" });
      const params = getParams();
      expect(params[10]).toBeNull();
    });
  });

  describe("status: ACTIVATED", () => {
    it("sets status to ACTIVATED", async () => {
      await seedEmergencyGrant({ ...BASE_OPTIONS, status: "ACTIVATED" });
      const params = getParams();
      expect(params[5]).toBe("ACTIVATED");
    });

    it("sets activatedAt to approximately now", async () => {
      const before = Date.now();
      await seedEmergencyGrant({ ...BASE_OPTIONS, status: "ACTIVATED" });
      const params = getParams();
      const activatedAt = new Date(params[10] as string).getTime();
      expect(activatedAt).toBeGreaterThanOrEqual(before - 1000);
      expect(activatedAt).toBeLessThanOrEqual(before + 5000);
    });

    it("sets requestedAt to approximately 1 hour ago", async () => {
      const before = Date.now();
      await seedEmergencyGrant({ ...BASE_OPTIONS, status: "ACTIVATED" });
      const params = getParams();
      const requestedAt = new Date(params[9] as string).getTime();
      const oneHour = 60 * 60 * 1000;
      expect(requestedAt).toBeLessThanOrEqual(before - oneHour + 1000);
    });

    it("sets waitExpiresAt using waitDays", async () => {
      const before = Date.now();
      await seedEmergencyGrant({
        ...BASE_OPTIONS,
        status: "ACTIVATED",
        waitDays: 5,
      });
      const params = getParams();
      const waitExpiresAt = new Date(params[11] as string).getTime();
      const fiveDays = 5 * 24 * 60 * 60 * 1000;
      expect(waitExpiresAt).toBeGreaterThanOrEqual(before + fiveDays - 1000);
      expect(waitExpiresAt).toBeLessThanOrEqual(before + fiveDays + 5000);
    });
  });

  describe("status: ACCEPTED / REVOKED / REJECTED / STALE", () => {
    it.each(["ACCEPTED", "REVOKED", "REJECTED", "STALE"] as const)(
      "sets status to %s with all state timestamps null",
      async (status) => {
        await seedEmergencyGrant({ ...BASE_OPTIONS, status });
        const params = getParams();
        expect(params[5]).toBe(status);
        expect(params[9]).toBeNull();  // requestedAt
        expect(params[10]).toBeNull(); // activatedAt
        expect(params[11]).toBeNull(); // waitExpiresAt
      }
    );
  });

  it("passes all required base fields in parameters", async () => {
    await seedEmergencyGrant({ ...BASE_OPTIONS, status: "IDLE" });
    const params = getParams();
    expect(params[0]).toBe(BASE_OPTIONS.id);
    expect(params[2]).toBe(BASE_OPTIONS.ownerId);
    expect(params[3]).toBe(BASE_OPTIONS.granteeId);
    expect(params[4]).toBe(BASE_OPTIONS.granteeEmail);
    expect(params[6]).toBe(BASE_OPTIONS.waitDays);
  });
});
