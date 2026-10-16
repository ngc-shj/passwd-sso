/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

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

// Mutable so individual tests can simulate the tenant policy override (C10).
let mockRequireVaultTimeoutLogout: boolean | null = null;

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
      cb?.({
        type: "GET_STATUS",
        hasToken: false,
        expiresAt: null,
        vaultUnlocked: false,
        tenantAutoLockMinutes: null,
        requireVaultTimeoutLogout: mockRequireVaultTimeoutLogout,
      });
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
    mockRequireVaultTimeoutLogout = null;
    mockGetSettings.mockResolvedValue({ ...allDefaults });
    mockEnsureHostPermission.mockResolvedValue(true);
    ((globalThis as Record<string, unknown>).chrome as Record<string, Record<string, unknown>>).permissions.contains = vi.fn().mockResolvedValue(false);
  });

  it("disables the vault-timeout-action select and explains why when the tenant enforces logout (C10)", async () => {
    mockRequireVaultTimeoutLogout = true;
    render(<App />);
    await screen.findByText("General");
    navigateTo("Security");

    const select = await screen.findByLabelText(/on vault timeout/i);
    expect(select).toBeDisabled();
    expect(select).toHaveValue("logout");
    expect(
      screen.getByText(/organization requires logging out on vault timeout/i),
    ).toBeInTheDocument();
  });

  it("leaves the vault-timeout-action select enabled when the tenant has no override", async () => {
    mockRequireVaultTimeoutLogout = false;
    render(<App />);
    await screen.findByText("General");
    navigateTo("Security");

    const select = await screen.findByLabelText(/on vault timeout/i);
    expect(select).not.toBeDisabled();
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
    // Use findByDisplayValue instead of getByDisplayValue: the input value
    // populates from getSettings().then(setState), which may not have
    // committed by the time `findByText("General")` resolves on slower CI runners.
    expect(await screen.findByDisplayValue("https://example.com")).toBeInTheDocument();
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

  // ── HTTP auth bindings (#905, C5) ──
  describe("Site sign-in section", () => {
    type ChromeMock = {
      runtime: { sendMessage: ReturnType<typeof vi.fn> };
      permissions: { contains: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
      storage: { local: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } };
    };
    const chromeMock = () => (globalThis as unknown as { chrome: ChromeMock }).chrome;
    let stored: Record<string, unknown>;
    let fetchResponse: unknown;
    // The chrome stub is file-wide and the order is shuffled: put back what
    // this describe replaces so the other tests keep their GET_STATUS answer.
    let saved: { sendMessage: unknown; get: unknown; set: unknown; remove: unknown };

    afterEach(() => {
      const c = chromeMock();
      c.runtime.sendMessage = saved.sendMessage as ChromeMock["runtime"]["sendMessage"];
      c.storage.local.get = saved.get as ChromeMock["storage"]["local"]["get"];
      c.storage.local.set = saved.set as ChromeMock["storage"]["local"]["set"];
      c.permissions.remove = saved.remove as ChromeMock["permissions"]["remove"];
    });

    beforeEach(() => {
      const original = chromeMock();
      saved = {
        sendMessage: original.runtime.sendMessage,
        get: original.storage.local.get,
        set: original.storage.local.set,
        remove: original.permissions.remove,
      };
      stored = {
        httpAuthBindings: [
          { origin: "http://router.example:8080", entryId: "pw-r" },
          { origin: "https://nas.example", entryId: "pw-n", teamId: "t1" },
        ],
      };
      fetchResponse = {
        type: "FETCH_PASSWORDS",
        entries: [
          { id: "pw-r", title: "Router", username: "admin", urlHost: "router.example", entryType: "LOGIN" },
          { id: "pw-n", teamId: "t1", title: "NAS", username: "root", urlHost: "nas.example", entryType: "LOGIN" },
        ],
      };
      const c = chromeMock();
      c.storage.local.get = vi.fn(async (key: unknown) => (typeof key === "string" ? { [key]: stored[key] } : {}));
      c.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(stored, items);
      });
      c.permissions.contains = vi.fn().mockResolvedValue(true);
      c.permissions.remove = vi.fn().mockResolvedValue(true);
      // Callback form: GET_STATUS from the page itself. Promise form: the
      // section's FETCH_PASSWORDS through lib/messaging.
      c.runtime.sendMessage = vi.fn((msg: { type: string }, cb?: (res: unknown) => void) => {
        if (cb) {
          cb({ type: "GET_STATUS", hasToken: true, expiresAt: null, vaultUnlocked: true });
          return undefined;
        }
        return Promise.resolve(msg.type === "FETCH_PASSWORDS" ? fetchResponse : undefined);
      });
    });

    async function openSection() {
      render(<App />);
      await screen.findByText("General");
      navigateTo("Site sign-in");
    }

    const row = async (origin: string) =>
      (await screen.findByText(origin)).closest("[data-testid='http-auth-row']") as HTMLElement;

    it("lists bindings by origin with the entry title while unlocked", async () => {
      await openSection();
      expect(await row("http://router.example:8080")).toHaveTextContent("Router");
      expect(await row("https://nas.example")).toHaveTextContent("NAS");
      expect(screen.queryByText("Locked")).toBeNull();
    });

    it("shows Locked instead of titles while the vault is locked", async () => {
      fetchResponse = { type: "FETCH_PASSWORDS", entries: null, error: "VAULT_LOCKED" };
      await openSection();
      expect(await row("http://router.example:8080")).toHaveTextContent("Locked");
      expect(screen.queryByText("The login no longer exists")).toBeNull();
    });

    it("flags a binding whose entry is gone", async () => {
      fetchResponse = { type: "FETCH_PASSWORDS", entries: [(fetchResponse as { entries: unknown[] }).entries[1]] };
      await openSection();
      expect(await row("http://router.example:8080")).toHaveTextContent("The login no longer exists");
      // Control: the other binding's entry is present.
      expect(await row("https://nas.example")).not.toHaveTextContent("The login no longer exists");
    });

    it("flags a binding whose site permission was removed", async () => {
      chromeMock().permissions.contains = vi.fn(async ({ origins }: { origins: string[] }) =>
        origins[0] !== "http://router.example:8080/*",
      );
      await openSection();
      expect(await row("http://router.example:8080")).toHaveTextContent("Permission for this site was removed");
      // Control: the other origin still has its permission.
      expect(await row("https://nas.example")).not.toHaveTextContent("Permission for this site was removed");
    });

    it("Remove deletes the binding, then releases what it no longer needs", async () => {
      await openSection();
      const target = await row("http://router.example:8080");
      fireEvent.click(within(target).getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(screen.queryByText("http://router.example:8080")).toBeNull());
      expect(stored.httpAuthBindings).toEqual([{ origin: "https://nas.example", entryId: "pw-n", teamId: "t1" }]);
      expect(chromeMock().permissions.remove).toHaveBeenCalledWith({ origins: ["http://router.example:8080/*"] });
      // Another binding remains, so the API permissions stay.
      expect(chromeMock().permissions.remove).not.toHaveBeenCalledWith(
        expect.objectContaining({ permissions: expect.anything() }),
      );
    });

    it("says so when no site is set up", async () => {
      stored = {};
      await openSection();
      expect(await screen.findByText(/No sites set up/)).toBeInTheDocument();
    });
  });
});
