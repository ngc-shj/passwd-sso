import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockAuth } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));

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
