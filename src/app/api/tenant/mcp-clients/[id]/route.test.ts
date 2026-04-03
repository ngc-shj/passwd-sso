import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../../../../__tests__/helpers/mock-auth";
import { createRequest, createParams, parseResponse } from "../../../../../__tests__/helpers/request-builder";

const {
  mockAuth,
  mockRequireTenantPermission,
  mockWithTenantRls,
  mockLogAudit,
  mockMcpClientFindFirst,
  mockMcpClientUpdate,
  mockMcpClientDelete,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireTenantPermission: vi.fn(),
  mockWithTenantRls: vi.fn(async (_prisma: unknown, _tenantId: unknown, fn: () => unknown) => fn()),
  mockLogAudit: vi.fn(),
  mockMcpClientFindFirst: vi.fn(),
  mockMcpClientUpdate: vi.fn(),
  mockMcpClientDelete: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/tenant-auth", () => {
  class TenantAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    requireTenantPermission: mockRequireTenantPermission,
    TenantAuthError,
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    mcpClient: {
      findFirst: mockMcpClientFindFirst,
      update: mockMcpClientUpdate,
      delete: mockMcpClientDelete,
    },
  },
}));
vi.mock("@/lib/tenant-rls", async (importOriginal) => ({ ...(await importOriginal()) as Record<string, unknown>,
  withTenantRls: mockWithTenantRls,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "test", acceptLanguage: null }),
}));

import { GET, PUT, DELETE } from "@/app/api/tenant/mcp-clients/[id]/route";

const ACTOR = { tenantId: "tenant-1", role: "ADMIN" };

const makeClient = (overrides: Record<string, unknown> = {}) => ({
  id: "client-1",
  clientId: "mcpc_abc123",
  name: "my-mcp-client",
  redirectUris: ["https://example.com/callback"],
  allowedScopes: "credentials:read",
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe("GET /api/tenant/mcp-clients/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns single MCP client", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockMcpClientFindFirst.mockResolvedValue(makeClient());

    const req = createRequest("GET", "http://localhost/api/tenant/mcp-clients/client-1");
    const res = await GET(req, createParams({ id: "client-1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.client.id).toBe("client-1");
    expect(json.client.clientId).toBe("mcpc_abc123");
  });

  it("returns 404 when client not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockMcpClientFindFirst.mockResolvedValue(null);

    const req = createRequest("GET", "http://localhost/api/tenant/mcp-clients/nonexistent");
    const res = await GET(req, createParams({ id: "nonexistent" }));
    const { status } = await parseResponse(res);

    expect(status).toBe(404);
  });
});

describe("PUT /api/tenant/mcp-clients/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates a MCP client successfully", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    // findFirst for existence check
    mockMcpClientFindFirst.mockResolvedValue(makeClient());
    const updated = makeClient({ name: "updated-client", updatedAt: new Date() });
    mockMcpClientUpdate.mockResolvedValue(updated);

    const req = createRequest("PUT", "http://localhost/api/tenant/mcp-clients/client-1", {
      body: { name: "updated-client" },
    });
    const res = await PUT(req, createParams({ id: "client-1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.client.name).toBe("updated-client");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MCP_CLIENT_UPDATE",
        tenantId: "tenant-1",
      }),
    );
  });

  it("returns 404 when client not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockMcpClientFindFirst.mockResolvedValue(null);

    const req = createRequest("PUT", "http://localhost/api/tenant/mcp-clients/nonexistent", {
      body: { name: "updated-client" },
    });
    const res = await PUT(req, createParams({ id: "nonexistent" }));
    const { status } = await parseResponse(res);

    expect(status).toBe(404);
  });
});

describe("DELETE /api/tenant/mcp-clients/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes a MCP client successfully", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockMcpClientFindFirst.mockResolvedValue(makeClient());
    mockMcpClientDelete.mockResolvedValue({});

    const req = createRequest("DELETE", "http://localhost/api/tenant/mcp-clients/client-1");
    const res = await DELETE(req, createParams({ id: "client-1" }));
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MCP_CLIENT_DELETE",
        tenantId: "tenant-1",
      }),
    );
  });

  it("returns 404 when client not found", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockRequireTenantPermission.mockResolvedValue(ACTOR);
    mockMcpClientFindFirst.mockResolvedValue(null);

    const req = createRequest("DELETE", "http://localhost/api/tenant/mcp-clients/nonexistent");
    const res = await DELETE(req, createParams({ id: "nonexistent" }));
    const { status } = await parseResponse(res);

    expect(status).toBe(404);
  });
});
