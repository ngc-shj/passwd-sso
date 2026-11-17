import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api-client.js", () => ({
  apiRequest: vi.fn(),
}));

vi.mock("../../lib/output.js", () => ({
  error: vi.fn(),
  success: vi.fn(),
  json: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  table: vi.fn(),
}));

const { apiRequest } = await import("../../lib/api-client.js");
const { apiKeyCreateCommand } = await import("../../commands/api-key.js");

describe("apiKeyCreateCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiRequest).mockResolvedValue({
      ok: true,
      status: 201,
      data: { id: "k", token: "api_x", prefix: "api_x", name: "n", scopes: [], expiresAt: "" },
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("sends an expiry of exactly the chosen elapsed days, across a DST fall-back", async () => {
    // The year ahead crosses the November fall-back: a local calendar step
    // would be 365 × 24 h + 1 h, past the server's elapsed-day bound.
    vi.stubEnv("TZ", "America/New_York");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-09T00:00:00Z"));

    await apiKeyCreateCommand({ name: "n", scopes: ["passwords:read"], days: 365 });

    const [, init] = vi.mocked(apiRequest).mock.calls[0];
    const { expiresAt } = (init as { body: { expiresAt: string } }).body;
    expect(Date.parse(expiresAt) - Date.parse("2026-03-09T00:00:00Z")).toBe(365 * 86_400_000);
  });
});
