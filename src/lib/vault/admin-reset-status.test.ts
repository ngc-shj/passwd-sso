import { describe, it, expect } from "vitest";
import {
  deriveResetStatus,
  STATUS_KEY_MAP,
  type ResetStatus,
} from "@/lib/vault/admin-reset-status";

const NOW = new Date("2026-04-30T12:00:00Z");
const PAST = new Date("2026-04-30T11:00:00Z");
const FUTURE = new Date("2026-04-30T13:00:00Z");

describe("deriveResetStatus", () => {
  it("returns 'pending_approval' when no timestamp is set", () => {
    expect(
      deriveResetStatus(
        {
          approvedAt: null,
          executedAt: null,
          revokedAt: null,
          expiresAt: FUTURE,
        },
        NOW,
      ),
    ).toBe("pending_approval");
  });

  it("returns 'approved' when approvedAt is set and not yet executed/revoked/expired", () => {
    expect(
      deriveResetStatus(
        {
          approvedAt: PAST,
          executedAt: null,
          revokedAt: null,
          expiresAt: FUTURE,
        },
        NOW,
      ),
    ).toBe("approved");
  });

  it("returns 'expired' when expiresAt is past and not yet executed/revoked", () => {
    expect(
      deriveResetStatus(
        {
          approvedAt: null,
          executedAt: null,
          revokedAt: null,
          expiresAt: PAST,
        },
        NOW,
      ),
    ).toBe("expired");
  });

  it("returns 'revoked' when revokedAt is set and executedAt is null", () => {
    expect(
      deriveResetStatus(
        {
          approvedAt: PAST,
          executedAt: null,
          revokedAt: PAST,
          expiresAt: FUTURE,
        },
        NOW,
      ),
    ).toBe("revoked");
  });

  it("returns 'executed' when executedAt is set", () => {
    expect(
      deriveResetStatus(
        {
          approvedAt: PAST,
          executedAt: PAST,
          revokedAt: null,
          expiresAt: FUTURE,
        },
        NOW,
      ),
    ).toBe("executed");
  });

  // Precedence (highest to lowest): executed > revoked > expired > approved > pending_approval

  it("executed wins over revoked", () => {
    expect(
      deriveResetStatus(
        {
          approvedAt: PAST,
          executedAt: PAST,
          revokedAt: PAST,
          expiresAt: FUTURE,
        },
        NOW,
      ),
    ).toBe("executed");
  });

  it("executed wins over expired", () => {
    expect(
      deriveResetStatus(
        {
          approvedAt: PAST,
          executedAt: PAST,
          revokedAt: null,
          expiresAt: PAST,
        },
        NOW,
      ),
    ).toBe("executed");
  });

  it("revoked wins over expired", () => {
    expect(
      deriveResetStatus(
        {
          approvedAt: PAST,
          executedAt: null,
          revokedAt: PAST,
          expiresAt: PAST,
        },
        NOW,
      ),
    ).toBe("revoked");
  });

  it("expired wins over approved", () => {
    expect(
      deriveResetStatus(
        {
          approvedAt: PAST,
          executedAt: null,
          revokedAt: null,
          expiresAt: PAST,
        },
        NOW,
      ),
    ).toBe("expired");
  });

  it("treats expiresAt exactly equal to now as expired", () => {
    expect(
      deriveResetStatus(
        {
          approvedAt: null,
          executedAt: null,
          revokedAt: null,
          expiresAt: NOW,
        },
        NOW,
      ),
    ).toBe("expired");
  });
});

describe("STATUS_KEY_MAP", () => {
  it("maps every ResetStatus value to a translation key", () => {
    const expected: Record<ResetStatus, string> = {
      pending_approval: "statusPendingApproval",
      approved: "statusApproved",
      executed: "statusExecuted",
      revoked: "statusRevoked",
      expired: "statusExpired",
    };
    expect(STATUS_KEY_MAP).toEqual(expected);
  });

  it("has exactly five entries (no extras)", () => {
    expect(Object.keys(STATUS_KEY_MAP)).toHaveLength(5);
  });
});
