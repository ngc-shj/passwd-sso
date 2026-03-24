/**
 * Unit tests for seedShareLink (share-link.ts).
 * Verifies token generation, SHA-256 hashing, AES-256-GCM encryption,
 * and correct SQL parameters.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash, createDecipheriv } from "node:crypto";

// ─── pg mock ────────────────────────────────────────────────────

const mockQuery = vi.fn().mockResolvedValue({ rows: [] });

vi.mock("pg", () => ({
  default: {
    Pool: vi.fn(function () {
      return { query: mockQuery, end: vi.fn() };
    }),
  },
}));

import { seedShareLink } from "./share-link";
import { E2E_TENANT } from "./db";

// ─── Shared env setup ────────────────────────────────────────────

// 32-byte master key as 64-char hex
const MASTER_KEY_HEX = "ab".repeat(32);
const MASTER_KEY = Buffer.from(MASTER_KEY_HEX, "hex");

const BASE_OPTIONS = {
  createdById: "00000000-0000-4000-b000-000000000001",
  entryId: "00000000-0000-4000-c000-000000000001",
  title: "E2E Share Test",
};

// ─── Helpers ────────────────────────────────────────────────────

function getQueryParams(): unknown[] {
  const call = mockQuery.mock.calls[0] as [string, unknown[]];
  return call[1];
}

function decryptGcm(
  key: Buffer,
  ciphertextHex: string,
  ivHex: string,
  authTagHex: string
): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf-8");
}

// ─── Tests ──────────────────────────────────────────────────────

describe("seedShareLink", () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockQuery.mockResolvedValue({ rows: [] });
    vi.stubEnv("SHARE_MASTER_KEY", MASTER_KEY_HEX);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a 64-char hex token string (32 bytes)", async () => {
    const token = await seedShareLink(BASE_OPTIONS);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns different tokens on each call", async () => {
    const token1 = await seedShareLink(BASE_OPTIONS);
    mockQuery.mockClear();
    mockQuery.mockResolvedValue({ rows: [] });
    const token2 = await seedShareLink(BASE_OPTIONS);
    expect(token1).not.toBe(token2);
  });

  it("stores SHA-256 hash of token (not the raw token)", async () => {
    const token = await seedShareLink(BASE_OPTIONS);
    const params = getQueryParams();
    // params[2] = tokenHash
    const tokenHash = params[2] as string;
    const expectedHash = createHash("sha256").update(token).digest("hex");
    expect(tokenHash).toBe(expectedHash);
  });

  it("calls pool.query once with INSERT INTO password_shares", async () => {
    await seedShareLink(BASE_OPTIONS);
    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO password_shares/i);
  });

  it("uses ON CONFLICT (token_hash) DO UPDATE SET", async () => {
    await seedShareLink(BASE_OPTIONS);
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ON CONFLICT \(token_hash\)/i);
    expect(sql).toMatch(/DO UPDATE SET/i);
  });

  it("sets share_type to ENTRY_SHARE", async () => {
    await seedShareLink(BASE_OPTIONS);
    const params = getQueryParams();
    // params[3] = share_type
    expect(params[3]).toBe("ENTRY_SHARE");
  });

  it("sets entry_type to LOGIN", async () => {
    await seedShareLink(BASE_OPTIONS);
    const params = getQueryParams();
    // params[4] = entry_type
    expect(params[4]).toBe("LOGIN");
  });

  it("sets expires_at approximately 24 hours in the future", async () => {
    const before = Date.now();
    await seedShareLink(BASE_OPTIONS);
    const params = getQueryParams();
    // params[8] = expires_at
    const expiresAt = new Date(params[8] as string).getTime();
    const twentyFourHours = 24 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(before + twentyFourHours - 1000);
    expect(expiresAt).toBeLessThanOrEqual(before + twentyFourHours + 5000);
  });

  it("uses E2E_TENANT.id as tenantId by default", async () => {
    await seedShareLink(BASE_OPTIONS);
    const params = getQueryParams();
    // params[1] = tenantId
    expect(params[1]).toBe(E2E_TENANT.id);
  });

  it("uses custom tenantId when provided", async () => {
    const customId = "custom-tenant-id-xyz";
    await seedShareLink({ ...BASE_OPTIONS, tenantId: customId });
    const params = getQueryParams();
    expect(params[1]).toBe(customId);
  });

  it("passes createdById and entryId in parameters", async () => {
    await seedShareLink(BASE_OPTIONS);
    const params = getQueryParams();
    expect(params).toContain(BASE_OPTIONS.createdById);
    expect(params).toContain(BASE_OPTIONS.entryId);
  });

  it("encrypted data decrypts to JSON with share payload fields", async () => {
    await seedShareLink(BASE_OPTIONS);
    const params = getQueryParams();
    // params[5]=encrypted_data, params[6]=data_iv, params[7]=data_auth_tag
    const ciphertext = params[5] as string;
    const iv = params[6] as string;
    const authTag = params[7] as string;

    const plaintext = decryptGcm(MASTER_KEY, ciphertext, iv, authTag);
    const data = JSON.parse(plaintext);

    expect(data.title).toBe(BASE_OPTIONS.title);
    expect(data.username).toBe("e2e-user@example.com");
    expect(data.password).toBe("E2ESeedPassword!999");
    expect(data.url).toBe("https://example.com");
    expect(data.entryType).toBe("LOGIN");
  });

  it("uses default title when title is not provided", async () => {
    await seedShareLink({
      createdById: BASE_OPTIONS.createdById,
      entryId: BASE_OPTIONS.entryId,
    });
    const params = getQueryParams();
    const ciphertext = params[5] as string;
    const iv = params[6] as string;
    const authTag = params[7] as string;

    const plaintext = decryptGcm(MASTER_KEY, ciphertext, iv, authTag);
    const data = JSON.parse(plaintext);
    expect(data.title).toBe("E2E Shared Entry");
  });

  it("throws when SHARE_MASTER_KEY is not set", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("SHARE_MASTER_KEY", "");
    vi.stubEnv("SHARE_MASTER_KEY_V1", "");
    await expect(seedShareLink(BASE_OPTIONS)).rejects.toThrow(
      "SHARE_MASTER_KEY"
    );
  });

  it("throws when SHARE_MASTER_KEY is not valid 64-char hex", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("SHARE_MASTER_KEY", "not-valid-hex");
    await expect(seedShareLink(BASE_OPTIONS)).rejects.toThrow(
      "SHARE_MASTER_KEY"
    );
  });

  it("prefers SHARE_MASTER_KEY_V1 over SHARE_MASTER_KEY", async () => {
    vi.unstubAllEnvs();
    // Set V1 key and a different legacy key
    vi.stubEnv("SHARE_MASTER_KEY_V1", MASTER_KEY_HEX);
    vi.stubEnv("SHARE_MASTER_KEY", "cc".repeat(32));
    // Should succeed and use the V1 key (decryptable with MASTER_KEY)
    await seedShareLink(BASE_OPTIONS);
    const params = getQueryParams();
    const ciphertext = params[5] as string;
    const iv = params[6] as string;
    const authTag = params[7] as string;

    // Decryption with V1 key (MASTER_KEY) should succeed
    expect(() =>
      decryptGcm(MASTER_KEY, ciphertext, iv, authTag)
    ).not.toThrow();
  });
});
