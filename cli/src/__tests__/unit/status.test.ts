import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api-client.js", () => ({
  apiRequest: vi.fn(),
  getTokenServerUrl: vi.fn(),
}));

vi.mock("../../lib/vault-state.js", () => ({
  isUnlocked: vi.fn(() => false),
}));

vi.mock("../../lib/config.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../../lib/output.js", () => ({
  error: vi.fn(),
  success: vi.fn(),
  json: vi.fn(),
}));

const { apiRequest, getTokenServerUrl } = await import("../../lib/api-client.js");
const { loadConfig } = await import("../../lib/config.js");
const output = await import("../../lib/output.js");
const { statusCommand } = await import("../../commands/status.js");

describe("statusCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadConfig).mockReturnValue({ serverUrl: "https://config.example.com", locale: "en" });
    vi.mocked(apiRequest).mockResolvedValue({ ok: true, status: 200, data: { setupRequired: false } });
  });

  it("reports the server that issued the stored tokens, which requests are sent to", async () => {
    vi.mocked(getTokenServerUrl).mockReturnValue("https://issuer.example.com");

    await statusCommand({ json: true });

    expect(output.json).toHaveBeenCalledWith(
      expect.objectContaining({ server: "https://issuer.example.com", connected: true }),
    );
  });

  it("falls back to the configured server when not logged in", async () => {
    vi.mocked(getTokenServerUrl).mockImplementation(() => {
      throw new Error("Not logged in. Run `passwd-sso login` first.");
    });
    vi.mocked(apiRequest).mockRejectedValue(new Error("Not logged in. Run `passwd-sso login` first."));

    await statusCommand({ json: true });

    expect(output.json).toHaveBeenCalledWith(
      expect.objectContaining({ server: "https://config.example.com", connected: false }),
    );
  });
});
