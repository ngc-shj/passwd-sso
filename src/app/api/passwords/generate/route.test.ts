import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth, mockCheck } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));

import { POST } from "./route";

describe("POST /api/passwords/generate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "test-user-id" } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords/generate", {
      body: { mode: "password", length: 16 },
    }));
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockCheck.mockResolvedValueOnce(false);
    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords/generate", {
      body: { mode: "password", length: 16 },
    }));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("returns 400 on malformed JSON", async () => {
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost:3000/api/passwords/generate", {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_JSON");
  });

  it("returns 400 on invalid body", async () => {
    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords/generate", {
      body: { mode: "unknown" },
    }));
    expect(res.status).toBe(400);
  });

  it("generates password with default settings", async () => {
    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords/generate", {
      body: { mode: "password", length: 20 },
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.password).toBeDefined();
    expect(typeof json.password).toBe("string");
    expect(json.password.length).toBe(20);
  });

  it("generates passphrase", async () => {
    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords/generate", {
      body: { mode: "passphrase", words: 4, separator: "-" },
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.password).toBeDefined();
    // Passphrase should have separator-delimited words
    expect(json.password.includes("-")).toBe(true);
  });

  it("supports legacy requests without mode field", async () => {
    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords/generate", {
      body: { length: 12 },
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.password).toBeDefined();
    expect(json.password.length).toBe(12);
  });

  it("generates password with specific character types", async () => {
    const res = await POST(createRequest("POST", "http://localhost:3000/api/passwords/generate", {
      body: {
        mode: "password",
        length: 16,
        uppercase: true,
        lowercase: true,
        digits: true,
        symbols: "!@#$",
      },
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.password.length).toBe(16);
  });
});
