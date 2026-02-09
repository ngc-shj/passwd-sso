import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams } from "@/__tests__/helpers/request-builder";

const {
  mockAuth, mockPrismaOrgPasswordEntry, mockRequireOrgPermission,
  mockRequireOrgMember, mockHasOrgPermission, mockUnwrapOrgKey,
  mockEncryptServerData, mockDecryptServerData, OrgAuthError,
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
    mockRequireOrgPermission: vi.fn(),
    mockRequireOrgMember: vi.fn(),
    mockHasOrgPermission: vi.fn(),
    mockUnwrapOrgKey: vi.fn(),
    mockEncryptServerData: vi.fn(),
    mockDecryptServerData: vi.fn(),
    OrgAuthError: _OrgAuthError,
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { orgPasswordEntry: mockPrismaOrgPasswordEntry },
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

const ORG_ID = "org-123";
const PW_ID = "pw-456";
const now = new Date("2025-01-01T00:00:00Z");

const orgKeyData = { encryptedOrgKey: "ek", orgKeyIv: "iv", orgKeyAuthTag: "tag" };

describe("GET /api/orgs/[orgId]/passwords/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgPermission.mockResolvedValue({ role: "MEMBER" });
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

  it("returns 404 when entry not found", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue(null);
    const res = await GET(
      createRequest("GET", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(404);
  });

  it("returns decrypted password details", async () => {
    mockPrismaOrgPasswordEntry.findUnique.mockResolvedValue({
      id: PW_ID,
      orgId: ORG_ID,
      entryType: "LOGIN",
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
});

describe("PUT /api/orgs/[orgId]/passwords/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgMember.mockResolvedValue({ id: "member-1", role: "ADMIN", userId: "test-user-id" });
    mockHasOrgPermission.mockReturnValue(true);
    mockUnwrapOrgKey.mockReturnValue(Buffer.alloc(32));
    mockDecryptServerData.mockReturnValue(
      JSON.stringify({ title: "Old", username: "old", password: "old", url: null, notes: null })
    );
    mockEncryptServerData.mockReturnValue({ ciphertext: "enc", iv: "iv", authTag: "tag" });
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

  it("returns 403 when MEMBER tries to update another's entry", async () => {
    mockRequireOrgMember.mockResolvedValue({ id: "member-1", role: "MEMBER", userId: "test-user-id" });
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
});

describe("DELETE /api/orgs/[orgId]/passwords/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockRequireOrgPermission.mockResolvedValue({ role: "ADMIN" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(
      createRequest("DELETE", `http://localhost:3000/api/orgs/${ORG_ID}/passwords/${PW_ID}`),
      createParams({ orgId: ORG_ID, id: PW_ID }),
    );
    expect(res.status).toBe(401);
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
