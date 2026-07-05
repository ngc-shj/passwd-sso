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
  mockRequireRecentSession,
  mockExecuteRaw,
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
  mockExecuteRaw: vi.fn().mockResolvedValue(1),
  mockRequireTeamPermission: vi.fn(),
  mockWithTeamTenantRls: vi.fn(
    async (_teamId: string, fn: (tenantId: string) => unknown) => fn("22222222-2222-4222-8222-222222222222"),
  ),
  mockLogAudit: vi.fn(),
  mockEncryptServerData: vi.fn(() => ({
    ciphertext: "encrypted-secret",
    iv: "abcdef123456abcdef123456",
    authTag: "12345678901234567890123456789012",
  })),
  mockGetCurrentMasterKeyVersion: vi.fn(() => 1),
  mockGetMasterKeyByVersion: vi.fn(() => Buffer.alloc(32)),
  mockRequireRecentSession: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamWebhook: mockPrismaTeamWebhook,
    team: mockPrismaTeam,
    // The cap-check + create now run under an advisory lock inside one
    // withTeamTenantRls tx (TOCTOU fix); the route calls prisma.$executeRaw
    // for the lock before count/create.
    $executeRaw: mockExecuteRaw,
  },
}));
vi.mock("@/lib/auth/access/team-auth", () => ({
  requireTeamPermission: mockRequireTeamPermission,
  TeamAuthError: class TeamAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "TeamAuthError";
      this.status = status;
    }
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withTeamTenantRls: mockWithTeamTenantRls,
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: vi.fn(() => ({ ip: "127.0.0.1", userAgent: "test" })),
  teamAuditBase: vi.fn((_, userId, teamId) => ({ scope: "TEAM", userId, teamId })),
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
  encryptServerData: mockEncryptServerData,
  getCurrentMasterKeyVersion: mockGetCurrentMasterKeyVersion,
  getMasterKeyByVersion: mockGetMasterKeyByVersion,
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  requireRecentCurrentAuthMethod: mockRequireRecentSession,
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

function teamParams(teamId: string = "33333333-3333-4333-8333-333333333333"): Params {
  return createParams({ teamId });
}

// Asserts the advisory lock ($executeRaw with pg_advisory_xact_lock) was
// acquired inside the count-then-create tx. Mutation-kill: deleting the lock
// line from the production path leaves $executeRaw uncalled with that SQL.
function expectAdvisoryLockAcquired(mock: ReturnType<typeof vi.fn>) {
  expect(
    mock.mock.calls.some((c) => String(c[0]).includes("pg_advisory_xact_lock")),
  ).toBe(true);
}

describe("GET /api/teams/[teamId]/webhooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue(undefined);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = createRequest("GET", "http://localhost:3000/api/teams/33333333-3333-4333-8333-333333333333/webhooks");
    const { status } = await parseResponse(await GET(req, teamParams()));
    expect(status).toBe(401);
  });

  it("returns 403 when lacking permission", async () => {
    const TeamAuthError = (await import("@/lib/auth/access/team-auth")).TeamAuthError;
    mockRequireTeamPermission.mockRejectedValue(
      new TeamAuthError("FORBIDDEN", 403),
    );
    const req = createRequest("GET", "http://localhost:3000/api/teams/33333333-3333-4333-8333-333333333333/webhooks");
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

    const req = createRequest("GET", "http://localhost:3000/api/teams/33333333-3333-4333-8333-333333333333/webhooks");
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
    mockPrismaTeamWebhook.create.mockResolvedValue({
      id: "wh-new",
      url: "https://example.com/hook",
      events: ["ENTRY_CREATE"],
      isActive: true,
      createdAt: new Date(),
    });
  });

  it("creates a webhook and returns secret", async () => {
    const req = createRequest("POST", "http://localhost:3000/api/teams/33333333-3333-4333-8333-333333333333/webhooks", {
      body: {
        url: "https://example.com/hook",
        events: ["ENTRY_CREATE"],
      },
    });
    const res = await POST(req, teamParams());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(201);
    expect(json.webhook.id).toBe("wh-new");
    expect(json.secret).toBeDefined();
    expect(typeof json.secret).toBe("string");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expectAdvisoryLockAcquired(mockExecuteRaw);
  });

  it("returns 400 on invalid URL", async () => {
    const req = createRequest("POST", "http://localhost:3000/api/teams/33333333-3333-4333-8333-333333333333/webhooks", {
      body: {
        url: "not-a-url",
        events: ["ENTRY_CREATE"],
      },
    });
    const { status } = await parseResponse(await POST(req, teamParams()));
    expect(status).toBe(400);
  });

  it("rejects http:// URLs (requires HTTPS)", async () => {
    const req = createRequest("POST", "http://localhost:3000/api/teams/33333333-3333-4333-8333-333333333333/webhooks", {
      body: {
        url: "http://example.com/hook",
        events: ["ENTRY_CREATE"],
      },
    });
    const { status } = await parseResponse(await POST(req, teamParams()));
    expect(status).toBe(400);
  });

  it("rejects localhost URLs", async () => {
    const req = createRequest("POST", "http://localhost:3000/api/teams/33333333-3333-4333-8333-333333333333/webhooks", {
      body: {
        url: "https://localhost/hook",
        events: ["ENTRY_CREATE"],
      },
    });
    const { status } = await parseResponse(await POST(req, teamParams()));
    expect(status).toBe(400);
  });

  it("rejects IP address URLs", async () => {
    const req = createRequest("POST", "http://localhost:3000/api/teams/33333333-3333-4333-8333-333333333333/webhooks", {
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
    const req = createRequest("POST", "http://localhost:3000/api/teams/33333333-3333-4333-8333-333333333333/webhooks", {
      body: {
        url: "https://example.com/hook",
        events: ["ENTRY_CREATE"],
      },
    });
    const { status } = await parseResponse(await POST(req, teamParams()));
    expect(status).toBe(400);
  });

  it("records WEBHOOK_CREATE audit event", async () => {
    const req = createRequest("POST", "http://localhost:3000/api/teams/33333333-3333-4333-8333-333333333333/webhooks", {
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
    const TeamAuthError = (await import("@/lib/auth/access/team-auth")).TeamAuthError;
    mockRequireTeamPermission.mockRejectedValue(
      new TeamAuthError("FORBIDDEN", 403),
    );
    const req = createRequest("POST", "http://localhost:3000/api/teams/33333333-3333-4333-8333-333333333333/webhooks", {
      body: {
        url: "https://example.com/hook",
        events: ["ENTRY_CREATE"],
      },
    });
    const { status } = await parseResponse(await POST(req, teamParams()));
    expect(status).toBe(403);
  });

  it("returns 400 when events array is empty", async () => {
    const req = createRequest("POST", "http://localhost:3000/api/teams/33333333-3333-4333-8333-333333333333/webhooks", {
      body: {
        url: "https://example.com/hook",
        events: [],
      },
    });
    const { status } = await parseResponse(await POST(req, teamParams()));
    expect(status).toBe(400);
  });

  it("returns 400 for invalid event name", async () => {
    const req = createRequest("POST", "http://localhost:3000/api/teams/33333333-3333-4333-8333-333333333333/webhooks", {
      body: {
        url: "https://example.com/hook",
        events: ["INVALID_EVENT"],
      },
    });
    const { status } = await parseResponse(await POST(req, teamParams()));
    expect(status).toBe(400);
  });

  it("returns 400 for personal/tenant-scoped event not in team allowlist", async () => {
    const req = createRequest("POST", "http://localhost:3000/api/teams/33333333-3333-4333-8333-333333333333/webhooks", {
      body: {
        url: "https://example.com/hook",
        events: ["AUTH_LOGIN"],
      },
    });
    const { status } = await parseResponse(await POST(req, teamParams()));
    expect(status).toBe(400);
  });

  it("returns 400 for group name used as event", async () => {
    const req = createRequest("POST", "http://localhost:3000/api/teams/33333333-3333-4333-8333-333333333333/webhooks", {
      body: {
        url: "https://example.com/hook",
        events: ["group:webhook"],
      },
    });
    const { status } = await parseResponse(await POST(req, teamParams()));
    expect(status).toBe(400);
  });

  it("returns 403 when step-up reauth is required", async () => {
    mockRequireRecentSession.mockResolvedValueOnce(
      Response.json({ error: "SESSION_STEP_UP_REQUIRED" }, { status: 403 }),
    );
    const req = createRequest("POST", "http://localhost:3000/api/teams/33333333-3333-4333-8333-333333333333/webhooks", {
      body: {
        url: "https://example.com/hook",
        events: ["ENTRY_CREATE"],
      },
    });
    const res = await POST(req, teamParams());
    const { status, json } = await parseResponse(res);
    expect(status).toBe(403);
    expect(json.error).toBe("SESSION_STEP_UP_REQUIRED");
    expect(mockPrismaTeamWebhook.create).not.toHaveBeenCalled();
  });
});

describe("GET /api/teams/[teamId]/webhooks — response shape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireTeamPermission.mockResolvedValue(undefined);
  });

  it("does not include secret fields in GET response", async () => {
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

    const req = createRequest("GET", "http://localhost:3000/api/teams/33333333-3333-4333-8333-333333333333/webhooks");
    const { json } = await parseResponse(await GET(req, teamParams()));
    const webhook = json.webhooks[0];
    expect(webhook).not.toHaveProperty("secret");
    expect(webhook).not.toHaveProperty("secretEncrypted");
    expect(webhook).not.toHaveProperty("secretIv");
    expect(webhook).not.toHaveProperty("secretAuthTag");
    expect(webhook).not.toHaveProperty("masterKeyVersion");
  });
});
