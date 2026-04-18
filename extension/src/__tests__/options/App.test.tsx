/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mockGetSettings = vi.fn();
const mockSetSettings = vi.fn();
const mockEnsureHostPermission = vi.fn();

vi.mock("../../lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/storage")>();
  return {
    ...actual,
    getSettings: () => mockGetSettings(),
    setSettings: (v: unknown) => mockSetSettings(v),
  };
});
vi.mock("../../lib/api", () => ({
  ensureHostPermission: (v: unknown) => mockEnsureHostPermission(v),
}));

let mockThemeState = "system";
const mockSetTheme = vi.fn((t: string) => { mockThemeState = t; });
vi.mock("../../lib/theme", () => ({
  useTheme: () => [mockThemeState, mockSetTheme] as const,
  initTheme: vi.fn(),
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

const existingChrome =
  typeof globalThis !== "undefined" && "chrome" in globalThis && typeof (globalThis as Record<string, unknown>).chrome === "object" && (globalThis as Record<string, unknown>).chrome !== null
    ? (globalThis as Record<string, unknown>).chrome as Record<string, unknown>
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
    sendMessage: vi.fn((_msg: unknown, cb?: (res: unknown) => void) => {
      cb?.({ type: "GET_STATUS", hasToken: false, expiresAt: null, vaultUnlocked: false, tenantAutoLockMinutes: null });
    }),
    lastError: undefined,
  },
  commands: {
    getAll: vi.fn().mockResolvedValue([
      { name: "copy-password", shortcut: "Ctrl+Shift+P", description: "Copy password" },
    ]),
  },
  tabs: {
    create: vi.fn(),
  },
  i18n: {
    getMessage: vi.fn().mockImplementation((key: string) => key),
  },
  storage: {
    ...(typeof existingChrome.storage === "object" ? existingChrome.storage : {}),
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn(),
    },
  },
});

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

// Helper to navigate to a section by clicking the sidebar nav
function navigateTo(label: string) {
  const navButton = screen.getByRole("button", { name: label });
  fireEvent.click(navButton);
}

describe("Options App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockThemeState = "system";
    mockGetSettings.mockResolvedValue({ ...allDefaults });
    mockEnsureHostPermission.mockResolvedValue(true);
    ((globalThis as Record<string, unknown>).chrome as Record<string, Record<string, unknown>>).permissions.contains = vi.fn().mockResolvedValue(false);
  });

  it("loads settings and shows General section by default", async () => {
    render(<App />);
    // Sidebar nav items should be visible
    expect(await screen.findByText("General")).toBeInTheDocument();
    // Theme dropdown should be present with options
    expect(screen.getByRole("combobox", { name: /theme/i })).toBeInTheDocument();
  });

  it("shows server URL in General section", async () => {
    render(<App />);
    await screen.findByText("General"); // wait for load
    expect(screen.getByDisplayValue("https://example.com")).toBeInTheDocument();
  });

  it("shows error on invalid URL", async () => {
    render(<App />);
    await screen.findByText("General");
    fireEvent.change(screen.getByPlaceholderText("https://example.com"), {
      target: { value: "not-a-url" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText(/invalid url/i)).toBeInTheDocument();
    expect(mockSetSettings).not.toHaveBeenCalled();
  });

  it("saves all settings when valid", async () => {
    render(<App />);
    await screen.findByText("General");
    fireEvent.change(screen.getByPlaceholderText("https://example.com"), {
      target: { value: "https://demo.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(mockSetSettings).toHaveBeenCalledWith({
        serverUrl: "https://demo.example.com",
        autoLockMinutes: 15,
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
    await screen.findByText("General");
    fireEvent.change(screen.getByPlaceholderText("https://example.com"), {
      target: { value: "https://demo.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText(/host permission was denied/i)).toBeInTheDocument();
    expect(mockSetSettings).not.toHaveBeenCalled();
  });

  it("displays keyboard shortcuts", async () => {
    render(<App />);
    await screen.findByText("General");
    navigateTo("Keyboard Shortcuts");
    expect(screen.getByText("Copy password")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+Shift+P")).toBeInTheDocument();
  });

  it("displays extension version", async () => {
    render(<App />);
    await screen.findByText("General");
    navigateTo("About");
    expect(screen.getByText("0.5.0")).toBeInTheDocument();
  });

  it("toggles settings in Autofill section", async () => {
    render(<App />);
    await screen.findByText("General");
    navigateTo("Autofill");
    const inlineToggle = screen.getByRole("switch", { name: /inline/i });
    expect(inlineToggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(inlineToggle);
    expect(inlineToggle).toHaveAttribute("aria-checked", "false");
  });
});
