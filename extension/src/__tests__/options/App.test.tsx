/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mockGetSettings = vi.fn();
const mockSetSettings = vi.fn();
const mockEnsureHostPermission = vi.fn();

vi.mock("../../lib/storage", () => ({
  getSettings: () => mockGetSettings(),
  setSettings: (v: unknown) => mockSetSettings(v),
}));
vi.mock("../../lib/api", () => ({
  ensureHostPermission: (v: unknown) => mockEnsureHostPermission(v),
}));

import { App } from "../../options/App";

const allDefaults = {
  serverUrl: "https://example.com",
  autoLockMinutes: 15,
  theme: "system" as const,
  showBadgeCount: true,
  enableInlineSuggestions: true,
  enableContextMenu: true,
  autoCopyTotp: true,
  showSavePrompt: true,
  showUpdatePrompt: true,
  clipboardClearSeconds: 30,
  vaultTimeoutAction: "lock" as const,
};

// Mock chrome.permissions, chrome.commands, chrome.runtime, chrome.tabs, chrome.storage
const existingChrome =
  typeof globalThis.chrome === "object" && globalThis.chrome !== null
    ? globalThis.chrome
    : {};
vi.stubGlobal("chrome", {
  ...existingChrome,
  permissions: {
    contains: vi.fn().mockResolvedValue(false),
    request: vi.fn().mockResolvedValue(true),
    remove: vi.fn().mockResolvedValue(true),
  },
  runtime: {
    openOptionsPage: vi.fn(),
    getManifest: vi.fn().mockReturnValue({ version: "0.5.0" }),
  },
  commands: {
    getAll: vi.fn().mockResolvedValue([
      { name: "_execute_action", shortcut: "Ctrl+Shift+A", description: "Open popup" },
      { name: "copy-password", shortcut: "Ctrl+Shift+P", description: "Copy password" },
    ]),
  },
  tabs: {
    create: vi.fn(),
  },
  storage: {
    ...existingChrome.storage,
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn(),
    },
  },
});

// Mock window.matchMedia for theme support
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

describe("Options App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockResolvedValue({ ...allDefaults });
    mockEnsureHostPermission.mockResolvedValue(true);
    (chrome.permissions.contains as ReturnType<typeof vi.fn>).mockResolvedValue(false);
  });

  it("loads settings on mount", async () => {
    render(<App />);
    expect(await screen.findByDisplayValue("https://example.com")).toBeInTheDocument();
    expect(screen.getByDisplayValue("15")).toBeInTheDocument();
  });

  it("shows error on invalid URL", async () => {
    render(<App />);
    fireEvent.change(await screen.findByPlaceholderText("https://example.com"), {
      target: { value: "not-a-url" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText(/invalid url/i)).toBeInTheDocument();
    expect(mockSetSettings).not.toHaveBeenCalled();
  });

  it("saves settings when valid", async () => {
    render(<App />);
    fireEvent.change(await screen.findByPlaceholderText("https://example.com"), {
      target: { value: "https://demo.example.com" },
    });
    fireEvent.change(screen.getByDisplayValue("15"), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(mockSetSettings).toHaveBeenCalledWith({
        serverUrl: "https://demo.example.com",
        autoLockMinutes: 30,
        theme: "system",
        showBadgeCount: true,
        enableInlineSuggestions: true,
        enableContextMenu: true,
        autoCopyTotp: true,
        showSavePrompt: true,
        showUpdatePrompt: true,
        clipboardClearSeconds: 30,
        vaultTimeoutAction: "lock",
      });
    });
    expect(await screen.findByText(/saved!/i)).toBeInTheDocument();
  });

  it("shows error when host permission is denied", async () => {
    mockEnsureHostPermission.mockResolvedValue(false);
    render(<App />);
    fireEvent.change(await screen.findByPlaceholderText("https://example.com"), {
      target: { value: "https://demo.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText(/host permission was denied/i)).toBeInTheDocument();
    expect(mockSetSettings).not.toHaveBeenCalled();
  });

  it("saves when auto-lock is set to Never (0)", async () => {
    render(<App />);
    fireEvent.change(await screen.findByPlaceholderText("https://example.com"), {
      target: { value: "https://demo.example.com" },
    });
    fireEvent.change(screen.getByDisplayValue("15"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => {
      expect(mockSetSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          serverUrl: "https://demo.example.com",
          autoLockMinutes: 0,
        }),
      );
    });
  });

  it("displays keyboard shortcuts", async () => {
    render(<App />);
    expect(await screen.findByText("Open popup")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+Shift+A")).toBeInTheDocument();
    expect(screen.getByText("Copy password")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+Shift+P")).toBeInTheDocument();
  });

  it("displays extension version", async () => {
    render(<App />);
    expect(await screen.findByText("0.5.0")).toBeInTheDocument();
  });
});
