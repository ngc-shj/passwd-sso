import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createRequest, parseResponse } from "../../helpers/request-builder";

const { mockAuth, mockCreate, mockCheck, mockLogAudit } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockCreate: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue(true),
  mockLogAudit: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordShare: { create: mockCreate },
  },
}));
vi.mock("@/lib/crypto-server", () => ({
  generateShareToken: () => "a".repeat(64),
  hashToken: () => "h".repeat(64),
  encryptShareData: () => ({
    ciphertext: "encrypted",
    iv: "i".repeat(24),
    authTag: "t".repeat(32),
  }),
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
}));

import { POST } from "@/app/api/sends/route";

const VALID_BODY = {
  name: "Test Send",
  text: "Hello world",
  expiresIn: "1d",
};

describe("POST /api/sends", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue(true);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createRequest("POST", "http://localhost/api/sends", {
      body: VALID_BODY,
    });
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 429 when rate limited", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockCheck.mockResolvedValue(false);

    const req = createRequest("POST", "http://localhost/api/sends", {
      body: VALID_BODY,
    });
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("returns 400 when name is empty", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    const req = createRequest("POST", "http://localhost/api/sends", {
      body: { ...VALID_BODY, name: "" },
    });
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when text is empty", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    const req = createRequest("POST", "http://localhost/api/sends", {
      body: { ...VALID_BODY, text: "" },
    });
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when text exceeds 50,000 chars", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    const req = createRequest("POST", "http://localhost/api/sends", {
      body: { ...VALID_BODY, text: "x".repeat(50_001) },
    });
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("accepts text at exactly 50,000 chars", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockCreate.mockResolvedValue({
      id: "share-1",
      expiresAt: new Date(),
    });

    const req = createRequest("POST", "http://localhost/api/sends", {
      body: { ...VALID_BODY, text: "x".repeat(50_000) },
    });
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.token).toBeDefined();
  });

  it("returns 400 when expiresIn is invalid", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    const req = createRequest("POST", "http://localhost/api/sends", {
      body: { ...VALID_BODY, expiresIn: "2h" },
    });
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when maxViews is 0", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    const req = createRequest("POST", "http://localhost/api/sends", {
      body: { ...VALID_BODY, maxViews: 0 },
    });
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when maxViews is 101", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    const req = createRequest("POST", "http://localhost/api/sends", {
      body: { ...VALID_BODY, maxViews: 101 },
    });
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("creates text send successfully and returns token + url", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    const expiresAt = new Date(Date.now() + 86400_000);
    mockCreate.mockResolvedValue({
      id: "share-1",
      expiresAt,
    });

    const req = createRequest("POST", "http://localhost/api/sends", {
      body: VALID_BODY,
    });
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.id).toBe("share-1");
    expect(json.token).toBe("a".repeat(64));
    expect(json.url).toBe(`/s/${"a".repeat(64)}`);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          shareType: "TEXT",
          entryType: null,
          sendName: "Test Send",
          createdById: DEFAULT_SESSION.user.id,
        }),
      })
    );

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SEND_CREATE",
        metadata: expect.objectContaining({ sendType: "TEXT" }),
      })
    );
  });

  it("creates text send with maxViews", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockCreate.mockResolvedValue({
      id: "share-1",
      expiresAt: new Date(),
    });

    const req = createRequest("POST", "http://localhost/api/sends", {
      body: { ...VALID_BODY, maxViews: 5 },
    });
    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          maxViews: 5,
        }),
      })
    );
  });

  it("returns 400 when body is not valid JSON", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    // Send non-JSON body
    const req = new (await import("next/server")).NextRequest(
      "http://localhost/api/sends",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json{{{",
      } as ConstructorParameters<typeof import("next/server").NextRequest>[1]
    );
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 500 when prisma create fails", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockCreate.mockRejectedValue(new Error("DB error"));

    const req = createRequest("POST", "http://localhost/api/sends", {
      body: VALID_BODY,
    });

    await expect(POST(req as never)).rejects.toThrow("DB error");
  });
});
