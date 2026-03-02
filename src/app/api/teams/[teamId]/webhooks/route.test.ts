import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, createParams, parseResponse } from "@/__tests__/helpers/request-builder";

const {
  mockAuth,
  mockPrismaTeamWebhook,
  mockPrismaTeam,
  mockRequireTeamPermission,
  mockWithTeamTenantRls,
  mockLogAudit,
  mockEncryptServerData,
  mockGetCurrentMasterKeyVersion,
  mockGetMasterKeyByVersion,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaTeamWebhook: {
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
  },
  mockPrismaTeam: {
    findUniqueOrThrow: vi.fn(),
  },
  mockRequireTeamPermission: vi.fn(),
  mockWithTeamTenantRls: vi.fn(
    async (_teamId: string, fn: () => unknown) => fn(),
  ),
  mockLogAudit: vi.fn(),
  mockEncryptServerData: vi.fn(() => ({
    ciphertext: "encrypted-secret",
    iv: "abcdef123456abcdef123456",
    authTag: "12345678901234567890123456789012",
  })),
  mockGetCurrentMasterKeyVersion: vi.fn(() => 1),
  mockGetMasterKeyByVersion: vi.fn(() => Buffer.alloc(32)),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamWebhook: mockPrismaTeamWebhook,
    team: mockPrismaTeam,
  },
}));
vi.mock("@/lib/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError: class TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
}));
vi.mock("@/lib/crypto-server", () => ({
  encryptServerData: mockEncryptServerData,
  getCurrentMasterKeyVersion: mockGetCurrentMasterKeyVersion,
  getMasterKeyByVersion: mockGetMasterKeyByVersion,
}));
vi.mock("@/lib/logger", () => ({
  default: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  requestContext: { run: (_l: unknown, fn: () => unknown) => fn() },
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET, POST } from "./route";

type Params = { params: Promise<{ teamId: string }> };

function teamParams(teamId: string = "team-1"): Params {
  return createParams({ teamId });
}

describe("GET /api/teams/[teamId]/webhooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue(undefined);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("GET", "http://localhost:3000/api/teams/team-1/webhooks");
    const { status } = await parseResponse(await GET(req, teamParams()));
    expect(status).toBe(401);
  });

  it("returns 403 when lacking permission", async () => {
    const TeamAuthError = (await import("@/lib/team-auth")).TeamAuthError;
    mockRequireTeamPermission.mockRejectedValue(
      new TeamAuthError("Forbidden", 403),
    );
    const req = createRequest("GET", "http://localhost:3000/api/teams/team-1/webhooks");
    const { status } = await parseResponse(await GET(req, teamParams()));
    expect(status).toBe(403);
  });

  it("returns list of webhooks", async () => {
    mockPrismaTeamWebhook.findMany.mockResolvedValue([
      {
        id: "wh-1",
        url: "https://example.com/hook",
        events: ["ENTRY_CREATE"],
        isActive: true,
        failCount: 0,
        lastDeliveredAt: null,
        lastFailedAt: null,
        lastError: null,
        createdAt: new Date(),
      },
    ]);

    const req = createRequest("GET", "http://localhost:3000/api/teams/team-1/webhooks");
    const { status, json } = await parseResponse(await GET(req, teamParams()));
    expect(status).toBe(200);
    expect(json.webhooks).toHaveLength(1);
    expect(json.webhooks[0].url).toBe("https://example.com/hook");
  });
});

describe("POST /api/teams/[teamId]/webhooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue(undefined);
    mockPrismaTeamWebhook.count.mockResolvedValue(0);
    mockPrismaTeam.findUniqueOrThrow.mockResolvedValue({ tenantId: "tenant-1" });
    mockPrismaTeamWebhook.create.mockResolvedValue({
      id: "wh-new",
      url: "https://example.com/hook",
      events: ["ENTRY_CREATE"],
      isActive: true,
      createdAt: new Date(),
    });
  });

  it("creates a webhook and returns secret", async () => {
    const req = createRequest("POST", "http://localhost:3000/api/teams/team-1/webhooks", {
      body: {
        url: "https://example.com/hook",
        events: ["ENTRY_CREATE"],
      },
    });
    const { status, json } = await parseResponse(await POST(req, teamParams()));
    expect(status).toBe(201);
    expect(json.webhook.id).toBe("wh-new");
    expect(json.secret).toBeDefined();
    expect(typeof json.secret).toBe("string");
  });

  it("returns 400 on invalid URL", async () => {
    const req = createRequest("POST", "http://localhost:3000/api/teams/team-1/webhooks", {
      body: {
        url: "not-a-url",
        events: ["ENTRY_CREATE"],
      },
    });
    const { status } = await parseResponse(await POST(req, teamParams()));
    expect(status).toBe(400);
  });

  it("rejects http:// URLs (requires HTTPS)", async () => {
    const req = createRequest("POST", "http://localhost:3000/api/teams/team-1/webhooks", {
      body: {
        url: "http://example.com/hook",
        events: ["ENTRY_CREATE"],
      },
    });
    const { status } = await parseResponse(await POST(req, teamParams()));
    expect(status).toBe(400);
  });

  it("rejects localhost URLs", async () => {
    const req = createRequest("POST", "http://localhost:3000/api/teams/team-1/webhooks", {
      body: {
        url: "https://localhost/hook",
        events: ["ENTRY_CREATE"],
      },
    });
    const { status } = await parseResponse(await POST(req, teamParams()));
    expect(status).toBe(400);
  });

  it("rejects IP address URLs", async () => {
    const req = createRequest("POST", "http://localhost:3000/api/teams/team-1/webhooks", {
      body: {
        url: "https://127.0.0.1/hook",
        events: ["ENTRY_CREATE"],
      },
    });
    const { status } = await parseResponse(await POST(req, teamParams()));
    expect(status).toBe(400);
  });

  it("returns 400 when webhook limit is reached", async () => {
    mockPrismaTeamWebhook.count.mockResolvedValue(5);
    const req = createRequest("POST", "http://localhost:3000/api/teams/team-1/webhooks", {
      body: {
        url: "https://example.com/hook",
        events: ["ENTRY_CREATE"],
      },
    });
    const { status } = await parseResponse(await POST(req, teamParams()));
    expect(status).toBe(400);
  });

  it("records WEBHOOK_CREATE audit event", async () => {
    const req = createRequest("POST", "http://localhost:3000/api/teams/team-1/webhooks", {
      body: {
        url: "https://example.com/hook",
        events: ["ENTRY_CREATE"],
      },
    });
    await POST(req, teamParams());
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WEBHOOK_CREATE",
      }),
    );
  });

  it("returns 403 when MEMBER tries to create webhook", async () => {
    const TeamAuthError = (await import("@/lib/team-auth")).TeamAuthError;
    mockRequireTeamPermission.mockRejectedValue(
      new TeamAuthError("Forbidden", 403),
    );
    const req = createRequest("POST", "http://localhost:3000/api/teams/team-1/webhooks", {
      body: {
        url: "https://example.com/hook",
        events: ["ENTRY_CREATE"],
      },
    });
    const { status } = await parseResponse(await POST(req, teamParams()));
    expect(status).toBe(403);
  });
});
