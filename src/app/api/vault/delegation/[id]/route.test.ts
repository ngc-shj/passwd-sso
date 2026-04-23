import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockAuth,
  mockResolveUserTenantId,
  mockAssertOrigin,
  mockRevokeDelegationSession,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockResolveUserTenantId: vi.fn(),
  mockAssertOrigin: vi.fn(() => null),
  mockRevokeDelegationSession: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/tenant-context", () => ({ resolveUserTenantId: mockResolveUserTenantId }));
vi.mock("@/lib/auth/csrf", () => ({ assertOrigin: mockAssertOrigin }));
vi.mock("@/lib/auth/delegation", () => ({
  revokeDelegationSession: mockRevokeDelegationSession,
}));
vi.mock("@/lib/with-request-log", () => ({
  withRequestLog: (handler: unknown) => handler,
}));

import { DELETE } from "./route";
import { NextRequest } from "next/server";

// ─── Fixtures ───────────────────────────────────────────────────

const USER_ID = "user-abc-123";
const TENANT_ID = "tenant-abc-456";
const SESSION_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

const makeDeleteRequest = (id: string) =>
  new NextRequest(`http://localhost/api/vault/delegation/${id}`, {
    method: "DELETE",
    headers: { Origin: "http://localhost" },
  });

const params = (id: string) => ({ params: Promise.resolve({ id }) });

// ─── Tests ──────────────────────────────────────────────────────

describe("DELETE /api/vault/delegation/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertOrigin.mockReturnValue(null);
    mockAuth.mockResolvedValue({ user: { id: USER_ID } });
    mockResolveUserTenantId.mockResolvedValue(TENANT_ID);
    mockRevokeDelegationSession.mockResolvedValue(true);
  });

  it("returns 401 when no session", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(makeDeleteRequest(SESSION_ID), params(SESSION_ID));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 when no tenant", async () => {
    mockResolveUserTenantId.mockResolvedValue(null);
    const res = await DELETE(makeDeleteRequest(SESSION_ID), params(SESSION_ID));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("NO_TENANT");
  });

  it("returns 400 for invalid UUID", async () => {
    const res = await DELETE(makeDeleteRequest("not-a-uuid"), params("not-a-uuid"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_SESSION");
  });

  it("returns 404 when session not found or already revoked", async () => {
    mockRevokeDelegationSession.mockResolvedValue(false);
    const res = await DELETE(makeDeleteRequest(SESSION_ID), params(SESSION_ID));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("SESSION_NOT_FOUND");
  });

  it("returns 200 with revoked: true on success", async () => {
    const res = await DELETE(makeDeleteRequest(SESSION_ID), params(SESSION_ID));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.revoked).toBe(true);
  });

  it("calls revokeDelegationSession with correct args", async () => {
    await DELETE(makeDeleteRequest(SESSION_ID), params(SESSION_ID));
    expect(mockRevokeDelegationSession).toHaveBeenCalledWith(
      USER_ID,
      SESSION_ID,
      TENANT_ID,
    );
  });

  it("returns CSRF error when origin check fails", async () => {
    const csrfResponse = new Response(JSON.stringify({ error: "CSRF" }), { status: 403 });
    mockAssertOrigin.mockReturnValue(csrfResponse);
    const res = await DELETE(makeDeleteRequest(SESSION_ID), params(SESSION_ID));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBeDefined();
  });

});
