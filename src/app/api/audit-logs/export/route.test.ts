import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockRequireOrgPermission, OrgAuthError, mockLogAudit } = vi.hoisted(() => {
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
    mockRequireOrgPermission: vi.fn(),
    OrgAuthError: _OrgAuthError,
    mockLogAudit: vi.fn(),
  };
});

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/org-auth", () => ({
  requireOrgPermission: mockRequireOrgPermission,
  OrgAuthError,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
}));

import { POST } from "./route";
import { ORG_ROLE } from "@/lib/constants";

const URL = "http://localhost:3000/api/audit-logs/export";

describe("POST /api/audit-logs/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockRequireOrgPermission.mockResolvedValue({ role: ORG_ROLE.MEMBER });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      createRequest("POST", URL, { body: { entryCount: 5, format: "csv" } })
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new (await import("next/server")).NextRequest(URL, {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 for invalid body", async () => {
    const res = await POST(
      createRequest("POST", URL, { body: { entryCount: -1, format: "xml" } })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_BODY");
  });

  it("logs personal export when no orgId", async () => {
    const res = await POST(
      createRequest("POST", URL, { body: { entryCount: 10, format: "csv" } })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "PERSONAL",
        action: "ENTRY_EXPORT",
        userId: "user-1",
        metadata: { entryCount: 10, format: "csv" },
      })
    );
    expect(mockRequireOrgPermission).not.toHaveBeenCalled();
  });

  it("logs org export when orgId provided and user is member", async () => {
    const res = await POST(
      createRequest("POST", URL, {
        body: { orgId: "org-1", entryCount: 3, format: "json" },
      })
    );
    expect(res.status).toBe(200);
    expect(mockRequireOrgPermission).toHaveBeenCalledWith("user-1", "org-1", "org:update");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "ORG",
        orgId: "org-1",
      })
    );
  });

  it("returns 403 when user lacks org:update permission", async () => {
    mockRequireOrgPermission.mockRejectedValue(new OrgAuthError("FORBIDDEN", 403));
    const res = await POST(
      createRequest("POST", URL, {
        body: { orgId: "org-1", entryCount: 1, format: "csv" },
      })
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("FORBIDDEN");
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("returns 404 when orgId specified but user is not a member", async () => {
    mockRequireOrgPermission.mockRejectedValue(new OrgAuthError("NOT_FOUND", 404));
    const res = await POST(
      createRequest("POST", URL, {
        body: { orgId: "org-other", entryCount: 1, format: "csv" },
      })
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("NOT_FOUND");
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});