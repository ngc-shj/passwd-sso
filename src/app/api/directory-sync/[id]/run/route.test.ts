import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "@/__tests__/helpers/mock-auth";
import { createRequest, createParams, parseResponse } from "@/__tests__/helpers/request-builder";

// ── Hoisted mocks ────────────────────────────────────────────

const {
  mockAuth,
  mockTenantMemberFindFirst,
  mockConfigFindFirst,
  mockWithUserTenantRls,
  mockLogAudit,
  mockDispatchTenantWebhook,
  mockRunDirectorySync,
  mockRateLimitCheck,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockTenantMemberFindFirst: vi.fn(),
  mockConfigFindFirst: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockDispatchTenantWebhook: vi.fn(),
  mockRunDirectorySync: vi.fn(),
  mockRateLimitCheck: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantMember: { findFirst: mockTenantMemberFindFirst },
    directorySyncConfig: { findFirst: mockConfigFindFirst },
  },
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test" }),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
  tenantAuditBase: (_req: unknown, userId: string, tenantId: string) => ({
    scope: "TENANT",
    userId,
    tenantId,
    ip: "127.0.0.1",
    userAgent: "test",
  }),
}));
vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchTenantWebhook: mockDispatchTenantWebhook,
}));
vi.mock("@/lib/directory-sync/engine", () => ({
  runDirectorySync: mockRunDirectorySync,
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: vi.fn(() => ({
    check: mockRateLimitCheck,
    clear: vi.fn(),
  })),
}));

import { POST } from "./route";

// ── Test data ────────────────────────────────────────────────

const ROUTE_URL = "http://localhost/api/directory-sync/config-1/run";

const MEMBER = { tenantId: "tenant-1" };

const BASE_CONFIG = {
  id: "config-1",
  provider: "AZURE_AD",
  displayName: "My Azure AD",
  enabled: true,
};

const SUCCESS_RESULT = {
  success: true,
  usersCreated: 2,
  usersUpdated: 1,
  usersDeactivated: 0,
  abortedSafety: false,
  errorMessage: null,
};

const CTX = createParams({ id: "config-1" });

// ── Tests ─────────────────────────────────────────────────────

describe("POST /api/directory-sync/[id]/run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockTenantMemberFindFirst.mockResolvedValue(MEMBER);
    mockConfigFindFirst.mockResolvedValue(BASE_CONFIG);
    mockRunDirectorySync.mockResolvedValue(SUCCESS_RESULT);
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("POST", ROUTE_URL);
    const { status, json } = await parseResponse(await POST(req, CTX));

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when user is not ADMIN/OWNER", async () => {
    mockTenantMemberFindFirst.mockResolvedValue(null);

    const req = createRequest("POST", ROUTE_URL);
    const { status, json } = await parseResponse(await POST(req, CTX));

    expect(status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 404 when config does not exist", async () => {
    mockConfigFindFirst.mockResolvedValue(null);

    const req = createRequest("POST", ROUTE_URL);
    const { status, json } = await parseResponse(await POST(req, CTX));

    expect(status).toBe(404);
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new (await import("next/server")).NextRequest(ROUTE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    } as ConstructorParameters<typeof import("next/server").NextRequest>[1]);

    const { status, json } = await parseResponse(await POST(req, CTX));

    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 for invalid body (dryRun not boolean)", async () => {
    const req = createRequest("POST", ROUTE_URL, { body: { dryRun: "yes" } });
    const { status, json } = await parseResponse(await POST(req, CTX));

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(json.details).toHaveProperty("properties");
  });

  it("runs sync with defaults (dryRun=false, force=false) on empty body", async () => {
    const req = createRequest("POST", ROUTE_URL);
    const { status, json } = await parseResponse(await POST(req, CTX));

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockRunDirectorySync).toHaveBeenCalledWith({
      configId: "config-1",
      tenantId: "tenant-1",
      userId: DEFAULT_SESSION.user.id,
      dryRun: false,
      force: false,
    });
  });

  it("passes dryRun=true and force=true when provided", async () => {
    const req = createRequest("POST", ROUTE_URL, { body: { dryRun: true, force: true } });
    const { status } = await parseResponse(await POST(req, CTX));

    expect(status).toBe(200);
    expect(mockRunDirectorySync).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, force: true }),
    );
  });

  it("returns 409 when sync is already running", async () => {
    mockRunDirectorySync.mockResolvedValue({
      success: false,
      errorMessage: "sync already running",
      usersCreated: 0,
      usersUpdated: 0,
      usersDeactivated: 0,
      abortedSafety: false,
    });

    const req = createRequest("POST", ROUTE_URL);
    const { status, json } = await parseResponse(await POST(req, CTX));

    expect(status).toBe(409);
    expect(json.error).toBe("CONFLICT");
  });

  it("returns 500 when sync fails for other reasons", async () => {
    mockRunDirectorySync.mockResolvedValue({
      success: false,
      errorMessage: "provider unreachable",
      usersCreated: 0,
      usersUpdated: 0,
      usersDeactivated: 0,
      abortedSafety: false,
    });

    const req = createRequest("POST", ROUTE_URL);
    const { status, json } = await parseResponse(await POST(req, CTX));

    expect(status).toBe(500);
    expect(json.error).toBe("SYNC_FAILED");
  });

  it("returns sync result stats on success", async () => {
    const req = createRequest("POST", ROUTE_URL);
    const { status, json } = await parseResponse(await POST(req, CTX));

    expect(status).toBe(200);
    expect(json.usersCreated).toBe(2);
    expect(json.usersUpdated).toBe(1);
    expect(json.usersDeactivated).toBe(0);
  });

  it("calls logAuditAsync with correct metadata on success", async () => {
    const req = createRequest("POST", ROUTE_URL, { body: { dryRun: true } });
    await POST(req, CTX);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "DIRECTORY_SYNC_RUN",
        tenantId: "tenant-1",
        targetId: "config-1",
        metadata: expect.objectContaining({
          provider: "AZURE_AD",
          dryRun: true,
          force: false,
          success: true,
        }),
      }),
    );
  });

  it("does not dispatch webhook for dry runs", async () => {
    const req = createRequest("POST", ROUTE_URL, { body: { dryRun: true } });
    await POST(req, CTX);

    expect(mockDispatchTenantWebhook).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimitCheck.mockResolvedValueOnce({ allowed: false, retryAfterMs: 30_000 });
    const req = createRequest("POST", ROUTE_URL);
    const res = await POST(req, CTX);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
  });
});
