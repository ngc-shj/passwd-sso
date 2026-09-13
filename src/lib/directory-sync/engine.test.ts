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
  mockLogAuditBulk,
  mockDispatchWebhook,
  mockDecryptCredentials,
  mockFetchOktaUsers,
  mockGetAzureAdToken,
  mockFetchAzureAdUsers,
  mockGetGoogleAccessToken,
  mockFetchGoogleUsers,
  applyTxHolder,
  mockLoadUser,
  memberNames,
  mockRealignAfterActivation,
  mockLoggerError,
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
    mockLogAuditBulk: vi.fn(),
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
    // The load phase's read of the users this tenant context can see. Answers by
    // query from `memberNames`, which `makeMember` fills — a member built with
    // `visible: false` is one whose users row RLS hides, so it is absent here.
    mockLoadUser: { findMany: vi.fn() },
    memberNames: new Map<string, string>(),
    mockRealignAfterActivation: vi.fn(),
    mockLoggerError: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $executeRaw: mockExecuteRaw,
    directorySyncConfig: mockDirSyncConfig,
    scimExternalMapping: mockScimMapping,
    tenantMember: mockTenantMember,
    directorySyncLog: mockDirSyncLog,
    user: mockLoadUser,
  },
}));

// The apply phase now runs directly on the withTenantRls callback's tx (the
// former inner prisma.$transaction was a no-op fold and is gone). Merge any
// test-configured apply-phase tx over the top-level prisma model mocks +
// $executeRaw, so every withTenantRls callback — CAS lock ($executeRaw), config
// load, mapping/member load, log create, AND the apply phase — resolves the
// methods it calls on tx.
const mockGuardFindMany = vi.fn().mockResolvedValue([]);
// The email lookup `existingUserIdsByEmail` runs on the same bypass client.
const mockGuardUserFindMany = vi.fn().mockResolvedValue([]);

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
  // The cross-tenant reactivation guard opens its own bypass BEFORE the tenant
  // context. It gets its OWN client rather than the shared prisma mock: both
  // query `tenantMember.findMany`, and handing over the shared one made the
  // guard read the LOAD phase's own-tenant members as "active elsewhere" and
  // refuse every reactivation. Defaults to [] — nobody active elsewhere, the
  // state every pre-existing cell assumes; `mockGuardFindMany` is the seam for a
  // cell that wants the guard to fire.
  withBypassRls: vi.fn(async (_prisma: unknown, fn: (tx: unknown) => unknown) =>
    fn({ tenantMember: { findMany: mockGuardFindMany }, user: { findMany: mockGuardUserFindMany } }),
  ),
}));

vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  logAuditBulkAsync: mockLogAuditBulk,
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

vi.mock("@/lib/tenant/tenant-realignment", () => ({
  realignAfterActivation: mockRealignAfterActivation,
}));

vi.mock("@/lib/logger", async (importOriginal) => ({
  ...(await importOriginal()) as Record<string, unknown>,
  getLogger: () => ({ error: mockLoggerError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
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
  /** false: the users row is filed under another tenant, so this context cannot see it. */
  visible: boolean;
}> = {}) {
  const userId = overrides.userId ?? "user-1";
  if (overrides.visible !== false) memberNames.set(userId, overrides.name ?? "Alice");
  return {
    id: overrides.id ?? "member-1",
    userId,
    role: overrides.role ?? "MEMBER",
    deactivatedAt: overrides.deactivatedAt ?? null,
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
    // `clearAllMocks` clears calls, not implementations, so a cell that makes the
    // cross-tenant guard fire would leak that state into every cell after it.
    mockGuardFindMany.mockResolvedValue([]);
    mockGuardUserFindMany.mockResolvedValue([]);
    memberNames.clear();
    mockLoadUser.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.filter((id) => memberNames.has(id)).map((id) => ({ id, name: memberNames.get(id) })),
    );
    mockRealignAfterActivation.mockResolvedValue(null);
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

    it("predicts the refusals the real run will make", async () => {
      // The preview skipped the cross-tenant guard entirely, so it reported the
      // reactivation it would not get: the operator approved a run that then
      // left the user deactivated.
      setupAcquiredLock();
      const applyTx = makeApplyTx();
      setApplyTx(applyTx);

      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      mockFetchOktaUsers.mockResolvedValue([
        makeOktaUser({ id: "ext-1", email: "alice@example.com", displayName: "Alice", status: "ACTIVE" }),
      ]);
      mockScimMapping.findMany.mockResolvedValue([
        { externalId: "ext-1", internalId: "user-1" },
      ]);
      mockTenantMember.findMany.mockResolvedValue([
        makeMember({
          id: "member-1",
          userId: "user-1",
          role: "MEMBER",
          deactivatedAt: new Date("2025-01-01"),
          email: "alice@example.com",
          name: "Alice",
        }),
      ]);
      mockGuardFindMany.mockResolvedValue([
        { userId: "user-1", user: { email: "alice@example.com" } },
      ]);

      const result = await runDirectorySync({ ...BASE_OPTIONS, dryRun: true });

      expect(result.usersRefused).toBe(1);
      // Still a preview: the guard is a read, and nothing was written.
      expect(applyTx.tenantMember.update).not.toHaveBeenCalled();
      expect(mockLogAuditBulk).not.toHaveBeenCalled();
    });

    it("predicts the refusal for a user the run will create", async () => {
      // The toCreate clause of the preview's count. Every other dry-run fixture
      // seeds a SCIM mapping, so all users landed in toUpdate and this clause could
      // be replaced by 0 with the suite green.
      setupAcquiredLock();
      const applyTx = makeApplyTx();
      setApplyTx(applyTx);

      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      mockFetchOktaUsers.mockResolvedValue([
        makeOktaUser({ id: "ext-9", email: "carol@example.com", displayName: "Carol", status: "ACTIVE" }),
      ]);
      mockScimMapping.findMany.mockResolvedValue([]);
      mockTenantMember.findMany.mockResolvedValue([]);
      mockGuardFindMany.mockResolvedValue([
        { userId: "user-9", user: { email: "carol@example.com" } },
      ]);

      const result = await runDirectorySync({ ...BASE_OPTIONS, dryRun: true });

      expect(result.usersCreated).toBe(1);
      expect(result.usersRefused).toBe(1);
      // Still a preview: a cell that ran the apply phase instead cannot pass.
      expect(applyTx.tenantMember.create).not.toHaveBeenCalled();
    });

    it("predicts no refusal for a user the IdP sent inactive", async () => {
      // The `pu.active` conjunct: the guard fires on this user, but the run would
      // create the membership deactivated anyway, so nothing is declined.
      setupAcquiredLock();
      setApplyTx(makeApplyTx());

      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      mockFetchOktaUsers.mockResolvedValue([
        makeOktaUser({ id: "ext-9", email: "carol@example.com", displayName: "Carol", status: "SUSPENDED" }),
      ]);
      mockScimMapping.findMany.mockResolvedValue([]);
      mockTenantMember.findMany.mockResolvedValue([]);
      mockGuardFindMany.mockResolvedValue([
        { userId: "user-9", user: { email: "carol@example.com" } },
      ]);

      const result = await runDirectorySync({ ...BASE_OPTIONS, dryRun: true });

      expect(result.usersCreated).toBe(1);
      expect(result.usersRefused).toBe(0);
    });

    it("predicts no refusal when the guard clears everyone", async () => {
      // The zero the cell above is measured against. Without it, a preview that
      // reported every reactivation as refused would satisfy it too.
      setupAcquiredLock();
      setApplyTx(makeApplyTx());

      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      mockFetchOktaUsers.mockResolvedValue([
        makeOktaUser({ id: "ext-1", email: "alice@example.com", displayName: "Alice", status: "ACTIVE" }),
      ]);
      mockScimMapping.findMany.mockResolvedValue([
        { externalId: "ext-1", internalId: "user-1" },
      ]);
      mockTenantMember.findMany.mockResolvedValue([
        makeMember({
          id: "member-1",
          userId: "user-1",
          role: "MEMBER",
          deactivatedAt: new Date("2025-01-01"),
          email: "alice@example.com",
          name: "Alice",
        }),
      ]);

      const result = await runDirectorySync({ ...BASE_OPTIONS, dryRun: true });

      expect(result.usersUpdated).toBe(1);
      expect(result.usersRefused).toBe(0);
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
      // A user this run created is filed under this tenant already.
      expect(mockRealignAfterActivation).not.toHaveBeenCalled();
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
    it("creates the membership DEACTIVATED when the user is active in another tenant", async () => {
      // The create arm consulted no guard, although `activeElsewhere.emails` was
      // built from exactly `toCreate`'s emails. Creating an ACTIVE membership
      // here is the same second-active-membership the reactivate arm below
      // refuses, reached by a different verb. The row is still created — the
      // mapping has to land, and a later legitimate reactivation needs a row.
      setupAcquiredLock();

      let createArgs: unknown;
      const userCreate = vi.fn();
      setApplyTx(makeApplyTx({
        user: {
          findMany: vi.fn(),
          create: userCreate,
          update: vi.fn(),
        },
        tenantMember: {
          findMany: vi.fn().mockResolvedValue([]),
          create: vi.fn().mockImplementation((args: unknown) => {
            createArgs = args;
            return Promise.resolve({});
          }),
          update: vi.fn(),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      }));

      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      mockFetchOktaUsers.mockResolvedValue([
        makeOktaUser({ id: "ext-9", email: "carol@example.com", displayName: "Carol", status: "ACTIVE" }),
      ]);
      mockScimMapping.findMany.mockResolvedValue([]);
      mockTenantMember.findMany.mockResolvedValue([]);
      mockGuardFindMany.mockResolvedValue([
        { userId: "user-9", user: { email: "carol@example.com" } },
      ]);

      // The user exists — filed under the tenant they are active in. Resolved
      // before the context opens: inside it they are invisible, and creating them
      // again failed on users_email_key and rolled back the run.
      mockGuardUserFindMany.mockResolvedValue([{ id: "user-9", email: "carol@example.com" }]);

      const result = await runDirectorySync(BASE_OPTIONS);

      expect(result.success).toBe(true);
      expect(userCreate).not.toHaveBeenCalled();
      expect(createArgs).toMatchObject({
        data: expect.objectContaining({ userId: "user-9", deactivatedAt: expect.any(Date) }),
      });
      expect(mockRealignAfterActivation).not.toHaveBeenCalled();
    });

    it("refuses to reactivate a user who is active in another tenant", async () => {
      // The cross-tenant guard the create path in `api/scim/v2/Users` has and
      // this arm did not. The principal is this tenant's directory-sync config —
      // no authority in the tenant the user actually belongs to — and two active
      // memberships makes `resolveUserTenantId` throw on every request through
      // the proxy auth gate, so reactivating here invalidates that user's
      // sessions in the tenant they do belong to.
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
      mockFetchOktaUsers.mockResolvedValue([
        makeOktaUser({ id: "ext-1", email: "alice@example.com", displayName: "Alice", status: "ACTIVE" }),
      ]);
      mockScimMapping.findMany.mockResolvedValue([
        { externalId: "ext-1", internalId: "user-1" },
      ]);
      mockTenantMember.findMany.mockResolvedValue([
        makeMember({
          id: "member-1",
          userId: "user-1",
          role: "MEMBER",
          deactivatedAt: new Date("2025-01-01"),
          email: "alice@example.com",
          name: "Alice",
        }),
      ]);
      // The guard's own read: this user IS active somewhere else.
      mockGuardFindMany.mockResolvedValue([
        { userId: "user-1", user: { email: "alice@example.com" } },
      ]);

      const result = await runDirectorySync(BASE_OPTIONS);

      // Positive first: the run succeeded. A sync that aborted would leave the
      // membership deactivated too, for an entirely different reason.
      expect(result.success).toBe(true);
      // The membership keeps the deactivation it had. The sync time is still
      // stamped, so a refused reactivation is distinguishable from a run that
      // never saw this user.
      expect(tenantMemberUpdateArgs).toMatchObject({
        where: { id: "member-1" },
        data: { deactivatedAt: new Date("2025-01-01") },
      });
      // A refused reactivation activated nothing, so there is nothing to realign.
      expect(mockRealignAfterActivation).not.toHaveBeenCalled();
    });

    it("counts a refused reactivation apart from the writes it reports", async () => {
      // The refusal still stamps `lastScimSyncedAt`, so it lands in usersUpdated
      // — and with nothing else in the result, the run read as `usersUpdated: 1,
      // SUCCESS` to the IdP admin while the user stayed deactivated.
      setupAcquiredLock();
      setApplyTx(makeApplyTx({
        tenantMember: {
          findMany: vi.fn().mockResolvedValue([]),
          create: vi.fn(),
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      }));

      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      mockFetchOktaUsers.mockResolvedValue([
        makeOktaUser({ id: "ext-1", email: "alice@example.com", displayName: "Alice", status: "ACTIVE" }),
      ]);
      mockScimMapping.findMany.mockResolvedValue([
        { externalId: "ext-1", internalId: "user-1" },
      ]);
      mockTenantMember.findMany.mockResolvedValue([
        makeMember({
          id: "member-1",
          userId: "user-1",
          role: "MEMBER",
          deactivatedAt: new Date("2025-01-01"),
          email: "alice@example.com",
          name: "Alice",
        }),
      ]);
      mockGuardFindMany.mockResolvedValue([
        { userId: "user-1", user: { email: "alice@example.com" } },
      ]);

      const result = await runDirectorySync(BASE_OPTIONS);

      expect(result.usersRefused).toBe(1);
      // Still 1: the counters above report the writes that DID happen, and the
      // sync time was stamped. The refusal is what the new counter adds.
      expect(result.usersUpdated).toBe(1);
      // Durably, not only in the returned object — the log row is what the
      // tenant's operators read afterwards.
      expect(mockDirSyncLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ usersRefused: 1, status: "SUCCESS" }),
        }),
      );
    });

    it("emits an audit event naming the membership it declined", async () => {
      setupAcquiredLock();
      setApplyTx(makeApplyTx({
        tenantMember: {
          findMany: vi.fn().mockResolvedValue([]),
          create: vi.fn(),
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      }));

      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      mockFetchOktaUsers.mockResolvedValue([
        makeOktaUser({ id: "ext-1", email: "alice@example.com", displayName: "Alice", status: "ACTIVE" }),
      ]);
      mockScimMapping.findMany.mockResolvedValue([
        { externalId: "ext-1", internalId: "user-1" },
      ]);
      mockTenantMember.findMany.mockResolvedValue([
        makeMember({
          id: "member-1",
          userId: "user-1",
          role: "MEMBER",
          deactivatedAt: new Date("2025-01-01"),
          email: "alice@example.com",
          name: "Alice",
        }),
      ]);
      mockGuardFindMany.mockResolvedValue([
        { userId: "user-1", user: { email: "alice@example.com" } },
      ]);

      await runDirectorySync(BASE_OPTIONS);

      expect(mockLogAuditBulk).toHaveBeenCalledWith([
        expect.objectContaining({
          action: "DIRECTORY_SYNC_ACTIVATION_REFUSED",
          tenantId: BASE_OPTIONS.tenantId,
          targetType: "TenantMember",
          targetId: "member-1",
        }),
      ]);

      // The trail is readable by THIS tenant's admins, and which other
      // organization holds the member is not theirs to learn. Pinned by EQUALITY
      // rather than by the absence of a string: `usersActiveInAnotherTenant` never
      // returns a tenant id, so a `not.toContain` over one could not fail. Any key
      // added to this metadata — a foreign tenant id included — fails here.
      const [[emitted]] = mockLogAuditBulk.mock.calls;
      expect(emitted[0].metadata).toEqual({
        configId: CONFIG_ID,
        userId: "user-1",
        email: "alice@example.com",
      });
      expect(emitted[0]).toMatchObject({ userId: USER_ID, actorType: "HUMAN" });
    });

    it("files a scheduled run's refusal under the system actor", async () => {
      // The refusal emit's own actor ternary. Every other refusal cell passes a
      // userId, so the scheduled arm was never taken.
      setupAcquiredLock();
      setApplyTx(makeApplyTx({
        tenantMember: {
          findMany: vi.fn().mockResolvedValue([]),
          create: vi.fn(),
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      }));
      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      mockFetchOktaUsers.mockResolvedValue([
        makeOktaUser({ id: "ext-1", email: "alice@example.com", displayName: "Alice", status: "ACTIVE" }),
      ]);
      mockScimMapping.findMany.mockResolvedValue([
        { externalId: "ext-1", internalId: "user-1" },
      ]);
      mockTenantMember.findMany.mockResolvedValue([
        makeMember({
          id: "member-1",
          userId: "user-1",
          role: "MEMBER",
          deactivatedAt: new Date("2025-01-01"),
          email: "alice@example.com",
          name: "Alice",
        }),
      ]);
      mockGuardFindMany.mockResolvedValue([
        { userId: "user-1", user: { email: "alice@example.com" } },
      ]);

      await runDirectorySync({ ...BASE_OPTIONS, userId: undefined });

      const [[emitted]] = mockLogAuditBulk.mock.calls;
      expect(emitted[0]).toMatchObject({ userId: SYSTEM_ACTOR_ID, actorType: "SYSTEM" });
    });

    /** An unmapped provider user whose email matches a DEACTIVATED member here. */
    function seedUnmappedDeactivatedMember(memberUpdate: ReturnType<typeof vi.fn>) {
      setupAcquiredLock();
      mockGuardUserFindMany.mockResolvedValue([{ id: "user-7", email: "dora@example.com" }]);
      setApplyTx(makeApplyTx({
        user: {
          findMany: vi.fn(),
          create: vi.fn(),
          update: vi.fn(),
        },
        tenantMember: {
          findMany: vi.fn(),
          create: vi.fn(),
          update: memberUpdate,
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      }));
      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      mockFetchOktaUsers.mockResolvedValue([
        makeOktaUser({ id: "ext-7", email: "dora@example.com", displayName: "Dora", status: "ACTIVE" }),
      ]);
      // No mapping, so the provider user lands in toCreate.
      mockScimMapping.findMany.mockResolvedValue([]);
      // The top-level mock wins the merge for findMany, so one mock answers both
      // the load phase ({ tenantId }) and the apply phase's pre-fetch
      // ({ tenantId, userId: { in } }). It answers by query, as Prisma would.
      mockTenantMember.findMany.mockImplementation(
        async ({ where }: { where: { userId?: unknown } }) =>
          where.userId
            ? [{ id: "member-7", userId: "user-7", deactivatedAt: new Date("2025-01-01") }]
            : [],
      );
    }

    it("counts the refusal on an unmapped user who holds a deactivated membership here", async () => {
      // The third refusal producer, and the one F15's narrative describes: no SCIM
      // mapping, an existing user, a DEACTIVATED membership. Refused, the arm only
      // stamps lastScimSyncedAt. Deleting its counter or its push left the suite green.
      const memberUpdate = vi.fn().mockResolvedValue({});
      seedUnmappedDeactivatedMember(memberUpdate);
      mockGuardFindMany.mockResolvedValue([
        { userId: "user-7", user: { email: "dora@example.com" } },
      ]);

      const result = await runDirectorySync(BASE_OPTIONS);

      // The arm ran — without this the cell could pass on a user the diff never reached.
      expect(result.usersCreated).toBe(1);
      expect(result.usersRefused).toBe(1);
      expect(memberUpdate).toHaveBeenCalledWith({
        where: { id: "member-7" },
        data: { lastScimSyncedAt: expect.any(Date) },
      });
      expect(mockLogAuditBulk).toHaveBeenCalledWith([
        expect.objectContaining({ targetId: "member-7" }),
      ]);
    });

    it("reactivates that same unmapped member when the guard clears them", async () => {
      // The allow side: a counter or an update that always refused would pass the
      // cell above.
      const memberUpdate = vi.fn().mockResolvedValue({});
      seedUnmappedDeactivatedMember(memberUpdate);

      const result = await runDirectorySync(BASE_OPTIONS);

      expect(result.usersRefused).toBe(0);
      expect(memberUpdate).toHaveBeenCalledWith({
        where: { id: "member-7" },
        data: { deactivatedAt: null, lastScimSyncedAt: expect.any(Date) },
      });
      expect(mockLogAuditBulk).toHaveBeenCalledWith([]);
      expect(mockRealignAfterActivation).toHaveBeenCalledWith("user-7", TENANT_ID);
    });

    it("reports no refusal when the guard clears the user", async () => {
      // The counter must be able to read zero: one that incremented on every
      // reactivation would satisfy the cells above and say nothing.
      setupAcquiredLock();
      setApplyTx(makeApplyTx({
        tenantMember: {
          findMany: vi.fn().mockResolvedValue([]),
          create: vi.fn(),
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      }));

      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      mockFetchOktaUsers.mockResolvedValue([
        makeOktaUser({ id: "ext-1", email: "alice@example.com", displayName: "Alice", status: "ACTIVE" }),
      ]);
      mockScimMapping.findMany.mockResolvedValue([
        { externalId: "ext-1", internalId: "user-1" },
      ]);
      mockTenantMember.findMany.mockResolvedValue([
        makeMember({
          id: "member-1",
          userId: "user-1",
          role: "MEMBER",
          deactivatedAt: new Date("2025-01-01"),
          email: "alice@example.com",
          name: "Alice",
        }),
      ]);

      const result = await runDirectorySync(BASE_OPTIONS);

      expect(result.usersRefused).toBe(0);
      expect(mockLogAuditBulk).toHaveBeenCalledWith([]);
    });

    it("counts the create arm's refusal too", async () => {
      // Same guard, different verb: the membership is created deactivated, so no
      // reactivation is refused and yet an activation was.
      setupAcquiredLock();
      setApplyTx(makeApplyTx({
        user: {
          findMany: vi.fn().mockResolvedValue([]),
          create: vi.fn().mockResolvedValue({ id: "user-9", email: "carol@example.com" }),
          update: vi.fn(),
        },
        tenantMember: {
          findMany: vi.fn().mockResolvedValue([]),
          create: vi.fn().mockResolvedValue({ id: "member-9" }),
          update: vi.fn(),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      }));

      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      mockFetchOktaUsers.mockResolvedValue([
        makeOktaUser({ id: "ext-9", email: "carol@example.com", displayName: "Carol", status: "ACTIVE" }),
      ]);
      mockScimMapping.findMany.mockResolvedValue([]);
      mockTenantMember.findMany.mockResolvedValue([]);
      mockGuardFindMany.mockResolvedValue([
        { userId: "user-9", user: { email: "carol@example.com" } },
      ]);

      mockGuardUserFindMany.mockResolvedValue([{ id: "user-9", email: "carol@example.com" }]);

      const result = await runDirectorySync(BASE_OPTIONS);

      expect(result.usersRefused).toBe(1);
      expect(mockLogAuditBulk).toHaveBeenCalledWith([
        expect.objectContaining({
          action: "DIRECTORY_SYNC_ACTIVATION_REFUSED",
          targetId: "member-9",
        }),
      ]);
      expect((applyTxHolder.current as { user: { create: ReturnType<typeof vi.fn> } }).user.create).not.toHaveBeenCalled();
    });

    it("does not count an IdP-inactive user as a refusal", async () => {
      // The guard fires on this user, but the IdP itself sent them inactive, so
      // nothing was declined — the membership would have been created
      // deactivated either way. A counter keyed on the guard alone reports a
      // refusal that never happened.
      setupAcquiredLock();
      setApplyTx(makeApplyTx({
        user: {
          findMany: vi.fn().mockResolvedValue([]),
          create: vi.fn().mockResolvedValue({ id: "user-9", email: "carol@example.com" }),
          update: vi.fn(),
        },
        tenantMember: {
          findMany: vi.fn().mockResolvedValue([]),
          create: vi.fn().mockResolvedValue({ id: "member-9" }),
          update: vi.fn(),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      }));

      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      mockFetchOktaUsers.mockResolvedValue([
        makeOktaUser({ id: "ext-9", email: "carol@example.com", displayName: "Carol", status: "SUSPENDED" }),
      ]);
      mockScimMapping.findMany.mockResolvedValue([]);
      mockTenantMember.findMany.mockResolvedValue([]);
      mockGuardFindMany.mockResolvedValue([
        { userId: "user-9", user: { email: "carol@example.com" } },
      ]);

      mockGuardUserFindMany.mockResolvedValue([{ id: "user-9", email: "carol@example.com" }]);

      const result = await runDirectorySync(BASE_OPTIONS);

      // The create arm ran — without this the cell would pass on a user the diff
      // never reached, reporting a counter it never exercised as correct.
      expect(result.usersCreated).toBe(1);
      expect(result.usersRefused).toBe(0);
      expect(mockLogAuditBulk).toHaveBeenCalledWith([]);
      expect((applyTxHolder.current as { user: { create: ReturnType<typeof vi.fn> } }).user.create).not.toHaveBeenCalled();
    });

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
      // After the commit: the apply ran in this tenant's context, which cannot
      // write a users row filed under another tenant.
      expect(mockRealignAfterActivation).toHaveBeenCalledWith("user-1", TENANT_ID);
    });

    it("files a new membership under a user who already exists in another tenant instead of creating a duplicate", async () => {
      setupAcquiredLock();
      const applyTx = makeApplyTx();
      setApplyTx(applyTx);

      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      mockFetchOktaUsers.mockResolvedValue([
        makeOktaUser({ id: "ext-5", email: "erin@example.com", displayName: "Erin", status: "ACTIVE" }),
      ]);
      mockScimMapping.findMany.mockResolvedValue([]);
      mockTenantMember.findMany.mockResolvedValue([]);
      mockGuardUserFindMany.mockResolvedValue([{ id: "user-5", email: "Erin@Example.com" }]);

      const result = await runDirectorySync(BASE_OPTIONS);

      expect(result.success).toBe(true);
      expect(applyTx.user.create).not.toHaveBeenCalled();
      expect(applyTx.tenantMember.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: "user-5", deactivatedAt: null }),
        }),
      );
      expect(mockRealignAfterActivation).toHaveBeenCalledWith("user-5", TENANT_ID);
    });

    it("does not fail a sync whose writes committed when the realignment fails", async () => {
      setupAcquiredLock();
      setApplyTx(makeApplyTx({
        tenantMember: {
          findMany: vi.fn().mockResolvedValue([]),
          create: vi.fn(),
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      }));

      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      mockFetchOktaUsers.mockResolvedValue([
        makeOktaUser({ id: "ext-1", email: "alice@example.com", displayName: "Alice", status: "ACTIVE" }),
      ]);
      mockScimMapping.findMany.mockResolvedValue([{ externalId: "ext-1", internalId: "user-1" }]);
      mockTenantMember.findMany.mockResolvedValue([
        makeMember({ id: "member-1", userId: "user-1", deactivatedAt: new Date("2025-01-01") }),
      ]);
      mockRealignAfterActivation.mockRejectedValue(new Error("bypass unavailable"));

      const result = await runDirectorySync(BASE_OPTIONS);

      expect(result.success).toBe(true);
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_ID, userId: "user-1" }),
        "directory-sync.realign-failed",
      );
    });
  });

  // ── Members whose users row this tenant cannot see ────────────

  describe("a member whose users row this tenant cannot see", () => {
    it("deactivates the member without renaming them, and reads no user relation", async () => {
      setupAcquiredLock();
      const applyTx = makeApplyTx({
        tenantMember: {
          findMany: vi.fn().mockResolvedValue([]),
          create: vi.fn(),
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      });
      setApplyTx(applyTx);

      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      mockFetchOktaUsers.mockResolvedValue([
        makeOktaUser({ id: "ext-2", email: "moved@example.com", displayName: "Renamed", status: "SUSPENDED" }),
      ]);
      mockScimMapping.findMany.mockResolvedValue([{ externalId: "ext-2", internalId: "user-2" }]);
      mockTenantMember.findMany.mockResolvedValue([
        makeMember({ id: "member-2", userId: "user-2", visible: false }),
      ]);

      const result = await runDirectorySync(BASE_OPTIONS);

      expect(result.success).toBe(true);
      expect(applyTx.user.update).not.toHaveBeenCalled();
      expect(applyTx.tenantMember.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "member-2" },
          data: expect.objectContaining({ deactivatedAt: expect.any(Date) }),
        }),
      );
      expect(mockTenantMember.findMany.mock.calls[0][0].select).not.toHaveProperty("user");
    });

    it("leaves a hidden member alone when only the name differs", async () => {
      setupAcquiredLock();
      const applyTx = makeApplyTx();
      setApplyTx(applyTx);

      mockDirSyncConfig.findUnique.mockResolvedValue(OKTA_CONFIG);
      mockFetchOktaUsers.mockResolvedValue([
        makeOktaUser({ id: "ext-2", email: "moved@example.com", displayName: "Renamed", status: "ACTIVE" }),
      ]);
      mockScimMapping.findMany.mockResolvedValue([{ externalId: "ext-2", internalId: "user-2" }]);
      mockTenantMember.findMany.mockResolvedValue([
        makeMember({ id: "member-2", userId: "user-2", visible: false }),
      ]);

      const result = await runDirectorySync(BASE_OPTIONS);

      expect(result.success).toBe(true);
      expect(result.usersUpdated).toBe(0);
      expect(applyTx.user.update).not.toHaveBeenCalled();
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

