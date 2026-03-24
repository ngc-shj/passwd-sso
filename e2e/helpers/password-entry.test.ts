/**
 * Unit tests for seedPasswordEntry (password-entry.ts).
 * Verifies that AES-256-GCM blobs are well-formed and SQL parameters are correct.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDecipheriv } from "node:crypto";

// ─── pg mock ────────────────────────────────────────────────────

const mockQuery = vi.fn().mockResolvedValue({ rows: [] });

vi.mock("pg", () => ({
  default: {
    Pool: vi.fn(function () {
      return { query: mockQuery, end: vi.fn() };
    }),
  },
}));

import { seedPasswordEntry } from "./password-entry";
import { deriveEncryptionKey } from "./crypto";
import { E2E_TENANT } from "./db";

// ─── Fixed test key ──────────────────────────────────────────────

const SECRET_KEY = Buffer.from(
  "0102030405060708091011121314151617181920212223242526272829303132",
  "hex"
);
const ENCRYPTION_KEY = deriveEncryptionKey(SECRET_KEY);

const BASE_OPTIONS = {
  id: "00000000-0000-4000-a000-000000000001",
  userId: "00000000-0000-4000-b000-000000000001",
  title: "E2E Test Entry",
  encryptionKey: ENCRYPTION_KEY,
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

describe("seedPasswordEntry", () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it("calls pool.query once", async () => {
    await seedPasswordEntry(BASE_OPTIONS);
    expect(mockQuery).toHaveBeenCalledOnce();
  });

  it("uses INSERT INTO password_entries with ON CONFLICT (id)", async () => {
    await seedPasswordEntry(BASE_OPTIONS);
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO password_entries/i);
    expect(sql).toMatch(/ON CONFLICT \(id\)/i);
    expect(sql).toMatch(/DO UPDATE SET/i);
  });

  it("passes correct userId and tenantId", async () => {
    await seedPasswordEntry(BASE_OPTIONS);
    const params = getQueryParams();
    // params[0]=id, params[1]=userId, params[2]=tenantId
    expect(params[0]).toBe(BASE_OPTIONS.id);
    expect(params[1]).toBe(BASE_OPTIONS.userId);
    expect(params[2]).toBe(E2E_TENANT.id);
  });

  it("uses custom tenantId when provided", async () => {
    const customTenantId = "custom-tenant-id";
    await seedPasswordEntry({ ...BASE_OPTIONS, tenantId: customTenantId });
    const params = getQueryParams();
    expect(params[2]).toBe(customTenantId);
  });

  it("blob IV is a valid hex string of length 24 (12 bytes)", async () => {
    await seedPasswordEntry(BASE_OPTIONS);
    const params = getQueryParams();
    // params[4]=blob.iv
    const blobIv = params[4] as string;
    expect(blobIv).toMatch(/^[0-9a-f]{24}$/);
  });

  it("blob authTag is a valid hex string of length 32 (16 bytes)", async () => {
    await seedPasswordEntry(BASE_OPTIONS);
    const params = getQueryParams();
    // params[5]=blob.authTag
    const blobAuthTag = params[5] as string;
    expect(blobAuthTag).toMatch(/^[0-9a-f]{32}$/);
  });

  it("overview IV is a valid hex string of length 24 (12 bytes)", async () => {
    await seedPasswordEntry(BASE_OPTIONS);
    const params = getQueryParams();
    // params[7]=overview.iv
    const overviewIv = params[7] as string;
    expect(overviewIv).toMatch(/^[0-9a-f]{24}$/);
  });

  it("overview authTag is a valid hex string of length 32 (16 bytes)", async () => {
    await seedPasswordEntry(BASE_OPTIONS);
    const params = getQueryParams();
    // params[8]=overview.authTag
    const overviewAuthTag = params[8] as string;
    expect(overviewAuthTag).toMatch(/^[0-9a-f]{32}$/);
  });

  it("encrypted blob decrypts to JSON containing title, username, password, url, notes", async () => {
    await seedPasswordEntry(BASE_OPTIONS);
    const params = getQueryParams();
    const ciphertext = params[3] as string;
    const iv = params[4] as string;
    const authTag = params[5] as string;

    const plaintext = decryptGcm(ENCRYPTION_KEY, ciphertext, iv, authTag);
    const data = JSON.parse(plaintext);

    expect(data.title).toBe(BASE_OPTIONS.title);
    expect(data.username).toBe("e2e-seeded@example.com");
    expect(data.password).toBe("E2ESeedPassword!999");
    expect(data.url).toBe("https://example.com");
    expect(data.notes).toBe("Seeded by E2E global-setup");
  });

  it("encrypted overview decrypts to JSON containing title, username, urlHost", async () => {
    await seedPasswordEntry(BASE_OPTIONS);
    const params = getQueryParams();
    const ciphertext = params[6] as string;
    const iv = params[7] as string;
    const authTag = params[8] as string;

    const plaintext = decryptGcm(ENCRYPTION_KEY, ciphertext, iv, authTag);
    const data = JSON.parse(plaintext);

    expect(data.title).toBe(BASE_OPTIONS.title);
    expect(data.username).toBe("e2e-seeded@example.com");
    expect(data.urlHost).toBe("example.com");
  });

  it("sets key_version to 1 and entry_type to LOGIN", async () => {
    await seedPasswordEntry(BASE_OPTIONS);
    const params = getQueryParams();
    // params[9]=key_version, params[10]=entry_type
    expect(params[9]).toBe(1);
    expect(params[10]).toBe("LOGIN");
  });

  it("generates different IVs on each call (random IV)", async () => {
    await seedPasswordEntry(BASE_OPTIONS);
    const params1 = [...getQueryParams()];
    mockQuery.mockClear();
    mockQuery.mockResolvedValue({ rows: [] });
    await seedPasswordEntry(BASE_OPTIONS);
    const params2 = getQueryParams();

    // blob IVs should differ
    expect(params1[4]).not.toBe(params2[4]);
  });
});
