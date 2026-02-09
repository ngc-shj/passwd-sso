import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockPrismaOrgInvitation, mockPrismaOrgMember, mockTransaction } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrismaOrgInvitation: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  mockPrismaOrgMember: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  mockTransaction: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgInvitation: mockPrismaOrgInvitation,
    orgMember: mockPrismaOrgMember,
    $transaction: mockTransaction,
  },
}));

import { POST } from "./route";

const now = new Date("2025-01-01T00:00:00Z");
const futureDate = new Date("2099-01-01T00:00:00Z");

const validInvitation = {
  id: "inv-1",
  orgId: "org-1",
  email: "user@test.com",
  role: "MEMBER",
  token: "valid-token",
  status: "PENDING",
  expiresAt: futureDate,
  org: { id: "org-1", name: "My Org", slug: "my-org" },
};

describe("POST /api/orgs/invitations/accept", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id", email: "user@test.com" } });
    mockTransaction.mockResolvedValue([{}, {}]);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost:3000/api/orgs/invitations/accept", {
      body: { token: "abc" },
    }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when token missing", async () => {
    const res = await POST(createRequest("POST", "http://localhost:3000/api/orgs/invitations/accept", {
      body: {},
    }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when token is invalid", async () => {
    mockPrismaOrgInvitation.findUnique.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost:3000/api/orgs/invitations/accept", {
      body: { token: "invalid" },
    }));
    expect(res.status).toBe(404);
  });

  it("returns 410 when invitation already used", async () => {
    mockPrismaOrgInvitation.findUnique.mockResolvedValue({
      ...validInvitation,
      status: "ACCEPTED",
    });
    const res = await POST(createRequest("POST", "http://localhost:3000/api/orgs/invitations/accept", {
      body: { token: "valid-token" },
    }));
    expect(res.status).toBe(410);
  });

  it("returns 410 when invitation expired", async () => {
    mockPrismaOrgInvitation.findUnique.mockResolvedValue({
      ...validInvitation,
      expiresAt: new Date("2020-01-01"),
    });
    const res = await POST(createRequest("POST", "http://localhost:3000/api/orgs/invitations/accept", {
      body: { token: "valid-token" },
    }));
    expect(res.status).toBe(410);
  });

  it("returns 403 when email doesn't match", async () => {
    mockAuth.mockResolvedValue({ user: { id: "test-user-id", email: "other@test.com" } });
    mockPrismaOrgInvitation.findUnique.mockResolvedValue(validInvitation);
    const res = await POST(createRequest("POST", "http://localhost:3000/api/orgs/invitations/accept", {
      body: { token: "valid-token" },
    }));
    expect(res.status).toBe(403);
  });

  it("handles already-member case gracefully", async () => {
    mockPrismaOrgInvitation.findUnique.mockResolvedValue(validInvitation);
    mockPrismaOrgMember.findUnique.mockResolvedValue({ id: "existing-member" });

    const res = await POST(createRequest("POST", "http://localhost:3000/api/orgs/invitations/accept", {
      body: { token: "valid-token" },
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.alreadyMember).toBe(true);
  });

  it("accepts invitation and creates membership", async () => {
    mockPrismaOrgInvitation.findUnique.mockResolvedValue(validInvitation);
    mockPrismaOrgMember.findUnique.mockResolvedValue(null);

    const res = await POST(createRequest("POST", "http://localhost:3000/api/orgs/invitations/accept", {
      body: { token: "valid-token" },
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.alreadyMember).toBe(false);
    expect(json.role).toBe("MEMBER");
    expect(json.org.name).toBe("My Org");
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });
});
