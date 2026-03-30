import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks must be declared before dynamic imports

const mockLoadConfig = vi.fn();
const mockSaveConfig = vi.fn();
const mockSaveCredentials = vi.fn();

vi.mock("../../lib/config.js", () => ({
  loadConfig: () => mockLoadConfig(),
  saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
  saveCredentials: (...args: unknown[]) => mockSaveCredentials(...args),
}));

const mockSetTokenCache = vi.fn();

vi.mock("../../lib/api-client.js", () => ({
  setTokenCache: (...args: unknown[]) => mockSetTokenCache(...args),
}));

const mockRunOAuthFlow = vi.fn();

vi.mock("../../lib/oauth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/oauth.js")>();
  return {
    ...actual,
    runOAuthFlow: (...args: unknown[]) => mockRunOAuthFlow(...args),
    // keep real validateServerUrl from actual module
  };
});

const mockOutputError = vi.fn();
const mockOutputSuccess = vi.fn();
const mockOutputInfo = vi.fn();
const mockOutputWarn = vi.fn();

vi.mock("../../lib/output.js", () => ({
  error: (...args: unknown[]) => mockOutputError(...args),
  success: (...args: unknown[]) => mockOutputSuccess(...args),
  info: (...args: unknown[]) => mockOutputInfo(...args),
  warn: (...args: unknown[]) => mockOutputWarn(...args),
}));

// Mock node:readline to control prompt responses
let promptAnswer = "";

vi.mock("node:readline", () => ({
  createInterface: () => ({
    question: (_q: string, cb: (answer: string) => void) => {
      cb(promptAnswer);
    },
    close: vi.fn(),
  }),
}));

const { loginCommand } = await import("../../commands/login.js");

describe("loginCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    promptAnswer = "";
    // Default config: no serverUrl saved
    mockLoadConfig.mockReturnValue({ serverUrl: "", locale: "en" });
  });

  describe("Happy path — OAuth login (default)", () => {
    it("calls runOAuthFlow, saves credentials, sets token cache, and outputs success", async () => {
      const oauthResult = {
        accessToken: "mcp_access_token",
        refreshToken: "mcpr_refresh_token",
        expiresIn: 3600,
        scope: "credentials:list",
        clientId: "mcpc_client123",
      };
      mockRunOAuthFlow.mockResolvedValueOnce(oauthResult);

      await loginCommand({ server: "https://example.com" });

      expect(mockRunOAuthFlow).toHaveBeenCalledWith("https://example.com");

      expect(mockSaveCredentials).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: "mcp_access_token",
          refreshToken: "mcpr_refresh_token",
          clientId: "mcpc_client123",
          expiresAt: expect.any(String),
        }),
      );

      expect(mockSetTokenCache).toHaveBeenCalledWith(
        "mcp_access_token",
        expect.any(String),
        "mcpr_refresh_token",
        "mcpc_client123",
      );

      expect(mockOutputSuccess).toHaveBeenCalledWith(
        "Logged in to https://example.com",
      );
    });

    it("saves config with the provided server URL before calling OAuth flow", async () => {
      mockRunOAuthFlow.mockResolvedValueOnce({
        accessToken: "tok",
        refreshToken: "ref",
        expiresIn: 3600,
        scope: "",
        clientId: "cid",
      });

      await loginCommand({ server: "https://example.com" });

      expect(mockSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ serverUrl: "https://example.com" }),
      );
    });
  });

  describe("Happy path — Manual token login (--token)", () => {
    it("prompts for token, saves credentials with empty refreshToken/clientId, outputs warn and success", async () => {
      promptAnswer = "mymanualtoken123";

      await loginCommand({ server: "https://example.com", useToken: true });

      expect(mockSaveCredentials).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: "mymanualtoken123",
          refreshToken: "",
          clientId: "",
          expiresAt: expect.any(String),
        }),
      );

      expect(mockSetTokenCache).toHaveBeenCalledWith(
        "mymanualtoken123",
        expect.any(String),
      );

      expect(mockOutputWarn).toHaveBeenCalledWith(
        expect.stringContaining("Manual token will not auto-refresh"),
      );

      expect(mockOutputSuccess).toHaveBeenCalledWith(
        "Logged in to https://example.com",
      );
    });
  });

  describe("Edge case — Empty server URL", () => {
    it("outputs error when server is empty and no saved serverUrl", async () => {
      mockLoadConfig.mockReturnValue({ serverUrl: "", locale: "en" });

      await loginCommand({ server: "" });

      expect(mockOutputError).toHaveBeenCalledWith("Server URL is required.");
      expect(mockRunOAuthFlow).not.toHaveBeenCalled();
    });

    it("uses saved serverUrl from config when server option is omitted", async () => {
      mockLoadConfig.mockReturnValue({
        serverUrl: "https://saved.example.com",
        locale: "en",
      });
      mockRunOAuthFlow.mockResolvedValueOnce({
        accessToken: "tok",
        refreshToken: "ref",
        expiresIn: 3600,
        scope: "",
        clientId: "cid",
      });
      // promptAnswer is "" so serverInput is empty — falls back to config.serverUrl
      promptAnswer = "";

      await loginCommand({});

      expect(mockRunOAuthFlow).toHaveBeenCalledWith("https://saved.example.com");
    });
  });

  describe("Edge case — Invalid server URL (HTTP non-loopback)", () => {
    it("outputs error when HTTP URL with non-loopback hostname is given", async () => {
      await loginCommand({ server: "http://evil.com" });

      expect(mockOutputError).toHaveBeenCalledWith(
        expect.stringContaining("HTTPS"),
      );
      expect(mockRunOAuthFlow).not.toHaveBeenCalled();
    });

    it("allows HTTP for localhost", async () => {
      mockRunOAuthFlow.mockResolvedValueOnce({
        accessToken: "tok",
        refreshToken: "ref",
        expiresIn: 3600,
        scope: "",
        clientId: "cid",
      });

      await loginCommand({ server: "http://localhost:3000" });

      expect(mockOutputError).not.toHaveBeenCalled();
      expect(mockRunOAuthFlow).toHaveBeenCalledWith("http://localhost:3000");
    });
  });

  describe("Edge case — Server URL trailing slash stripped", () => {
    it("strips trailing slash before saving config", async () => {
      mockRunOAuthFlow.mockResolvedValueOnce({
        accessToken: "tok",
        refreshToken: "ref",
        expiresIn: 3600,
        scope: "",
        clientId: "cid",
      });

      await loginCommand({ server: "https://example.com/" });

      expect(mockSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ serverUrl: "https://example.com" }),
      );
      expect(mockRunOAuthFlow).toHaveBeenCalledWith("https://example.com");
    });
  });

  describe("Edge case — Empty token in manual login", () => {
    it("outputs error when prompt returns empty string", async () => {
      promptAnswer = "";

      await loginCommand({ server: "https://example.com", useToken: true });

      expect(mockOutputError).toHaveBeenCalledWith("Token is required.");
      expect(mockSaveCredentials).not.toHaveBeenCalled();
    });
  });

  describe("Error path — OAuth flow fails", () => {
    it("outputs error message when runOAuthFlow rejects with an Error", async () => {
      mockRunOAuthFlow.mockRejectedValueOnce(
        new Error("DCR registration failed (500): Internal Server Error"),
      );

      await loginCommand({ server: "https://example.com" });

      expect(mockOutputError).toHaveBeenCalledWith(
        "DCR registration failed (500): Internal Server Error",
      );
      expect(mockSaveCredentials).not.toHaveBeenCalled();
    });

    it("outputs fallback message when runOAuthFlow rejects with a non-Error", async () => {
      mockRunOAuthFlow.mockRejectedValueOnce("unknown failure");

      await loginCommand({ server: "https://example.com" });

      expect(mockOutputError).toHaveBeenCalledWith("OAuth login failed");
    });
  });
});
