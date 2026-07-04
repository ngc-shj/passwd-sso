import { describe, it, expect, vi, beforeEach } from "vitest";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";

// ─── Hoisted mocks ───────────────────────────────────────────

const {
  mockExecuteRaw,
  mockDirSyncConfig,
  mockScimMapping,
  mockTenantMember,
  mockDirSyncLog,
  mockLogAudit,
  mockDispatchWebhook,
  mockDecryptCredentials,
  mockFetchOktaUsers,
  mockGetAzureAdToken,
  mockFetchAzureAdUsers,
  mockGetGoogleAccessToken,
  mockFetchGoogleUsers,
  applyTxHolder,
} = vi.hoisted(() => {
  return {
    mockExecuteRaw: vi.fn(),
    mockDirSyncConfig: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    mockScimMapping: { findMany: vi.fn() },
    mockTenantMember: { findMany: vi.fn() },
    mockDirSyncLog: { create: vi.fn() },
    mockLogAudit: vi.fn(),
    mockDispatchWebhook: vi.fn(),
    mockDecryptCredentials: vi.fn(),
    mockFetchOktaUsers: vi.fn(),
    mockGetAzureAdToken: vi.fn(),
    mockFetchAzureAdUsers: vi.fn(),
    mockGetGoogleAccessToken: vi.fn(),
    mockFetchGoogleUsers: vi.fn(),
    // Holds the rich apply-phase tx a test configures. The apply body (formerly
    // an inner prisma.$transaction folded into withTenantRls) now runs directly
    // on the withTenantRls callback's tx, so tests inject that tx here instead
    // of via prisma.$transaction.
    applyTxHolder: { current: null as Record<string, unknown> | null },
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $executeRaw: mockExecuteRaw,
    directorySyncConfig: mockDirSyncConfig,
    scimExternalMapping: mockScimMapping,
    tenantMember: mockTenantMember,
    directorySyncLog: mockDirSyncLog,
  },
}));

// The apply phase now runs directly on the withTenantRls callback's tx (the
// former inner prisma.$transaction was a no-op fold and is gone). Merge any
// test-configured apply-phase tx over the top-level prisma model mocks +
// $executeRaw, so every withTenantRls callback — CAS lock ($executeRaw), config
// load, mapping/member load, log create, AND the apply phase — resolves the
// methods it calls on tx.
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: vi.fn(async (prisma, _tenantId, fn) => {
    if (!applyTxHolder.current) return fn(prisma);
    // Per-model deep merge: the apply-phase tx and the top-level prisma mock
    // each supply a slice of a model's methods (e.g. the apply tx supplies
    // scimExternalMapping.upsert / user.create; prisma supplies the load-phase
    // scimExternalMapping.findMany / tenantMember.findMany). The top-level
    // prisma mock is authoritative for the read/load methods it defines, so
    // give it precedence; the apply tx fills in the write methods prisma lacks.
    const base = prisma as Record<string, unknown>;
    const overlay = applyTxHolder.current as Record<string, unknown>;
    const tx: Record<string, unknown> = { ...base };
    for (const [model, methods] of Object.entries(overlay)) {
      const baseModel = base[model];
      tx[model] =
        baseModel && typeof baseModel === "object" && methods && typeof methods === "object"
          ? { ...(methods as object), ...(baseModel as object) }
          : methods;
    }
    tx.$executeRaw = mockExecuteRaw;
    return fn(tx);
  }),
}));

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
}));

vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchTenantWebhook: mockDispatchWebhook,
}));

vi.mock("./credentials", () => ({
  decryptCredentials: mockDecryptCredentials,
}));

vi.mock("./azure-ad", () => ({
  getAzureAdToken: mockGetAzureAdToken,
  fetchAzureAdUsers: mockFetchAzureAdUsers,
}));

vi.mock("./google-workspace", () => ({
  getGoogleAccessToken: mockGetGoogleAccessToken,
  fetchGoogleUsers: mockFetchGoogleUsers,
}));

vi.mock("./okta", () => ({
  fetchOktaUsers: mockFetchOktaUsers,
}));

import { runDirectorySync } from "./engine";
import { MS_PER_HOUR } from "@/lib/constants/time";

// ─── Fixtures ────────────────────────────────────────────────

const CONFIG_ID = "config-1";
const TENANT_ID = "tenant-1";
const USER_ID = "user-actor";

const BASE_OPTIONS = {
  configId: CONFIG_ID,
  tenantId: TENANT_ID,
  userId: USER_ID,
};

/** Minimal config row returned by directorySyncConfig.findUnique */
const OKTA_CONFIG = {
  provider: "OKTA",
  encryptedCredentials: "cipher",
  credentialsIv: "iv",
  credentialsAuthTag: "tag",
  syncIntervalMinutes: 60,
};

const OKTA_CREDS_JSON = JSON.stringify({
  orgUrl: "https://example.okta.com",
  apiToken: "token",
});

/** Build a fake OKTA user for use in provider responses */
function makeOktaUser(overrides: Partial<{
  id: string;
  email: string;
  displayName: string;
  status: string;
}> = {}) {
  return {
    id: overrides.id ?? "ext-1",
    profile: {
      email: overrides.email ?? "alice@example.com",
      displayName: overrides.displayName ?? "Alice",
      firstName: "Alice",
      lastName: "Smith",
    },
    status: overrides.status ?? "ACTIVE",
  };
}

/** Build a tenant member record */
function makeMember(overrides: Partial<{
  id: string;
  userId: string;
  role: string;
  deactivatedAt: Date | null;
  name: string;
  email: string;
}> = {}) {
  const userId = overrides.userId ?? "user-1";
  return {
    id: overrides.id ?? "member-1",
    userId,
    role: overrides.role ?? "MEMBER",
    deactivatedAt: overrides.deactivatedAt ?? null,
    user: {
      id: userId,
      email: overrides.email ?? "alice@example.com",
      name: overrides.name ?? "Alice",
    },
  };
}

/** Set up the CAS lock to succeed (acquired = true, not stale) */
function setupAcquiredLock() {
  mockDirSyncConfig.findFirst.mockResolvedValue({ status: "IDLE", lastSyncAt: null });
  mockExecuteRaw.mockResolvedValue(1);
}

/** Rich apply-phase tx shape; individual tests override specific methods. */
function makeApplyTx(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
    },
    tenantMember: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    scimExternalMapping: {
      upsert: vi.fn(),
    },
    ...overrides,
  };
}

/** Register the apply-phase tx that the withTenantRls mock injects. */
function setApplyTx(tx: Record<string, unknown>) {
  applyTxHolder.current = tx;
}

/** Set up a successful apply phase with a default rich tx. */
function setupTransaction() {
  setApplyTx(makeApplyTx());
}

// ─── Tests ───────────────────────────────────────────────────

describe("runDirectorySync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyTxHolder.current = null;
    mockDirSyncLog.create.mockResolvedValue({ id: "log-1" });
    mockDirSyncConfig.update.mockResolvedValue({});
    mockDecryptCredentials.mockReturnValue(OKTA_CREDS_JSON);
  });

  // ── dryRun mode ──────────────────────────────────────────────

  describe("dryRun mode", () => {
    it("returns correct counts without writing any data", async () => {
      setupAcquiredLock();
      // Register a tracking apply-phase tx so we can assert no writes happen.
      const applyTx = makeApplyTx();
      setApplyTx(applyTx);

      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      mockFetchOktaUsers.mockResolvedValue([
        makeOktaUser({ id: "ext-1", email: "alice@example.com" }),
        makeOktaUser({ id: "ext-2", email: "bob@example.com" }),
      ]);

      // ext-1 already mapped, ext-2 is new
      mockScimMapping.findMany.mockResolvedValue([
        { externalId: "ext-1", internalId: "user-1" },
      ]);
      mockTenantMember.findMany.mockResolvedValue([
        makeMember({ userId: "user-1", name: "Different Name" }),
      ]);

      const result = await runDirectorySync({ ...BASE_OPTIONS, dryRun: true });

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.usersCreated).toBe(1);
      expect(result.usersUpdated).toBe(1);
      expect(result.usersDeactivated).toBe(0);
      // dryRun performs no writes: the apply-phase tx is never exercised.
      expect(applyTx.user.create).not.toHaveBeenCalled();
      expect(applyTx.tenantMember.create).not.toHaveBeenCalled();
      expect(applyTx.tenantMember.update).not.toHaveBeenCalled();
      expect(applyTx.tenantMember.updateMany).not.toHaveBeenCalled();
    });

    it("counts deactivations without writing", async () => {
      setupAcquiredLock();
      const applyTx = makeApplyTx();
      setApplyTx(applyTx);

      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      // Provider returns no users → all mapped members would be deactivated
      mockFetchOktaUsers.mockResolvedValue([]);
      mockScimMapping.findMany.mockResolvedValue([
        { externalId: "ext-gone", internalId: "user-1" },
      ]);
      mockTenantMember.findMany.mockResolvedValue([
        makeMember({ userId: "user-1" }),
      ]);

      // force=true so safety guard doesn't block
      const result = await runDirectorySync({ ...BASE_OPTIONS, dryRun: true, force: true });

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.usersDeactivated).toBe(1);
      // dryRun performs no writes: the batch-deactivate updateMany is never run.
      expect(applyTx.tenantMember.updateMany).not.toHaveBeenCalled();
    });
  });

  // ── Non-dryRun transaction ────────────────────────────────────

  describe("non-dryRun transaction", () => {
    it("calls tx.user.create and tx.tenantMember.create for a new provider user", async () => {
      setupAcquiredLock();

      const capturedTx = makeApplyTx({
        user: {
          findMany: vi.fn().mockResolvedValue([]), // no pre-existing users by email
          create: vi.fn().mockResolvedValue({ id: "new-user-1", email: "newuser@example.com" }),
          update: vi.fn(),
        },
        tenantMember: {
          findMany: vi.fn().mockResolvedValue([]), // no pre-existing tenant members
          create: vi.fn().mockResolvedValue({}),
          update: vi.fn(),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      }) as {
        user: { create: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
        tenantMember: { create: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
        scimExternalMapping: { upsert: ReturnType<typeof vi.fn> };
      };
      setApplyTx(capturedTx);

      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      // Provider returns one new user not yet in the system
      mockFetchOktaUsers.mockResolvedValue([
        makeOktaUser({ id: "ext-new", email: "newuser@example.com", displayName: "New User" }),
      ]);
      // No existing mappings or members
      mockScimMapping.findMany.mockResolvedValue([]);
      mockTenantMember.findMany.mockResolvedValue([]);

      const result = await runDirectorySync(BASE_OPTIONS);

      expect(result.success).toBe(true);
      // user.create must be called to create the new user
      expect(capturedTx.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ email: "newuser@example.com" }),
        }),
      );
      // tenantMember.create must be called to add the user to the tenant
      expect(capturedTx.tenantMember.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tenantId: TENANT_ID }),
        }),
      );
    });
  });

  // ── Safety guard ──────────────────────────────────────────────

  describe("safety guard", () => {
    it("aborts when deactivations exceed 20% and force=false", async () => {
      setupAcquiredLock();
      const applyTx = makeApplyTx();
      setApplyTx(applyTx);

      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      // Provider returns 1 user, 6 currently active → 5 would be deactivated (83%)
      mockFetchOktaUsers.mockResolvedValue([
        makeOktaUser({ id: "ext-1" }),
      ]);

      const activeMembers = Array.from({ length: 6 }, (_, i) => {
        const uid = `user-${i + 1}`;
        return makeMember({ id: `member-${i + 1}`, userId: uid });
      });

      mockScimMapping.findMany.mockResolvedValue(
        activeMembers.map((m, i) => ({
          externalId: `ext-${i + 1}`,
          internalId: m.userId,
        })),
      );
      mockTenantMember.findMany.mockResolvedValue(activeMembers);

      const result = await runDirectorySync({ ...BASE_OPTIONS, force: false });

      expect(result.success).toBe(false);
      expect(result.abortedSafety).toBe(true);
      expect(result.errorMessage).toMatch(/20%/);
      expect(result.logId).toBe("log-1");
      // Aborting before the apply phase means no member writes occur.
      expect(applyTx.tenantMember.updateMany).not.toHaveBeenCalled();
      expect(applyTx.tenantMember.update).not.toHaveBeenCalled();
      expect(applyTx.user.create).not.toHaveBeenCalled();
    });

    it("proceeds normally when force=true despite exceeding 20%", async () => {
      setupAcquiredLock();
      setupTransaction();

      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      mockFetchOktaUsers.mockResolvedValue([
        makeOktaUser({ id: "ext-1" }),
      ]);

      // 6 active members, 5 would be deactivated
      const activeMembers = Array.from({ length: 6 }, (_, i) =>
        makeMember({ id: `member-${i + 1}`, userId: `user-${i + 1}` }),
      );
      mockScimMapping.findMany.mockResolvedValue(
        activeMembers.map((m, i) => ({
          externalId: `ext-${i + 1}`,
          internalId: m.userId,
        })),
      );
      mockTenantMember.findMany.mockResolvedValue(activeMembers);

      const result = await runDirectorySync({ ...BASE_OPTIONS, force: true });

      expect(result.success).toBe(true);
      expect(result.abortedSafety).toBeUndefined();
    });
  });

  // ── Lock contention ───────────────────────────────────────────

  describe("lock contention", () => {
    it("returns error when lock is not acquired (acquired=false)", async () => {
      // Another sync is running → $executeRaw returns 0
      mockDirSyncConfig.findFirst.mockResolvedValue({ status: "RUNNING", lastSyncAt: new Date() });
      mockExecuteRaw.mockResolvedValue(0);

      const result = await runDirectorySync(BASE_OPTIONS);

      expect(result.success).toBe(false);
      expect(result.errorMessage).toBe("Sync already running (locked)");
    });
  });

  // ── Stale lock reset ──────────────────────────────────────────

  describe("stale lock reset", () => {
    it("resets a stale RUNNING lock and logs a DIRECTORY_SYNC_STALE_RESET audit event", async () => {
      const staleDate = new Date(Date.now() - MS_PER_HOUR); // 1 hour ago
      mockDirSyncConfig.findFirst.mockResolvedValue({
        status: "RUNNING",
        lastSyncAt: staleDate,
      });
      // CAS succeeds because lastSyncAt is before the stale threshold
      mockExecuteRaw.mockResolvedValue(1);

      setupTransaction();
      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      mockFetchOktaUsers.mockResolvedValue([]);
      mockScimMapping.findMany.mockResolvedValue([]);
      mockTenantMember.findMany.mockResolvedValue([]);

      await runDirectorySync(BASE_OPTIONS);

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "DIRECTORY_SYNC_STALE_RESET",
          tenantId: TENANT_ID,
          targetId: CONFIG_ID,
          metadata: { staleSince: staleDate },
        }),
      );
      expect(mockDispatchWebhook).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "DIRECTORY_SYNC_STALE_RESET",
          tenantId: TENANT_ID,
        }),
      );
    });

    it("does not log stale reset when previous status was not RUNNING", async () => {
      mockDirSyncConfig.findFirst.mockResolvedValue({ status: "IDLE", lastSyncAt: null });
      mockExecuteRaw.mockResolvedValue(1);

      setupTransaction();
      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      mockFetchOktaUsers.mockResolvedValue([]);
      mockScimMapping.findMany.mockResolvedValue([]);
      mockTenantMember.findMany.mockResolvedValue([]);

      await runDirectorySync(BASE_OPTIONS);

      expect(mockLogAudit).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "DIRECTORY_SYNC_STALE_RESET" }),
      );
    });
  });

  // ── Batch deactivation with OWNER exclusion ───────────────────

  describe("batch deactivation with OWNER exclusion", () => {
    it("does not deactivate OWNER members even when they disappear from the provider", async () => {
      setupAcquiredLock();
      setupTransaction();

      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      // Provider returns no users at all
      mockFetchOktaUsers.mockResolvedValue([]);

      const owner = makeMember({ id: "member-owner", userId: "user-owner", role: "OWNER" });
      const regular = makeMember({ id: "member-regular", userId: "user-regular", role: "MEMBER" });

      mockScimMapping.findMany.mockResolvedValue([
        { externalId: "ext-owner", internalId: "user-owner" },
        { externalId: "ext-regular", internalId: "user-regular" },
      ]);
      mockTenantMember.findMany.mockResolvedValue([owner, regular]);

      // Capture the updateMany call to verify OWNER is excluded
      let updateManyWhere: unknown;
      setApplyTx(makeApplyTx({
        tenantMember: {
          findMany: vi.fn().mockResolvedValue([]),
          create: vi.fn(),
          update: vi.fn(),
          updateMany: vi.fn().mockImplementation((args: unknown) => {
            updateManyWhere = args;
            return Promise.resolve({ count: 1 });
          }),
        },
      }));

      const result = await runDirectorySync({ ...BASE_OPTIONS, force: true });

      expect(result.success).toBe(true);
      // The updateMany WHERE clause must include role: { not: "OWNER" }
      expect(updateManyWhere).toMatchObject({
        where: expect.objectContaining({
          role: { not: "OWNER" },
        }),
      });
    });
  });

  // ── OWNER protection in toUpdate ──────────────────────────────

  describe("toUpdate OWNER protection", () => {
    it("updates name but skips deactivation when IdP sets active=false for an OWNER", async () => {
      setupAcquiredLock();

      let userUpdateArgs: unknown;
      let tenantMemberUpdateArgs: unknown;

      setApplyTx(makeApplyTx({
        user: {
          findMany: vi.fn().mockResolvedValue([]),
          create: vi.fn(),
          update: vi.fn().mockImplementation((args: unknown) => {
            userUpdateArgs = args;
            return Promise.resolve({});
          }),
        },
        tenantMember: {
          findMany: vi.fn().mockResolvedValue([]),
          create: vi.fn(),
          update: vi.fn().mockImplementation((args: unknown) => {
            tenantMemberUpdateArgs = args;
            return Promise.resolve({});
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      }));

      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);

      // Provider sends the OWNER as inactive with an updated name
      mockFetchOktaUsers.mockResolvedValue([
        {
          id: "ext-owner",
          profile: {
            email: "owner@example.com",
            displayName: "Owner New Name",
            firstName: "Owner",
            lastName: "User",
          },
          status: "SUSPENDED", // active = false
        },
      ]);

      const owner = makeMember({
        id: "member-owner",
        userId: "user-owner",
        role: "OWNER",
        email: "owner@example.com",
        name: "Owner Old Name",
      });

      mockScimMapping.findMany.mockResolvedValue([
        { externalId: "ext-owner", internalId: "user-owner" },
      ]);
      mockTenantMember.findMany.mockResolvedValue([owner]);

      const result = await runDirectorySync(BASE_OPTIONS);

      expect(result.success).toBe(true);
      // Name should be updated
      expect(userUpdateArgs).toMatchObject({
        where: { id: "user-owner" },
        data: { name: "Owner New Name" },
      });
      // usersUpdated should be 1 (skipped deactivation but still counted)
      expect(result.usersUpdated).toBe(1);
      // tenantMember.update must NOT have been called with deactivatedAt for the OWNER
      expect(tenantMemberUpdateArgs).not.toMatchObject({
        data: expect.objectContaining({ deactivatedAt: expect.any(Date) }),
      });
    });
  });

  // ── User reactivation ─────────────────────────────────────────

  describe("user reactivation", () => {
    it("reactivates a deactivated user who reappears as active in the provider", async () => {
      setupAcquiredLock();

      let tenantMemberUpdateArgs: unknown;

      setApplyTx(makeApplyTx({
        tenantMember: {
          findMany: vi.fn().mockResolvedValue([]),
          create: vi.fn(),
          update: vi.fn().mockImplementation((args: unknown) => {
            tenantMemberUpdateArgs = args;
            return Promise.resolve({});
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      }));

      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);

      // Provider sends the user as active
      mockFetchOktaUsers.mockResolvedValue([
        makeOktaUser({ id: "ext-1", email: "alice@example.com", displayName: "Alice", status: "ACTIVE" }),
      ]);

      // User has an existing mapping but is currently deactivated
      const deactivatedMember = makeMember({
        id: "member-1",
        userId: "user-1",
        role: "MEMBER",
        deactivatedAt: new Date("2025-01-01"),
        email: "alice@example.com",
        name: "Alice",
      });

      mockScimMapping.findMany.mockResolvedValue([
        { externalId: "ext-1", internalId: "user-1" },
      ]);
      mockTenantMember.findMany.mockResolvedValue([deactivatedMember]);

      const result = await runDirectorySync(BASE_OPTIONS);

      expect(result.success).toBe(true);
      // usersUpdated increments when an existing user's status or name changed
      expect(result.usersUpdated).toBe(1);
      // tenantMember.update must have been called with deactivatedAt: null to reactivate
      expect(tenantMemberUpdateArgs).toMatchObject({
        where: { id: "member-1" },
        data: expect.objectContaining({ deactivatedAt: null }),
      });
    });
  });

  // ── Error propagation ─────────────────────────────────────────

  describe("error propagation", () => {
    it("returns error result when provider fetch throws", async () => {
      setupAcquiredLock();

      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      mockFetchOktaUsers.mockRejectedValue(new Error("Network timeout"));
      mockScimMapping.findMany.mockResolvedValue([]);
      mockTenantMember.findMany.mockResolvedValue([]);

      const result = await runDirectorySync(BASE_OPTIONS);

      expect(result.success).toBe(false);
      expect(result.errorMessage).toContain("Network timeout");
      // Error log should be created
      expect(mockDirSyncLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "ERROR" }),
        }),
      );
    });

    it("returns error result when config is not found", async () => {
      setupAcquiredLock();

      mockDirSyncConfig.findUnique.mockResolvedValue(null);

      const result = await runDirectorySync(BASE_OPTIONS);

      expect(result.success).toBe(false);
      expect(result.errorMessage).toContain("not found");
    });

    it("returns error result when lock acquisition itself throws", async () => {
      mockDirSyncConfig.findFirst.mockRejectedValue(new Error("DB connection lost"));

      const result = await runDirectorySync(BASE_OPTIONS);

      expect(result.success).toBe(false);
      expect(result.errorMessage).toContain("DB connection lost");
    });
  });

  // T3.3: actorUserId ?? SYSTEM_ACTOR_ID fallback in logAuditAsync calls
  describe("sentinel fallback: actorUserId ?? SYSTEM_ACTOR_ID", () => {
    it("uses SYSTEM_ACTOR_ID with SYSTEM actorType when userId is omitted from options", async () => {
      const staleDate = new Date(Date.now() - MS_PER_HOUR);
      mockDirSyncConfig.findFirst.mockResolvedValue({
        status: "RUNNING",
        lastSyncAt: staleDate,
      });
      mockExecuteRaw.mockResolvedValue(1);
      setupTransaction();
      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      mockFetchOktaUsers.mockResolvedValue([]);
      mockScimMapping.findMany.mockResolvedValue([]);
      mockTenantMember.findMany.mockResolvedValue([]);

      // Run without userId to trigger SYSTEM_ACTOR_ID fallback
      await runDirectorySync({ configId: CONFIG_ID, tenantId: TENANT_ID });

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "DIRECTORY_SYNC_STALE_RESET",
          userId: SYSTEM_ACTOR_ID,
          actorType: "SYSTEM",
        }),
      );
    });

    it("uses provided userId with HUMAN actorType when userId is present", async () => {
      const staleDate = new Date(Date.now() - MS_PER_HOUR);
      mockDirSyncConfig.findFirst.mockResolvedValue({
        status: "RUNNING",
        lastSyncAt: staleDate,
      });
      mockExecuteRaw.mockResolvedValue(1);
      setupTransaction();
      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      mockFetchOktaUsers.mockResolvedValue([]);
      mockScimMapping.findMany.mockResolvedValue([]);
      mockTenantMember.findMany.mockResolvedValue([]);

      await runDirectorySync(BASE_OPTIONS);

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "DIRECTORY_SYNC_STALE_RESET",
          userId: USER_ID,
          actorType: "HUMAN",
        }),
      );
    });
  });
});

