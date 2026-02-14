import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockLogAudit } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockLogAudit: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: () => ({ ip: null, userAgent: null }),
}));

import { POST } from "./route";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";

const URL = "http://localhost:3000/api/audit-logs/import";

describe("POST /api/audit-logs/import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", URL, { body: { requestedCount: 1, successCount: 1, failedCount: 0 } }));
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid body", async () => {
    const res = await POST(createRequest("POST", URL, { body: { requestedCount: -1, successCount: 1, failedCount: 0 } }));
    expect(res.status).toBe(400);
  });

  it("logs import summary metadata", async () => {
    const res = await POST(
      createRequest("POST", URL, {
        body: {
          requestedCount: 10,
          successCount: 8,
          failedCount: 2,
          filename: "passwd-sso-export-20260214.encrypted.json",
          format: "json",
          encrypted: true,
        },
      })
    );

    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: AUDIT_SCOPE.PERSONAL,
        action: AUDIT_ACTION.ENTRY_IMPORT,
        metadata: {
          requestedCount: 10,
          successCount: 8,
          failedCount: 2,
          filename: "passwd-sso-export-20260214.encrypted.json",
          format: "json",
          encrypted: true,
        },
      })
    );
  });
});
