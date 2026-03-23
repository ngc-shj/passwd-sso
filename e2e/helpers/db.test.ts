/**
 * Unit tests for the E2E database helper (db.ts).
 * pg.Pool is mocked — no real database connection is made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── pg mock (must be hoisted before module import) ─────────────

const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("pg", () => ({
  default: {
    Pool: vi.fn(function () {
      return { query: mockQuery, end: mockEnd };
    }),
  },
}));

// Import after mock is in place
import {
  assertTestDatabase,
  seedTenant,
  seedUser,
  seedSession,
  seedVaultKey,
  seedTenantMember,
  cleanup,
  E2E_TENANT,
} from "./db";

// ─── Helpers ────────────────────────────────────────────────────

function getCall(index: number) {
  return mockQuery.mock.calls[index] as [string, unknown[]];
}

// ─── Tests ──────────────────────────────────────────────────────

describe("assertTestDatabase", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws when DATABASE_URL does not match safety pattern", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@prod-db:5432/mydb");
    vi.stubEnv("E2E_ALLOW_DB_MUTATION", "true");
    expect(() => assertTestDatabase()).toThrow(
      "E2E tests require a test/CI database"
    );
  });

  it("throws when E2E_ALLOW_DB_MUTATION is not 'true'", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/mydb");
    vi.stubEnv("E2E_ALLOW_DB_MUTATION", "false");
    expect(() => assertTestDatabase()).toThrow("E2E_ALLOW_DB_MUTATION=true");
  });

  it("throws when E2E_ALLOW_DB_MUTATION is absent", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/mydb");
    vi.stubEnv("E2E_ALLOW_DB_MUTATION", "");
    expect(() => assertTestDatabase()).toThrow("E2E_ALLOW_DB_MUTATION=true");
  });

  it("does not throw for localhost URL with mutation enabled", () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://user:pass@localhost:5432/mydb"
    );
    vi.stubEnv("E2E_ALLOW_DB_MUTATION", "true");
    expect(() => assertTestDatabase()).not.toThrow();
  });

  it("does not throw for URL containing 'test'", () => {
    // The regex uses \b word boundaries, so the word "test" must be isolated
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@db.test:5432/mydb");
    vi.stubEnv("E2E_ALLOW_DB_MUTATION", "true");
    expect(() => assertTestDatabase()).not.toThrow();
  });

  it("does not throw for URL containing 'e2e'", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@e2e-db:5432/appdb");
    vi.stubEnv("E2E_ALLOW_DB_MUTATION", "true");
    expect(() => assertTestDatabase()).not.toThrow();
  });

  it("does not throw for URL containing 'ci'", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@ci-db:5432/appdb");
    vi.stubEnv("E2E_ALLOW_DB_MUTATION", "true");
    expect(() => assertTestDatabase()).not.toThrow();
  });
});

describe("seedTenant", () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it("calls pool.query with INSERT...ON CONFLICT SQL", async () => {
    await seedTenant();
    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql] = getCall(0);
    expect(sql).toMatch(/INSERT INTO tenants/i);
    expect(sql).toMatch(/ON CONFLICT \(id\)/i);
    expect(sql).toMatch(/DO UPDATE SET/i);
  });

  it("passes E2E_TENANT.id as the first parameter", async () => {
    await seedTenant();
    const [, params] = getCall(0);
    expect(params[0]).toBe(E2E_TENANT.id);
  });

  it("passes E2E_TENANT.name and slug as second and third parameters", async () => {
    await seedTenant();
    const [, params] = getCall(0);
    expect(params[1]).toBe(E2E_TENANT.name);
    expect(params[2]).toBe(E2E_TENANT.slug);
  });
});

describe("seedUser", () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  const baseUser = {
    id: "test-user-id",
    email: "e2e-test@test.local",
    name: "Test User",
  };

  describe("without vaultFields", () => {
    it("calls pool.query once", async () => {
      await seedUser(baseUser);
      expect(mockQuery).toHaveBeenCalledOnce();
    });

    it("includes tenant_id (E2E_TENANT.id) in the INSERT", async () => {
      await seedUser(baseUser);
      const [sql, params] = getCall(0);
      expect(sql).toMatch(/INSERT INTO users/i);
      expect(sql).toMatch(/tenant_id/i);
      expect(params).toContain(E2E_TENANT.id);
    });

    it("uses UPSERT (ON CONFLICT DO UPDATE)", async () => {
      await seedUser(baseUser);
      const [sql] = getCall(0);
      expect(sql).toMatch(/ON CONFLICT \(id\)/i);
      expect(sql).toMatch(/DO UPDATE SET/i);
    });

    it("does not include vault column names in SQL", async () => {
      await seedUser(baseUser);
      const [sql] = getCall(0);
      expect(sql).not.toMatch(/account_salt/i);
      expect(sql).not.toMatch(/encrypted_secret_key/i);
    });
  });

  describe("with vaultFields", () => {
    const vaultFields = {
      accountSalt: "aa".repeat(32),
      encryptedSecretKey: "bb".repeat(32),
      secretKeyIv: "cc".repeat(12),
      secretKeyAuthTag: "dd".repeat(16),
      masterPasswordServerHash: "ee".repeat(32),
      masterPasswordServerSalt: "ff".repeat(16),
      passphraseVerifierHmac: "11".repeat(32),
      keyVersion: 1,
    };

    it("includes vault column names in the INSERT SQL", async () => {
      await seedUser({ ...baseUser, vaultFields });
      const [sql] = getCall(0);
      expect(sql).toMatch(/account_salt/i);
      expect(sql).toMatch(/encrypted_secret_key/i);
      expect(sql).toMatch(/master_password_server_hash/i);
      expect(sql).toMatch(/passphrase_verifier_hmac/i);
    });

    it("passes tenant_id (E2E_TENANT.id) in parameters", async () => {
      await seedUser({ ...baseUser, vaultFields });
      const [, params] = getCall(0);
      expect(params).toContain(E2E_TENANT.id);
    });

    it("passes all vault field values in parameters", async () => {
      await seedUser({ ...baseUser, vaultFields });
      const [, params] = getCall(0);
      expect(params).toContain(vaultFields.accountSalt);
      expect(params).toContain(vaultFields.encryptedSecretKey);
      expect(params).toContain(vaultFields.masterPasswordServerHash);
      expect(params).toContain(vaultFields.passphraseVerifierHmac);
      expect(params).toContain(vaultFields.keyVersion);
    });

    it("uses UPSERT (ON CONFLICT DO UPDATE)", async () => {
      await seedUser({ ...baseUser, vaultFields });
      const [sql] = getCall(0);
      expect(sql).toMatch(/ON CONFLICT \(id\)/i);
      expect(sql).toMatch(/DO UPDATE SET/i);
    });
  });
});

describe("seedSession", () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it("calls pool.query once", async () => {
    await seedSession("user-id-1", "session-token-abc");
    expect(mockQuery).toHaveBeenCalledOnce();
  });

  it("includes tenant_id (E2E_TENANT.id) in the INSERT", async () => {
    await seedSession("user-id-1", "session-token-abc");
    const [sql, params] = getCall(0);
    expect(sql).toMatch(/INSERT INTO sessions/i);
    expect(sql).toMatch(/tenant_id/i);
    expect(params).toContain(E2E_TENANT.id);
  });

  it("passes sessionToken in correct position", async () => {
    const token = "my-session-token-xyz";
    await seedSession("user-id-1", token);
    const [, params] = getCall(0);
    // params: [id, sessionToken, userId, tenantId, expires]
    expect(params[1]).toBe(token);
  });

  it("passes userId in correct position", async () => {
    const userId = "user-id-99";
    await seedSession(userId, "session-token-abc");
    const [, params] = getCall(0);
    expect(params[2]).toBe(userId);
  });

  it("sets expires_at in the future", async () => {
    const before = Date.now();
    await seedSession("user-id-1", "token");
    const [, params] = getCall(0);
    const expires = new Date(params[4] as string).getTime();
    expect(expires).toBeGreaterThan(before);
  });
});

describe("seedVaultKey", () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  const artifact = {
    ciphertext: "aabbcc",
    iv: "112233",
    authTag: "445566",
  };

  it("calls pool.query once", async () => {
    await seedVaultKey("user-id-1", artifact);
    expect(mockQuery).toHaveBeenCalledOnce();
  });

  it("uses ON CONFLICT (user_id, version)", async () => {
    await seedVaultKey("user-id-1", artifact);
    const [sql] = getCall(0);
    expect(sql).toMatch(/ON CONFLICT \(user_id, version\)/i);
  });

  it("includes tenant_id (E2E_TENANT.id) in parameters", async () => {
    await seedVaultKey("user-id-1", artifact);
    const [, params] = getCall(0);
    expect(params).toContain(E2E_TENANT.id);
  });

  it("passes artifact fields (ciphertext, iv, authTag) in parameters", async () => {
    await seedVaultKey("user-id-1", artifact);
    const [, params] = getCall(0);
    expect(params).toContain(artifact.ciphertext);
    expect(params).toContain(artifact.iv);
    expect(params).toContain(artifact.authTag);
  });
});

describe("seedTenantMember", () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it("calls pool.query once", async () => {
    await seedTenantMember("user-id-1");
    expect(mockQuery).toHaveBeenCalledOnce();
  });

  it("uses ON CONFLICT (tenant_id, user_id)", async () => {
    await seedTenantMember("user-id-1");
    const [sql] = getCall(0);
    expect(sql).toMatch(/ON CONFLICT \(tenant_id, user_id\)/i);
  });

  it("passes role parameter in parameters (default MEMBER)", async () => {
    await seedTenantMember("user-id-1");
    const [, params] = getCall(0);
    expect(params).toContain("MEMBER");
  });

  it("passes explicit role parameter", async () => {
    await seedTenantMember("user-id-1", "ADMIN");
    const [, params] = getCall(0);
    expect(params).toContain("ADMIN");
  });

  it("passes E2E_TENANT.id in parameters", async () => {
    await seedTenantMember("user-id-1");
    const [, params] = getCall(0);
    expect(params).toContain(E2E_TENANT.id);
  });
});

describe("cleanup", () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  it("queries users by email pattern e2e-%@test.local", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await cleanup();
    const firstCall = getCall(0);
    expect(firstCall[0]).toMatch(/SELECT id FROM users WHERE email LIKE/i);
    expect(firstCall[0]).toMatch(/e2e-%@test\.local/);
  });

  describe("when no users are found", () => {
    it("still deletes from tenant_members and tenants", async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await cleanup();
      const allSql = mockQuery.mock.calls.map((c) => c[0] as string);
      expect(allSql.some((s) => /DELETE FROM tenant_members/i.test(s))).toBe(
        true
      );
      expect(allSql.some((s) => /DELETE FROM tenants/i.test(s))).toBe(true);
    });

    it("uses E2E_TENANT.id when cleaning tenant tables", async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await cleanup();
      const tenantCalls = mockQuery.mock.calls.filter(
        (c) =>
          /DELETE FROM tenant_members/i.test(c[0] as string) ||
          /DELETE FROM tenants/i.test(c[0] as string)
      );
      for (const call of tenantCalls) {
        expect(call[1]).toContain(E2E_TENANT.id);
      }
    });
  });

  describe("when users are found", () => {
    const fakeUserIds = ["uid-1", "uid-2"];

    beforeEach(() => {
      mockQuery
        // First call: SELECT users
        .mockResolvedValueOnce({ rows: fakeUserIds.map((id) => ({ id })) })
        // Second call: SELECT teams
        .mockResolvedValueOnce({ rows: [] })
        // All subsequent: successful deletes
        .mockResolvedValue({ rows: [] });
    });

    it("deletes personal_log_access_grants before users", async () => {
      await cleanup();
      const allSql = mockQuery.mock.calls.map((c) => c[0] as string);
      const grantIdx = allSql.findIndex((s) =>
        /DELETE FROM personal_log_access_grants/i.test(s)
      );
      const userIdx = allSql.findIndex((s) =>
        /DELETE FROM users WHERE id/i.test(s)
      );
      expect(grantIdx).toBeGreaterThan(-1);
      expect(userIdx).toBeGreaterThan(grantIdx);
    });

    it("deletes teams by tenant_id", async () => {
      await cleanup();
      const allSql = mockQuery.mock.calls.map((c) => c[0] as string);
      expect(allSql.some((s) => /DELETE FROM teams WHERE tenant_id/i.test(s))).toBe(true);
    });

    it("deletes sessions before users", async () => {
      await cleanup();
      const allSql = mockQuery.mock.calls.map((c) => c[0] as string);
      const sessIdx = allSql.findIndex((s) =>
        /DELETE FROM sessions/i.test(s)
      );
      const userIdx = allSql.findIndex((s) =>
        /DELETE FROM users WHERE id/i.test(s)
      );
      expect(sessIdx).toBeGreaterThan(-1);
      expect(userIdx).toBeGreaterThan(sessIdx);
    });

    it("deletes tenants last", async () => {
      await cleanup();
      const allSql = mockQuery.mock.calls.map((c) => c[0] as string);
      const lastSql = allSql[allSql.length - 1];
      expect(lastSql).toMatch(/DELETE FROM tenants WHERE id/i);
    });
  });
});
