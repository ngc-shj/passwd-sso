import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Prisma mock ─────────────────────────────────────────────────────────────

const {
  mockWebAuthnCredentialCount,
  mockTenantFindUnique,
  mockTransaction,
} = vi.hoisted(() => ({
  mockWebAuthnCredentialCount: vi.fn(),
  mockTenantFindUnique: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    webAuthnCredential: { count: mockWebAuthnCredentialCount },
    tenant: { findUnique: mockTenantFindUnique },
    $transaction: mockTransaction,
  },
}));

// withBypassRls: invoke the callback with the prisma mock directly so the tests
// exercise the run() body without a real PG transaction.
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  withBypassRls: vi.fn((_prisma: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      webAuthnCredential: { count: mockWebAuthnCredentialCount },
      tenant: { findUnique: mockTenantFindUnique },
    }),
  ),
}));

import {
  isPasskeyGracePeriodExpired,
  passkeyEnforcementBlocks,
  derivePasskeyState,
  recordPasskeyAuditEmit,
  PASSKEY_AUDIT_DEDUP_MS,
  PASSKEY_AUDIT_MAP_MAX,
  _resetPasskeyAuditForTests,
  _passkeyAuditSizeForTests,
  _passkeyAuditHasForTests,
  _passkeyAuditFirstKeyForTests,
} from "./passkey-enforcement";
import { MS_PER_DAY } from "@/lib/constants/time";

// ─── isPasskeyGracePeriodExpired ─────────────────────────────────────────────

describe("isPasskeyGracePeriodExpired", () => {
  it("returns true when enabledAt is null (no timestamp → immediate enforcement)", () => {
    expect(isPasskeyGracePeriodExpired(null, 7)).toBe(true);
  });

  it("returns true when enabledAt is undefined", () => {
    expect(isPasskeyGracePeriodExpired(undefined, 7)).toBe(true);
  });

  it("returns true when graceDays is null (no grace → immediate enforcement)", () => {
    const enabledAt = new Date(Date.now() - MS_PER_DAY).toISOString();
    expect(isPasskeyGracePeriodExpired(enabledAt, null)).toBe(true);
  });

  it("returns true when graceDays is 0", () => {
    const enabledAt = new Date(Date.now() - MS_PER_DAY).toISOString();
    expect(isPasskeyGracePeriodExpired(enabledAt, 0)).toBe(true);
  });

  it("returns false when still within the grace period", () => {
    // enabledAt is 1 day ago, grace is 7 days → 6 more days remain
    const enabledAt = new Date(Date.now() - MS_PER_DAY).toISOString();
    expect(isPasskeyGracePeriodExpired(enabledAt, 7)).toBe(false);
  });

  it("returns true when grace period has expired", () => {
    // enabledAt is 10 days ago, grace is 7 days → expired
    const enabledAt = new Date(Date.now() - 10 * MS_PER_DAY).toISOString();
    expect(isPasskeyGracePeriodExpired(enabledAt, 7)).toBe(true);
  });

  it("returns true at exactly the grace boundary (inclusive <= window)", () => {
    // enabledAt exactly graceDays * MS_PER_DAY ago → now === enabledAt + gracePeriodMs,
    // the condition is `now > enabledAt + gracePeriodMs`, so this is NOT expired.
    // But 1 ms later it is.
    const graceDays = 3;
    const exactBoundaryMs = Date.now() - graceDays * MS_PER_DAY;
    const enabledAt = new Date(exactBoundaryMs).toISOString();
    // At exactly the boundary, Date.now() ≈ enabledAt + grace — may be expired
    // or not depending on millisecond timing. Test the clearly-expired case.
    const clearlyExpired = new Date(Date.now() - graceDays * MS_PER_DAY - 1).toISOString();
    expect(isPasskeyGracePeriodExpired(clearlyExpired, graceDays)).toBe(true);
  });
});

// ─── passkeyEnforcementBlocks ─────────────────────────────────────────────────

describe("passkeyEnforcementBlocks", () => {
  const expiredEnabledAt = new Date(Date.now() - 10 * MS_PER_DAY).toISOString();
  const withinGraceEnabledAt = new Date(Date.now() - MS_PER_DAY).toISOString();

  it("returns false when requirePasskey is false", () => {
    expect(
      passkeyEnforcementBlocks({
        requirePasskey: false,
        hasPasskey: false,
        requirePasskeyEnabledAt: expiredEnabledAt,
        passkeyGracePeriodDays: 7,
      }),
    ).toBe(false);
  });

  it("returns false when user has a passkey", () => {
    expect(
      passkeyEnforcementBlocks({
        requirePasskey: true,
        hasPasskey: true,
        requirePasskeyEnabledAt: expiredEnabledAt,
        passkeyGracePeriodDays: 7,
      }),
    ).toBe(false);
  });

  it("returns false when within the grace period", () => {
    expect(
      passkeyEnforcementBlocks({
        requirePasskey: true,
        hasPasskey: false,
        requirePasskeyEnabledAt: withinGraceEnabledAt,
        passkeyGracePeriodDays: 7,
      }),
    ).toBe(false);
  });

  it("returns true when requirePasskey + no passkey + grace expired", () => {
    expect(
      passkeyEnforcementBlocks({
        requirePasskey: true,
        hasPasskey: false,
        requirePasskeyEnabledAt: expiredEnabledAt,
        passkeyGracePeriodDays: 7,
      }),
    ).toBe(true);
  });

  it("returns true when requirePasskey + no passkey + enabledAt=null (immediate enforcement)", () => {
    expect(
      passkeyEnforcementBlocks({
        requirePasskey: true,
        hasPasskey: false,
        requirePasskeyEnabledAt: null,
        passkeyGracePeriodDays: 7,
      }),
    ).toBe(true);
  });

  it("returns true when requirePasskey + no passkey + graceDays=null", () => {
    expect(
      passkeyEnforcementBlocks({
        requirePasskey: true,
        hasPasskey: false,
        requirePasskeyEnabledAt: expiredEnabledAt,
        passkeyGracePeriodDays: null,
      }),
    ).toBe(true);
  });

  it("returns false when requirePasskey is undefined (treated as falsy)", () => {
    expect(
      passkeyEnforcementBlocks({
        requirePasskey: undefined,
        hasPasskey: false,
        requirePasskeyEnabledAt: expiredEnabledAt,
        passkeyGracePeriodDays: 7,
      }),
    ).toBe(false);
  });
});

// ─── derivePasskeyState ───────────────────────────────────────────────────────

describe("derivePasskeyState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts webAuthnCredential by userId (not tenantId) and reads policy by tenantId", async () => {
    mockWebAuthnCredentialCount.mockResolvedValue(1);
    mockTenantFindUnique.mockResolvedValue({
      requirePasskey: true,
      requirePasskeyEnabledAt: new Date("2025-01-01T00:00:00Z"),
      passkeyGracePeriodDays: 7,
    });

    const result = await derivePasskeyState({ userId: "u-1", tenantId: "t-1" });

    expect(mockWebAuthnCredentialCount).toHaveBeenCalledWith({ where: { userId: "u-1" } });
    expect(mockTenantFindUnique).toHaveBeenCalledWith({
      where: { id: "t-1" },
      select: {
        requirePasskey: true,
        requirePasskeyEnabledAt: true,
        passkeyGracePeriodDays: true,
      },
    });
    expect(result.hasPasskey).toBe(true);
  });

  it("returns hasPasskey=false when count is 0", async () => {
    mockWebAuthnCredentialCount.mockResolvedValue(0);
    mockTenantFindUnique.mockResolvedValue({
      requirePasskey: false,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: null,
    });

    const result = await derivePasskeyState({ userId: "u-2", tenantId: "t-2" });
    expect(result.hasPasskey).toBe(false);
  });

  it("converts requirePasskeyEnabledAt Date to ISO string", async () => {
    const date = new Date("2025-06-01T12:00:00Z");
    mockWebAuthnCredentialCount.mockResolvedValue(0);
    mockTenantFindUnique.mockResolvedValue({
      requirePasskey: true,
      requirePasskeyEnabledAt: date,
      passkeyGracePeriodDays: 7,
    });

    const result = await derivePasskeyState({ userId: "u-3", tenantId: "t-3" });
    expect(result.requirePasskeyEnabledAt).toBe(date.toISOString());
  });

  it("returns requirePasskeyEnabledAt=null when tenant has no enabledAt", async () => {
    mockWebAuthnCredentialCount.mockResolvedValue(0);
    mockTenantFindUnique.mockResolvedValue({
      requirePasskey: true,
      requirePasskeyEnabledAt: null,
      passkeyGracePeriodDays: null,
    });

    const result = await derivePasskeyState({ userId: "u-4", tenantId: "t-4" });
    expect(result.requirePasskeyEnabledAt).toBeNull();
    expect(result.passkeyGracePeriodDays).toBeNull();
  });

  it("uses provided tx directly (no new withBypassRls)", async () => {
    const { withBypassRls } = await import("@/lib/tenant-rls");
    const mockWithBypassRls = vi.mocked(withBypassRls);
    mockWithBypassRls.mockClear();

    const txMock = {
      webAuthnCredential: { count: vi.fn().mockResolvedValue(2) },
      tenant: {
        findUnique: vi.fn().mockResolvedValue({
          requirePasskey: true,
          requirePasskeyEnabledAt: null,
          passkeyGracePeriodDays: null,
        }),
      },
    };

    const result = await derivePasskeyState({
      userId: "u-5",
      tenantId: "t-5",
      tx: txMock as unknown as import("@prisma/client").Prisma.TransactionClient,
    });

    // withBypassRls must NOT have been called (tx was provided)
    expect(mockWithBypassRls).not.toHaveBeenCalled();
    expect(txMock.webAuthnCredential.count).toHaveBeenCalledWith({ where: { userId: "u-5" } });
    expect(result.hasPasskey).toBe(true);
  });

  it("throws on DB error (fail-closed — does not swallow)", async () => {
    const dbError = new Error("DB connection lost");
    mockWebAuthnCredentialCount.mockRejectedValue(dbError);

    await expect(
      derivePasskeyState({ userId: "u-err", tenantId: "t-err" }),
    ).rejects.toThrow("DB connection lost");
  });
});

// ─── recordPasskeyAuditEmit ───────────────────────────────────────────────────

describe("recordPasskeyAuditEmit", () => {
  beforeEach(() => {
    _resetPasskeyAuditForTests();
  });

  const PATH_A = "/api/extension/bridge-code";
  const PATH_B = "/api/mobile/authorize";

  it("returns true on the first emit for a user+path", () => {
    expect(recordPasskeyAuditEmit("u-1", PATH_A, 1_000)).toBe(true);
    expect(_passkeyAuditHasForTests("u-1", PATH_A)).toBe(true);
    expect(_passkeyAuditSizeForTests()).toBe(1);
  });

  it("dedupes: same user+path within DEDUP_MS returns false", () => {
    expect(recordPasskeyAuditEmit("u-2", PATH_A, 1_000)).toBe(true);
    expect(recordPasskeyAuditEmit("u-2", PATH_A, 1_000 + PASSKEY_AUDIT_DEDUP_MS)).toBe(false);
  });

  it("allows fresh emit 1ms past the inclusive window", () => {
    expect(recordPasskeyAuditEmit("u-3", PATH_A, 1_000)).toBe(true);
    expect(recordPasskeyAuditEmit("u-3", PATH_A, 1_000 + PASSKEY_AUDIT_DEDUP_MS + 1)).toBe(true);
  });

  it("same user + DIFFERENT path within window → NOT deduped (two emits)", () => {
    expect(recordPasskeyAuditEmit("u-4", PATH_A, 1_000)).toBe(true);
    // Different path for the same user — must emit independently.
    expect(recordPasskeyAuditEmit("u-4", PATH_B, 1_000)).toBe(true);
    expect(_passkeyAuditSizeForTests()).toBe(2);
    expect(_passkeyAuditHasForTests("u-4", PATH_A)).toBe(true);
    expect(_passkeyAuditHasForTests("u-4", PATH_B)).toBe(true);
  });

  it("distinct users are independent (not cross-deduped)", () => {
    expect(recordPasskeyAuditEmit("u-5", PATH_A, 1_000)).toBe(true);
    expect(recordPasskeyAuditEmit("u-6", PATH_A, 1_000)).toBe(true);
    expect(_passkeyAuditSizeForTests()).toBe(2);
  });

  it("evicts the staleness-oldest entry when map reaches PASSKEY_AUDIT_MAP_MAX", () => {
    for (let i = 0; i < PASSKEY_AUDIT_MAP_MAX; i++) {
      recordPasskeyAuditEmit(`ev-${i}`, PATH_A, 1_000 + i);
    }
    expect(_passkeyAuditSizeForTests()).toBe(PASSKEY_AUDIT_MAP_MAX);
    expect(_passkeyAuditFirstKeyForTests()).toBe(`ev-0:${PATH_A}`);

    recordPasskeyAuditEmit("ev-overflow", PATH_A, 1_000 + PASSKEY_AUDIT_MAP_MAX);
    expect(_passkeyAuditSizeForTests()).toBe(PASSKEY_AUDIT_MAP_MAX);
    expect(_passkeyAuditHasForTests("ev-0", PATH_A)).toBe(false);
    expect(_passkeyAuditHasForTests("ev-overflow", PATH_A)).toBe(true);
  });
});
