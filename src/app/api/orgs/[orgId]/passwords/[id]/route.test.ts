import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth, mockPrismaOrgPasswordEntry, mockPrismaOrgFolder,
  mockRequireOrgPermission,
  mockRequireOrgMember, mockHasOrgPermission, mockUnwrapOrgKey,
  mockEncryptServerData, mockDecryptServerData, OrgAuthError,
  mockPrismaTransaction,
} = vi.hoisted(() => {
  class _OrgAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "OrgAuthError";
      this.status = status;
    }
  }
  return {
    mockAuth: vi.fn(),
    mockPrismaOrgPasswordEntry: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    mockPrismaOrgFolder: { findUnique: vi.fn() },
    mockRequireOrgPermission: vi.fn(),
    mockRequireOrgMember: vi.fn(),
    mockHasOrgPermission: vi.fn(),
    mockUnwrapOrgKey: vi.fn(),
    mockEncryptServerData: vi.fn(),
    mockDecryptServerData: vi.fn(),
    OrgAuthError: _OrgAuthError,
    mockPrismaTransaction: vi.fn(),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgPasswordEntry: mockPrismaOrgPasswordEntry,
    orgFolder: mockPrismaOrgFolder,
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: mockPrismaTransaction,
  },
}));
vi.mock("@/lib/org-auth", () => ({
  requireOrgPermission: mockRequireOrgPermission,
  requireOrgMember: mockRequireOrgMember,
  hasOrgPermission: mockHasOrgPermission,
  OrgAuthError,
}));
vi.mock("@/lib/crypto-server", () => ({
  unwrapOrgKey: mockUnwrapOrgKey,
  encryptServerData: mockEncryptServerData,
  decryptServerData: mockDecryptServerData,
}));

import { GET, PUT, DELETE } from "./route";
import { ENTRY_TYPE, ORG_ROLE } from "@/lib/constants";

const ORG_ID = "org-123";
const PW_ID = "pw-456";
const now = new Date("2025-01-01T00:00:00Z");

const orgKeyData = { encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag" };

describe("GET /api/orgs/[orgId]/passwords/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgPermission.mockResolvedValue({ role: ORG_ROLE.MEMBER });
    mockUnwrapOrgKey.mockReturnValue(Buffer.alloc(32));
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns OrgAuthError status when permission denied", async () => {
    mockRequireOrgPermission.mockRejectedValue(new OrgAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("rethrows non-OrgAuthError from GET", async () => {
    mockRequireOrgPermission.mockRejectedValue(new Error("unexpected"));
    await expect(
      GET(
        createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
        createParams({ orgId: ORG_ID, id: PW_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 404 when entry not found", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 500 when decryption fails", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: "LOGIN",
      encryptedBlob: "bad-cipher",
      blobIv: "iv",
      blobAuthTag: "tag",
      isArchived: false,
      org: orgKeyData,
      tags: [],
      createdBy: { id: "u1", name: "User", image: null },
      updatedBy: { id: "u1", name: "User" },
      favorites: [],
      createdAt: now,
      updatedAt: now,
    });
    mockDecryptServerData.mockImplementation(() => { throw new Error("decrypt failed"); });

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("DECRYPT_FAILED");
  });

  it("returns decrypted password details", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: ENTRY_TYPE.LOGIN,
      encryptedBlob: "blob-cipher",
      blobIv: "blob-iv",
      blobAuthTag: "blob-tag",
      isArchived: false,
      org: orgKeyData,
      tags: [],
      createdBy: { id: "u1", name: "User", image: null },
      updatedBy: { id: "u1", name: "User" },
      favorites: [],
      createdAt: now,
      updatedAt: now,
    });
    mockDecryptServerData.mockReturnValue(
      JSON.stringify({ title: "My PW", username: "admin", password: "secret", url: null, notes: null })
    );

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.title).toBe("My PW");
    expect(json.password).toBe("secret");
    expect(json.isFavorite).toBe(false);
  });

  it("returns CREDIT_CARD with card fields", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: "CREDIT_CARD",
      encryptedBlob: "blob-cipher",
      blobIv: "blob-iv",
      blobAuthTag: "blob-tag",
      isArchived: false,
      org: orgKeyData,
      tags: [],
      createdBy: { id: "u1", name: "User", image: null },
      updatedBy: { id: "u1", name: "User" },
      favorites: [],
      createdAt: now,
      updatedAt: now,
    });
    mockDecryptServerData.mockReturnValue(
      JSON.stringify({
        title: "My Visa",
        cardholderName: "John Doe",
        cardNumber: "4111111111111111",
        brand: "Visa",
        expiryMonth: "12",
        expiryYear: "2028",
        cvv: "123",
        notes: "Personal card",
      })
    );

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.entryType).toBe("CREDIT_CARD");
    expect(json.title).toBe("My Visa");
    expect(json.cardholderName).toBe("John Doe");
    expect(json.cardNumber).toBe("4111111111111111");
    expect(json.brand).toBe("Visa");
    expect(json.expiryMonth).toBe("12");
    expect(json.expiryYear).toBe("2028");
    expect(json.cvv).toBe("123");
    expect(json.notes).toBe("Personal card");
  });

  it("returns IDENTITY with identity fields", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: "IDENTITY",
      encryptedBlob: "blob-cipher",
      blobIv: "blob-iv",
      blobAuthTag: "blob-tag",
      isArchived: false,
      org: orgKeyData,
      tags: [],
      createdBy: { id: "u1", name: "User", image: null },
      updatedBy: { id: "u1", name: "User" },
      favorites: [],
      createdAt: now,
      updatedAt: now,
    });
    mockDecryptServerData.mockReturnValue(
      JSON.stringify({
        title: "My Passport",
        fullName: "John Doe",
        address: "123 Main St",
        phone: "+81-90-1234-5678",
        email: "john@example.com",
        dateOfBirth: "1990-01-15",
        nationality: "Japan",
        idNumber: "AB1234567",
        issueDate: "2020-01-01",
        expiryDate: "2030-01-01",
        notes: "Keep safe",
      })
    );

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.entryType).toBe("IDENTITY");
    expect(json.title).toBe("My Passport");
    expect(json.fullName).toBe("John Doe");
    expect(json.address).toBe("123 Main St");
    expect(json.phone).toBe("+81-90-1234-5678");
    expect(json.email).toBe("john@example.com");
    expect(json.dateOfBirth).toBe("1990-01-15");
    expect(json.nationality).toBe("Japan");
    expect(json.idNumber).toBe("AB1234567");
    expect(json.issueDate).toBe("2020-01-01");
    expect(json.expiryDate).toBe("2030-01-01");
    expect(json.notes).toBe("Keep safe");
  });

  it("returns PASSKEY with passkey fields", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: ENTRY_TYPE.PASSKEY,
      encryptedBlob: "blob-cipher",
      blobIv: "blob-iv",
      blobAuthTag: "blob-tag",
      isArchived: false,
      org: orgKeyData,
      tags: [],
      createdBy: { id: "u1", name: "User", image: null },
      updatedBy: { id: "u1", name: "User" },
      favorites: [],
      createdAt: now,
      updatedAt: now,
    });
    mockDecryptServerData.mockReturnValue(
      JSON.stringify({
        title: "FIDO Key",
        relyingPartyId: "example.com",
        relyingPartyName: "Example",
        username: "alice@example.com",
        credentialId: "cred-123",
      })
    );

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.entryType).toBe(ENTRY_TYPE.PASSKEY);
    expect(json.relyingPartyId).toBe("example.com");
    expect(json.username).toBe("alice@example.com");
    expect(json.credentialId).toBe("cred-123");
  });

  it("passes AAD to decryptServerData for aadVersion >= 1 entries", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: ENTRY_TYPE.LOGIN,
      aadVersion: 1,
      encryptedBlob: "blob-cipher",
      blobIv: "blob-iv",
      blobAuthTag: "blob-tag",
      isArchived: false,
      org: orgKeyData,
      tags: [],
      createdBy: { id: "u1", name: "User", image: null },
      updatedBy: { id: "u1", name: "User" },
      favorites: [],
      createdAt: now,
      updatedAt: now,
    });
    mockDecryptServerData.mockReturnValue(
      JSON.stringify({ title: "Test", username: "admin", password: "secret", url: null, notes: null })
    );

    await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );

    const decryptCall = mockDecryptServerData.mock.calls[0];
    expect(decryptCall[2]).toBeInstanceOf(Buffer);
  });

  it("passes undefined AAD for legacy entries (aadVersion=0)", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: ENTRY_TYPE.LOGIN,
      aadVersion: 0,
      encryptedBlob: "blob-cipher",
      blobIv: "blob-iv",
      blobAuthTag: "blob-tag",
      isArchived: false,
      org: orgKeyData,
      tags: [],
      createdBy: { id: "u1", name: "User", image: null },
      updatedBy: { id: "u1", name: "User" },
      favorites: [],
      createdAt: now,
      updatedAt: now,
    });
    mockDecryptServerData.mockReturnValue(
      JSON.stringify({ title: "Test", username: "admin", password: "secret", url: null, notes: null })
    );

    await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );

    const decryptCall = mockDecryptServerData.mock.calls[0];
    expect(decryptCall[2]).toBeUndefined();
  });

  it("returns SECURE_NOTE with content instead of password", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: "SECURE_NOTE",
      encryptedBlob: "blob-cipher",
      blobIv: "blob-iv",
      blobAuthTag: "blob-tag",
      isArchived: false,
      org: orgKeyData,
      tags: [],
      createdBy: { id: "u1", name: "User", image: null },
      updatedBy: { id: "u1", name: "User" },
      favorites: [],
      createdAt: now,
      updatedAt: now,
    });
    mockDecryptServerData.mockReturnValue(
      JSON.stringify({ title: "My Note", content: "Secret content here" })
    );

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.title).toBe("My Note");
    expect(json.content).toBe("Secret content here");
    expect(json.entryType).toBe("SECURE_NOTE");
  });

  it("returns orgFolderId in GET response when entry has a folder", async () => {
    const FOLDER_CUID = "cm1234567890abcdefghijkl1";
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: ENTRY_TYPE.LOGIN,
      orgFolderId: FOLDER_CUID,
      encryptedBlob: "blob-cipher",
      blobIv: "blob-iv",
      blobAuthTag: "blob-tag",
      isArchived: false,
      org: orgKeyData,
      tags: [],
      createdBy: { id: "u1", name: "User", image: null },
      updatedBy: { id: "u1", name: "User" },
      favorites: [],
      createdAt: now,
      updatedAt: now,
    });
    mockDecryptServerData.mockReturnValue(
      JSON.stringify({ title: "My PW", username: "admin", password: "secret", url: null, notes: null })
    );

    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.orgFolderId).toBe(FOLDER_CUID);
  });
});

describe("PUT /api/orgs/[orgId]/passwords/[id]", () => {
  const txMock = {
    orgPasswordEntryHistory: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgMember.mockResolvedValue({ id: "member-1", role: ORG_ROLE.ADMIN, userId: "test-user-id" });
    mockHasOrgPermission.mockReturnValue(true);
    mockUnwrapOrgKey.mockReturnValue(Buffer.alloc(32));
    mockDecryptServerData.mockReturnValue(
      JSON.stringify({ title: "Old", username: "old", password: "old", url: null, notes: null })
    );
    mockEncryptServerData.mockReturnValue({ ciphertext: "enc", iv: "iv", authTag: "tag" });
    mockPrismaTransaction.mockImplementation(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock));
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { title: "New" },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns OrgAuthError status when not a member", async () => {
    mockRequireOrgMember.mockRejectedValue(new OrgAuthError("NOT_ORG_MEMBER", 403));
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { title: "New" },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("rethrows non-OrgAuthError from PUT", async () => {
    mockRequireOrgMember.mockRejectedValue(new Error("unexpected"));
    await expect(
      PUT(
        createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
          body: { title: "New" },
        }),
        createParams({ orgId: ORG_ID, id: PW_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 404 when entry not found for PUT", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { title: "New" },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when user lacks PASSWORD_UPDATE permission", async () => {
    mockHasOrgPermission.mockReturnValue(false);
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      createdById: "test-user-id",
      org: orgKeyData,
    });
    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { title: "New" },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 on malformed JSON for PUT", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      createdById: "test-user-id",
      org: orgKeyData,
    });
    const { NextRequest } = await import("next/server");
    const req = new NextRequest(`http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
      method: "PUT",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await PUT(req, createParams({ orgId: ORG_ID, id: PW_ID }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 when updating LOGIN with invalid tagIds", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: ENTRY_TYPE.LOGIN,
      createdById: "test-user-id",
      encryptedBlob: "old-cipher",
      blobIv: "old-iv",
      blobAuthTag: "old-tag",
      org: orgKeyData,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { tagIds: ["tag-1"] },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );

    expect(res.status).toBe(400);
  });

  it("returns 500 when decrypt fails during PUT", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: "LOGIN",
      createdById: "test-user-id",
      encryptedBlob: "bad",
      blobIv: "iv",
      blobAuthTag: "tag",
      org: orgKeyData,
    });
    mockDecryptServerData.mockImplementation(() => { throw new Error("decrypt failed"); });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { title: "New" },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(500);
  });

  it("updates SECURE_NOTE entry with re-encryption", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: "SECURE_NOTE",
      createdById: "test-user-id",
      encryptedBlob: "old-cipher",
      blobIv: "old-iv",
      blobAuthTag: "old-tag",
      org: orgKeyData,
    });
    mockDecryptServerData.mockReturnValue(
      JSON.stringify({ title: "Old Note", content: "Old content" })
    );
    mockPrismaOrgPasswordEntry.update.mockResolvedValue({
      id: PW_ID,
      entryType: "SECURE_NOTE",
      tags: [],
      updatedAt: now,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { title: "Updated Note", content: "New content" },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.title).toBe("Updated Note");
    expect(mockEncryptServerData).toHaveBeenCalledTimes(2);
  });

  it("returns 403 when MEMBER tries to update another's entry", async () => {
    mockRequireOrgMember.mockResolvedValue({ id: "member-1", role: ORG_ROLE.MEMBER, userId: "test-user-id" });
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      createdById: "other-user",
      org: orgKeyData,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { title: "New" },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("updates password entry with re-encryption", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      createdById: "test-user-id",
      encryptedBlob: "old-cipher",
      blobIv: "old-iv",
      blobAuthTag: "old-tag",
      org: orgKeyData,
    });
    mockPrismaOrgPasswordEntry.update.mockResolvedValue({
      id: PW_ID,
      tags: [],
      updatedAt: now,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { title: "Updated" },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.title).toBe("Updated");
    expect(mockEncryptServerData).toHaveBeenCalledTimes(2); // blob + overview
  });

  it("performs save-time migration: aadVersion=0 entry re-encrypted with AAD", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: ENTRY_TYPE.LOGIN,
      aadVersion: 0,
      createdById: "test-user-id",
      encryptedBlob: "old-cipher",
      blobIv: "old-iv",
      blobAuthTag: "old-tag",
      org: orgKeyData,
    });
    mockPrismaOrgPasswordEntry.update.mockResolvedValue({
      id: PW_ID,
      tags: [],
      updatedAt: now,
    });

    await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { title: "Migrated" },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );

    // Decrypt call: aadVersion=0 → no AAD
    const decryptCall = mockDecryptServerData.mock.calls[0];
    expect(decryptCall[2]).toBeUndefined();

    // Encrypt calls: always with AAD (save-time migration)
    expect(mockEncryptServerData).toHaveBeenCalledTimes(2);
    const blobEncryptCall = mockEncryptServerData.mock.calls[0];
    const overviewEncryptCall = mockEncryptServerData.mock.calls[1];
    expect(blobEncryptCall[2]).toBeInstanceOf(Buffer);
    expect(overviewEncryptCall[2]).toBeInstanceOf(Buffer);

    // Prisma update should set aadVersion=1
    expect(mockPrismaOrgPasswordEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          aadVersion: 1,
        }),
      }),
    );
  });

  it("updates CREDIT_CARD entry with re-encryption", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: "CREDIT_CARD",
      createdById: "test-user-id",
      encryptedBlob: "old-cipher",
      blobIv: "old-iv",
      blobAuthTag: "old-tag",
      org: orgKeyData,
    });
    mockDecryptServerData.mockReturnValue(
      JSON.stringify({
        title: "Old Card",
        cardholderName: "John",
        cardNumber: "4111111111111111",
        brand: "Visa",
        expiryMonth: "12",
        expiryYear: "2028",
        cvv: "123",
        notes: null,
      })
    );
    mockPrismaOrgPasswordEntry.update.mockResolvedValue({
      id: PW_ID,
      tags: [],
      updatedAt: now,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { title: "Updated Card", brand: "Mastercard" },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.title).toBe("Updated Card");
    expect(mockEncryptServerData).toHaveBeenCalledTimes(2);
  });

  it("updates IDENTITY entry with re-encryption", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: "IDENTITY",
      createdById: "test-user-id",
      encryptedBlob: "old-cipher",
      blobIv: "old-iv",
      blobAuthTag: "old-tag",
      org: orgKeyData,
    });
    mockDecryptServerData.mockReturnValue(
      JSON.stringify({
        title: "Old ID",
        fullName: "John Doe",
        idNumber: "AB1234567",
        notes: null,
      })
    );
    mockPrismaOrgPasswordEntry.update.mockResolvedValue({
      id: PW_ID,
      tags: [],
      updatedAt: now,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { title: "Updated ID", fullName: "Jane Doe" },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.title).toBe("Updated ID");
    expect(mockEncryptServerData).toHaveBeenCalledTimes(2);
  });

  it("updates PASSKEY entry with re-encryption", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: ENTRY_TYPE.PASSKEY,
      createdById: "test-user-id",
      encryptedBlob: "old-cipher",
      blobIv: "old-iv",
      blobAuthTag: "old-tag",
      org: orgKeyData,
    });
    mockDecryptServerData.mockReturnValue(
      JSON.stringify({
        title: "Old Key",
        relyingPartyId: "old.example.com",
        username: "old@example.com",
      })
    );
    mockPrismaOrgPasswordEntry.update.mockResolvedValue({
      id: PW_ID,
      entryType: ENTRY_TYPE.PASSKEY,
      tags: [],
      updatedAt: now,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { title: "Updated Key", relyingPartyId: "example.com" },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.title).toBe("Updated Key");
    expect(mockEncryptServerData).toHaveBeenCalledTimes(2);
  });

  it("returns 400 when updating IDENTITY with invalid phone", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: "IDENTITY",
      createdById: "test-user-id",
      encryptedBlob: "old-cipher",
      blobIv: "old-iv",
      blobAuthTag: "old-tag",
      org: orgKeyData,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { phone: "abc-invalid!" },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when updating IDENTITY with invalid email", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: "IDENTITY",
      createdById: "test-user-id",
      encryptedBlob: "old-cipher",
      blobIv: "old-iv",
      blobAuthTag: "old-tag",
      org: orgKeyData,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { email: "not-an-email" },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when updating IDENTITY with expiryDate before issueDate", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: "IDENTITY",
      createdById: "test-user-id",
      encryptedBlob: "old-cipher",
      blobIv: "old-iv",
      blobAuthTag: "old-tag",
      org: orgKeyData,
    });
    mockDecryptServerData.mockReturnValue(
      JSON.stringify({
        title: "My ID",
        issueDate: "2025-01-01",
        expiryDate: "2030-01-01",
      })
    );

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { expiryDate: "2024-06-01" },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when updating IDENTITY with issueDate after existing expiryDate", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: "IDENTITY",
      createdById: "test-user-id",
      encryptedBlob: "old-cipher",
      blobIv: "old-iv",
      blobAuthTag: "old-tag",
      org: orgKeyData,
    });
    mockDecryptServerData.mockReturnValue(
      JSON.stringify({
        title: "My ID",
        issueDate: "2025-01-01",
        expiryDate: "2026-01-01",
      })
    );

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { issueDate: "2027-01-01" },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when updating CREDIT_CARD with non-digit cardNumber", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: "CREDIT_CARD",
      createdById: "test-user-id",
      encryptedBlob: "old-cipher",
      blobIv: "old-iv",
      blobAuthTag: "old-tag",
      org: orgKeyData,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { cardNumber: "4111-1111-1111-1111" },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when updating CREDIT_CARD with invalid Luhn", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: "CREDIT_CARD",
      createdById: "test-user-id",
      encryptedBlob: "old-cipher",
      blobIv: "old-iv",
      blobAuthTag: "old-tag",
      org: orgKeyData,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { cardNumber: "4111111111111112", brand: "Visa" },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when updating CREDIT_CARD with length mismatch", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: "CREDIT_CARD",
      createdById: "test-user-id",
      encryptedBlob: "old-cipher",
      blobIv: "old-iv",
      blobAuthTag: "old-tag",
      org: orgKeyData,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { cardNumber: "4111111111111111", brand: "American Express" },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(400);
  });

  it("updates entry with orgFolderId when folder belongs to same org", async () => {
    const FOLDER_CUID = "cm1234567890abcdefghijkl1";
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: ENTRY_TYPE.LOGIN,
      createdById: "test-user-id",
      encryptedBlob: "old-cipher",
      blobIv: "old-iv",
      blobAuthTag: "old-tag",
      org: orgKeyData,
    });
    mockPrismaOrgFolder.findUnique.mockResolvedValue({ orgId: ORG_ID });
    mockPrismaOrgPasswordEntry.update.mockResolvedValue({
      id: PW_ID,
      entryType: ENTRY_TYPE.LOGIN,
      tags: [],
      updatedAt: now,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { title: "Updated", orgFolderId: FOLDER_CUID },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(200);
    expect(mockPrismaOrgPasswordEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orgFolderId: FOLDER_CUID }),
      }),
    );
  });

  it("returns 400 when orgFolderId belongs to a different org in PUT", async () => {
    const FOLDER_CUID = "cm1234567890abcdefghijkl1";
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: ENTRY_TYPE.LOGIN,
      createdById: "test-user-id",
      encryptedBlob: "old-cipher",
      blobIv: "old-iv",
      blobAuthTag: "old-tag",
      org: orgKeyData,
    });
    mockPrismaOrgFolder.findUnique.mockResolvedValue({ orgId: "other-org-999" });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { title: "Updated", orgFolderId: FOLDER_CUID },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_NOT_FOUND");
  });

  it("returns 400 when orgFolderId does not exist in PUT", async () => {
    const FOLDER_CUID = "cm1234567890abcdefghijkl1";
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: ENTRY_TYPE.LOGIN,
      createdById: "test-user-id",
      encryptedBlob: "old-cipher",
      blobIv: "old-iv",
      blobAuthTag: "old-tag",
      org: orgKeyData,
    });
    mockPrismaOrgFolder.findUnique.mockResolvedValue(null);

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { title: "Updated", orgFolderId: FOLDER_CUID },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("FOLDER_NOT_FOUND");
  });

  it("clears orgFolderId when set to null in PUT", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: ENTRY_TYPE.LOGIN,
      createdById: "test-user-id",
      encryptedBlob: "old-cipher",
      blobIv: "old-iv",
      blobAuthTag: "old-tag",
      org: orgKeyData,
    });
    mockPrismaOrgPasswordEntry.update.mockResolvedValue({
      id: PW_ID,
      entryType: ENTRY_TYPE.LOGIN,
      tags: [],
      updatedAt: now,
    });

    const res = await PUT(
      createRequest("PUT", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        body: { title: "Updated", orgFolderId: null },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(200);
    expect(mockPrismaOrgFolder.findUnique).not.toHaveBeenCalled();
    expect(mockPrismaOrgPasswordEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orgFolderId: null }),
      }),
    );
  });
});

describe("DELETE /api/orgs/[orgId]/passwords/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgPermission.mockResolvedValue({ role: ORG_ROLE.ADMIN });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("returns OrgAuthError status when permission denied for DELETE", async () => {
    mockRequireOrgPermission.mockRejectedValue(new OrgAuthError("INSUFFICIENT_PERMISSION", 403));
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(403);
  });

  it("rethrows non-OrgAuthError from DELETE", async () => {
    mockRequireOrgPermission.mockRejectedValue(new Error("unexpected"));
    await expect(
      DELETE(
        createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
        createParams({ orgId: ORG_ID, id: PW_ID }),
      ),
    ).rejects.toThrow("unexpected");
  });

  it("returns 404 when entry not found", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("soft deletes by default", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({ id: PW_ID, orgId: ORG_ID });
    mockPrismaOrgPasswordEntry.update.mockResolvedValue({});

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockPrismaOrgPasswordEntry.update).toHaveBeenCalled();
  });

  it("permanently deletes when permanent=true", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({ id: PW_ID, orgId: ORG_ID });
    mockPrismaOrgPasswordEntry.delete.mockResolvedValue({});

    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`, {
        searchParams: { permanent: "true" },
      }),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(200);
    expect(mockPrismaOrgPasswordEntry.delete).toHaveBeenCalled();
  });
});
