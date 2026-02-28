import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";
import { ENTRY_TYPE } from "@/lib/constants";

const {
  mockAuth,
  mockPrismaPasswordEntry,
  mockExtTokenFindUnique,
  mockExtTokenUpdate,
  mockPrismaUser,
  mockAuditCreate,
  mockWithUserTenantRls,
  mockWithBypassRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaPasswordEntry: {
    findMany: vi.fn(),
    create: vi.fn(),
    deleteMany: vi.fn(),
  },
  mockExtTokenFindUnique: vi.fn(),
  mockExtTokenUpdate: vi.fn(),
  mockPrismaUser: { findUnique: vi.fn() },
  mockAuditCreate: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockWithBypassRls: vi.fn(async (_prisma: unknown, fn: () => unknown) => fn()),
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordEntry: mockPrismaPasswordEntry,
    user: mockPrismaUser,
    auditLog: { create: mockAuditCreate },
    extensionToken: { findUnique: mockExtTokenFindUnique, update: mockExtTokenUpdate },
  },
}));
vi.mock("@/lib/crypto-server", () => ({
  hashToken: (t: string) => `hashed_${t}`,
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/tenant-rls", () => ({
  withBypassRls: mockWithBypassRls,
}));
vi.mock("@/lib/logger", () => {
  const noop = vi.fn();
  const child = { info: noop, warn: noop, error: noop };
  return {
    default: { info: noop, warn: noop, error: noop, child: vi.fn().mockReturnValue(child) },
    requestContext: { run: (_s: unknown, fn: () => unknown) => fn(), getStore: () => undefined },
    getLogger: () => child,
  };
});

import { GET, POST } from "./route";

const now = new Date("2025-01-01T00:00:00Z");

const mockEntry = {
  id: "pw-1",
  encryptedOverview: "overview-cipher",
  overviewIv: "overview-iv",
  overviewAuthTag: "overview-tag",
  encryptedBlob: "blob-cipher",
  blobIv: "blob-iv",
  blobAuthTag: "blob-tag",
  keyVersion: 1,
  aadVersion: 0,
  entryType: ENTRY_TYPE.LOGIN,
  isFavorite: false,
  isArchived: false,
  requireReprompt: false,
  expiresAt: null as Date | null,
  tags: [{ id: "t1" }],
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
};

describe("GET /api/passwords", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockPrismaUser.findUnique.mockResolvedValue({ tenantId: "tenant-1" });
    mockPrismaPasswordEntry.deleteMany.mockResolvedValue({ count: 0 });
    mockExtTokenUpdate.mockResolvedValue({});
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    mockExtTokenFindUnique.mockResolvedValue(null);
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    expect(res.status).toBe(401);
  });

  it("accepts extension token with passwords:read scope", async () => {
    mockAuth.mockResolvedValue(null);
    mockExtTokenFindUnique.mockResolvedValue({
      id: "tok-1",
      userId: "token-user",
      scope: "passwords:read",
      expiresAt: new Date("2030-01-01"),
      revokedAt: null,
    });
    mockPrismaPasswordEntry.findMany.mockResolvedValue([mockEntry]);

    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords", {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
  });

  it("returns 403 when extension token lacks required scope", async () => {
    mockAuth.mockResolvedValue(null);
    mockExtTokenFindUnique.mockResolvedValue({
      id: "tok-2",
      userId: "token-user",
      scope: "vault:unlock-data",
      expiresAt: new Date("2030-01-01"),
      revokedAt: null,
    });

    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords", {
      headers: { Authorization: `Bearer ${"b".repeat(64)}` },
    }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("EXTENSION_TOKEN_SCOPE_INSUFFICIENT");
  });

  it("returns password entries with encrypted overviews and entryType", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([mockEntry]);
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toHaveLength(1);
    expect(json[0].encryptedOverview).toEqual({
      ciphertext: "overview-cipher",
      iv: "overview-iv",
      authTag: "overview-tag",
    });
    expect(json[0].entryType).toBe(ENTRY_TYPE.LOGIN);
    expect(json[0].tagIds).toEqual(["t1"]);
    // Should not include blob by default
    expect(json[0].encryptedBlob).toBeUndefined();
  });

  it("returns SECURE_NOTE entryType", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([
      { ...mockEntry, id: "pw-note", entryType: "SECURE_NOTE" },
    ]);
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    const json = await res.json();
    expect(json[0].entryType).toBe("SECURE_NOTE");
  });

  it("includes blob when include=blob", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([mockEntry]);
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords", {
      searchParams: { include: "blob" },
    }));
    const json = await res.json();
    expect(json[0].encryptedBlob).toEqual({
      ciphertext: "blob-cipher",
      iv: "blob-iv",
      authTag: "blob-tag",
    });
  });

  it("returns empty array when no entries", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    const json = await res.json();
    expect(json).toEqual([]);
  });

  it("filters by entryType when type query param is provided", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    await GET(createRequest("GET", "http://localhost:3000/api/passwords", {
      searchParams: { type: "CREDIT_CARD" },
    }));
    expect(mockPrismaPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entryType: "CREDIT_CARD" }),
      })
    );
  });

  it("does not filter by entryType when type param is absent", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    const call = mockPrismaPasswordEntry.findMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty("entryType");
  });

  it("filters by trash when trash=true", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    await GET(createRequest("GET", "http://localhost:3000/api/passwords", {
      searchParams: { trash: "true" },
    }));
    expect(mockPrismaPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: { not: null } }),
      })
    );
  });

  it("returns aadVersion in response entries", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([
      { ...mockEntry, aadVersion: 1 },
    ]);
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    const json = await res.json();
    expect(json[0].aadVersion).toBe(1);
  });

  it("returns aadVersion=0 for legacy entries", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([mockEntry]);
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    const json = await res.json();
    expect(json[0].aadVersion).toBe(0);
  });

  it("excludes deleted items by default", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    expect(mockPrismaPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: null }),
      })
    );
  });

  it("filters by archived when archived=true", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    await GET(createRequest("GET", "http://localhost:3000/api/passwords", {
      searchParams: { archived: "true" },
    }));
    expect(mockPrismaPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isArchived: true }),
      })
    );
  });

  it("excludes archived items by default", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    expect(mockPrismaPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isArchived: false }),
      })
    );
  });

  it("filters by favorites when favorites=true", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    await GET(createRequest("GET", "http://localhost:3000/api/passwords", {
      searchParams: { favorites: "true" },
    }));
    expect(mockPrismaPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isFavorite: true }),
      })
    );
  });

  it("filters by tag when tag param is provided", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    await GET(createRequest("GET", "http://localhost:3000/api/passwords", {
      searchParams: { tag: "tag-123" },
    }));
    expect(mockPrismaPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tags: { some: { id: "tag-123" } },
        }),
      })
    );
  });
});

describe("POST /api/passwords", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
    mockAuditCreate.mockResolvedValue({});
  });

  const validBody = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    encryptedBlob: { ciphertext: "blob", iv: "a".repeat(24), authTag: "b".repeat(32) },
    encryptedOverview: { ciphertext: "over", iv: "c".repeat(24), authTag: "d".repeat(32) },
    keyVersion: 1,
  };

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: validBody,
    }));
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid body", async () => {
    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: { encryptedBlob: "not-an-object" },
    }));
    expect(res.status).toBe(400);
  });

  it("creates password entry (201)", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-pw",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      entryType: ENTRY_TYPE.LOGIN,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: validBody,
    }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.id).toBe("new-pw");
    expect(json.entryType).toBe(ENTRY_TYPE.LOGIN);
    expect(json.tagIds).toEqual([]);
  });

  it("creates entry with client-generated id and aadVersion", async () => {
    const clientId = "550e8400-e29b-41d4-a716-446655440000";
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: clientId,
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      aadVersion: 1,
      entryType: ENTRY_TYPE.LOGIN,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: { ...validBody, id: clientId, aadVersion: 1 },
    }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.id).toBe(clientId);
    expect(json.aadVersion).toBe(1);
    expect(mockPrismaPasswordEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: clientId,
          aadVersion: 1,
        }),
      }),
    );
  });

  it("creates entry without id (legacy aadVersion=0)", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-pw",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      aadVersion: 0,
      entryType: ENTRY_TYPE.LOGIN,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: _, ...bodyWithoutId } = validBody;
    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: { ...bodyWithoutId, aadVersion: 0 },
    }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.aadVersion).toBe(0);
    const createCall = mockPrismaPasswordEntry.create.mock.calls[0][0];
    expect(createCall.data).not.toHaveProperty("id");
  });

  it("creates SECURE_NOTE entry (201)", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-note",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      entryType: "SECURE_NOTE",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: { ...validBody, entryType: "SECURE_NOTE" },
    }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.entryType).toBe("SECURE_NOTE");
  });

  it("marks ENTRY_CREATE audit metadata when source is import", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-pw",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      entryType: ENTRY_TYPE.LOGIN,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: validBody,
      headers: { "x-passwd-sso-source": "import" },
    }));

    expect(res.status).toBe(201);
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ENTRY_CREATE",
          metadata: {
            source: "import",
            parentAction: "ENTRY_IMPORT",
          },
        }),
      }),
    );
  });

  it("stores import filename in audit metadata when provided", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-pw",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      entryType: ENTRY_TYPE.LOGIN,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: validBody,
      headers: {
        "x-passwd-sso-source": "import",
        "x-passwd-sso-filename": "passwd-sso-import.csv",
      },
    }));

    expect(res.status).toBe(201);
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: {
            source: "import",
            filename: "passwd-sso-import.csv",
            parentAction: "ENTRY_IMPORT",
          },
        }),
      }),
    );
  });

  it("sanitizes path separators in import filename", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-pw",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      entryType: ENTRY_TYPE.LOGIN,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: validBody,
      headers: {
        "x-passwd-sso-source": "import",
        "x-passwd-sso-filename": "../../etc/passwd",
      },
    }));

    expect(res.status).toBe(201);
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            filename: ".._.._etc_passwd",
          }),
        }),
      }),
    );
  });

  it("sanitizes backslashes in import filename", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-pw",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      entryType: ENTRY_TYPE.LOGIN,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: validBody,
      headers: {
        "x-passwd-sso-source": "import",
        "x-passwd-sso-filename": "..\\..\\etc\\passwd",
      },
    }));

    expect(res.status).toBe(201);
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            filename: ".._.._etc_passwd",
          }),
        }),
      }),
    );
  });

  it("strips null bytes and control chars from import filename", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-pw",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      entryType: ENTRY_TYPE.LOGIN,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST({
      url: "http://localhost/api/passwords",
      method: "POST",
      headers: {
        get: (key: string) => {
          if (key.toLowerCase() === "x-passwd-sso-source") return "import";
          if (key.toLowerCase() === "x-passwd-sso-filename") return "file\0name\x1f.csv";
          return null;
        },
      },
      json: async () => validBody,
    } as never);

    expect(res.status).toBe(201);
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            filename: "filename.csv",
          }),
        }),
      }),
    );
  });

  it("returns no filename when sanitized result is empty", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-pw",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      entryType: ENTRY_TYPE.LOGIN,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST({
      url: "http://localhost/api/passwords",
      method: "POST",
      headers: {
        get: (key: string) => {
          if (key.toLowerCase() === "x-passwd-sso-source") return "import";
          if (key.toLowerCase() === "x-passwd-sso-filename") return "\0\x01\x02";
          return null;
        },
      },
      json: async () => validBody,
    } as never);

    expect(res.status).toBe(201);
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: {
            source: "import",
            parentAction: "ENTRY_IMPORT",
          },
        }),
      }),
    );
  });

  it("truncates sanitized filename to 255 chars", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-pw",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      entryType: ENTRY_TYPE.LOGIN,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const longName = `${"a".repeat(400)}.csv`;
    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: validBody,
      headers: {
        "x-passwd-sso-source": "import",
        "x-passwd-sso-filename": longName,
      },
    }));

    expect(res.status).toBe(201);
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            filename: "a".repeat(255),
          }),
        }),
      }),
    );
  });

  it("creates CREDIT_CARD entry (201)", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-card",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      entryType: "CREDIT_CARD",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: { ...validBody, entryType: "CREDIT_CARD" },
    }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.entryType).toBe("CREDIT_CARD");
  });

  it("returns CREDIT_CARD entryType in GET", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([
      { ...mockEntry, id: "pw-card", entryType: "CREDIT_CARD" },
    ]);
    mockPrismaPasswordEntry.deleteMany.mockResolvedValue({ count: 0 });
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    const json = await res.json();
    expect(json[0].entryType).toBe("CREDIT_CARD");
  });

  it("creates IDENTITY entry (201)", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-identity",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      entryType: "IDENTITY",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: { ...validBody, entryType: "IDENTITY" },
    }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.entryType).toBe("IDENTITY");
  });

  it("returns IDENTITY entryType in GET", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([
      { ...mockEntry, id: "pw-identity", entryType: "IDENTITY" },
    ]);
    mockPrismaPasswordEntry.deleteMany.mockResolvedValue({ count: 0 });
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    const json = await res.json();
    expect(json[0].entryType).toBe("IDENTITY");
  });

  it("creates PASSKEY entry (201)", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-passkey",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      entryType: "PASSKEY",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: { ...validBody, entryType: "PASSKEY" },
    }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.entryType).toBe("PASSKEY");
  });

  it("returns PASSKEY entryType in GET", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([
      { ...mockEntry, id: "pw-passkey", entryType: "PASSKEY" },
    ]);
    mockPrismaPasswordEntry.deleteMany.mockResolvedValue({ count: 0 });
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    const json = await res.json();
    expect(json[0].entryType).toBe("PASSKEY");
  });

  it("creates BANK_ACCOUNT entry (201)", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-bank",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      entryType: "BANK_ACCOUNT",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: { ...validBody, entryType: "BANK_ACCOUNT" },
    }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.entryType).toBe("BANK_ACCOUNT");
  });

  it("returns BANK_ACCOUNT entryType in GET", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([
      { ...mockEntry, id: "pw-bank", entryType: "BANK_ACCOUNT" },
    ]);
    mockPrismaPasswordEntry.deleteMany.mockResolvedValue({ count: 0 });
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    const json = await res.json();
    expect(json[0].entryType).toBe("BANK_ACCOUNT");
  });

  it("filters by entryType BANK_ACCOUNT", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    await GET(createRequest("GET", "http://localhost:3000/api/passwords", {
      searchParams: { type: "BANK_ACCOUNT" },
    }));
    expect(mockPrismaPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entryType: "BANK_ACCOUNT" }),
      })
    );
  });

  it("creates SOFTWARE_LICENSE entry (201)", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-license",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      entryType: "SOFTWARE_LICENSE",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: { ...validBody, entryType: "SOFTWARE_LICENSE" },
    }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.entryType).toBe("SOFTWARE_LICENSE");
  });

  it("returns SOFTWARE_LICENSE entryType in GET", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([
      { ...mockEntry, id: "pw-license", entryType: "SOFTWARE_LICENSE" },
    ]);
    mockPrismaPasswordEntry.deleteMany.mockResolvedValue({ count: 0 });
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    const json = await res.json();
    expect(json[0].entryType).toBe("SOFTWARE_LICENSE");
  });

  it("filters by entryType SOFTWARE_LICENSE", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    await GET(createRequest("GET", "http://localhost:3000/api/passwords", {
      searchParams: { type: "SOFTWARE_LICENSE" },
    }));
    expect(mockPrismaPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entryType: "SOFTWARE_LICENSE" }),
      })
    );
  });

  it("creates entry with requireReprompt=true (201)", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-reprompt",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      entryType: ENTRY_TYPE.LOGIN,
      requireReprompt: true,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: { ...validBody, requireReprompt: true },
    }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.requireReprompt).toBe(true);
    expect(mockPrismaPasswordEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requireReprompt: true }),
      }),
    );
  });

  it("ignores invalid entryType query param", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    mockPrismaPasswordEntry.deleteMany.mockResolvedValue({ count: 0 });
    await GET(createRequest("GET", "http://localhost:3000/api/passwords", {
      searchParams: { type: "INVALID_TYPE" },
    }));
    const call = mockPrismaPasswordEntry.findMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty("entryType");
  });

  it("returns requireReprompt in response entries", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([
      { ...mockEntry, requireReprompt: true },
    ]);
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    const json = await res.json();
    expect(json[0].requireReprompt).toBe(true);
  });

  it("filters by entryType PASSKEY", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([]);
    await GET(createRequest("GET", "http://localhost:3000/api/passwords", {
      searchParams: { type: "PASSKEY" },
    }));
    expect(mockPrismaPasswordEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entryType: "PASSKEY" }),
      })
    );
  });

  it("returns expiresAt in GET response", async () => {
    const expiresDate = new Date("2025-06-01");
    mockPrismaPasswordEntry.findMany.mockResolvedValue([
      { ...mockEntry, expiresAt: expiresDate },
    ]);
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    const json = await res.json();
    expect(json[0].expiresAt).toBe(expiresDate.toISOString());
  });

  it("returns expiresAt=null in GET response when not set", async () => {
    mockPrismaPasswordEntry.findMany.mockResolvedValue([mockEntry]);
    const res = await GET(createRequest("GET", "http://localhost:3000/api/passwords"));
    const json = await res.json();
    expect(json[0].expiresAt).toBeNull();
  });

  it("creates entry with expiresAt ISO string → Date conversion", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-expiring",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      entryType: ENTRY_TYPE.LOGIN,
      expiresAt: new Date("2025-06-01T00:00:00.000Z"),
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: { ...validBody, expiresAt: "2025-06-01T00:00:00.000Z" },
    }));
    expect(res.status).toBe(201);
    expect(mockPrismaPasswordEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          expiresAt: new Date("2025-06-01T00:00:00.000Z"),
        }),
      }),
    );
  });

  it("creates entry with expiresAt=null to clear", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-no-expire",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      entryType: ENTRY_TYPE.LOGIN,
      expiresAt: null,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: { ...validBody, expiresAt: null },
    }));
    expect(res.status).toBe(201);
    expect(mockPrismaPasswordEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ expiresAt: null }),
      }),
    );
  });

  it("returns 400 when expiresAt is invalid format", async () => {
    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: { ...validBody, expiresAt: "not-a-date" },
    }));
    expect(res.status).toBe(400);
  });

  it("does not include expiresAt in create data when not provided", async () => {
    mockPrismaPasswordEntry.create.mockResolvedValue({
      id: "new-pw",
      encryptedOverview: "over",
      overviewIv: "c".repeat(24),
      overviewAuthTag: "d".repeat(32),
      keyVersion: 1,
      entryType: ENTRY_TYPE.LOGIN,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    await POST(createRequest("POST", "http://localhost:3000/api/passwords", {
      body: validBody,
    }));
    const createCall = mockPrismaPasswordEntry.create.mock.calls[0][0];
    expect(createCall.data).not.toHaveProperty("expiresAt");
  });
});
