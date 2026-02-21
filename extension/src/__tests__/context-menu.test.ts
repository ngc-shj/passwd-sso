import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DecryptedEntry } from "../types/messages";

// Mock chrome API before importing
// Override navigator.language for consistent i18n
Object.defineProperty(navigator, "language", { value: "en-US", configurable: true });

const chromeMock = {
  contextMenus: {
    create: vi.fn(),
    removeAll: vi.fn((cb?: () => void) => cb?.()),
    onClicked: {
      addListener: vi.fn(),
    },
  },
  action: {
    openPopup: vi.fn().mockResolvedValue(undefined),
  },
};

vi.stubGlobal("chrome", chromeMock);

import {
  initContextMenu,
  setupContextMenu,
  updateContextMenuForTab,
  handleContextMenuClick,
  invalidateContextMenu,
  type ContextMenuDeps,
} from "../background/context-menu";

const mockEntries: DecryptedEntry[] = [
  { id: "e1", title: "GitHub", username: "alice", urlHost: "github.com", entryType: "LOGIN" },
  { id: "e2", title: "GitLab", username: "bob", urlHost: "gitlab.com", entryType: "LOGIN" },
];

function createDeps(overrides?: Partial<ContextMenuDeps>): ContextMenuDeps {
  return {
    getCachedEntries: vi.fn().mockResolvedValue(mockEntries),
    isHostMatch: vi.fn((entryHost: string, tabHost: string) => entryHost === tabHost),
    extractHost: vi.fn((url: string) => {
      try { return new URL(url).hostname; } catch { return null; }
    }),
    isVaultUnlocked: vi.fn().mockReturnValue(true),
    performAutofill: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("context-menu", () => {
  let deps: ContextMenuDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    chromeMock.contextMenus.removeAll.mockImplementation((cb?: () => void) => cb?.());
    deps = createDeps();
    initContextMenu(deps);
    invalidateContextMenu();
  });

  describe("setupContextMenu", () => {
    it("creates parent menu item", () => {
      setupContextMenu();

      expect(chromeMock.contextMenus.removeAll).toHaveBeenCalled();
      expect(chromeMock.contextMenus.create).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "psso-parent",
          title: "passwd-sso",
          contexts: ["editable"],
        }),
      );
    });
  });

  describe("updateContextMenuForTab", () => {
    it("creates entry items for matching host", async () => {
      updateContextMenuForTab(1, "https://github.com/login");

      // Wait for debounce + async
      await new Promise((r) => setTimeout(r, 300));

      // Should have: removeAll + parent + entry item + separator + open popup
      const createCalls = chromeMock.contextMenus.create.mock.calls;
      const entryCall = createCalls.find(
        (c: unknown[]) => (c[0] as { id: string }).id === "psso-login-e1",
      );
      expect(entryCall).toBeTruthy();
      expect((entryCall![0] as { title: string }).title).toBe("GitHub (alice)");
    });

    it("shows 'Vault is locked' when vault is locked", async () => {
      deps = createDeps({ isVaultUnlocked: vi.fn().mockReturnValue(false) });
      initContextMenu(deps);

      updateContextMenuForTab(1, "https://github.com");

      await new Promise((r) => setTimeout(r, 300));

      const createCalls = chromeMock.contextMenus.create.mock.calls;
      const lockedCall = createCalls.find(
        (c: unknown[]) => (c[0] as { id: string }).id === "psso-login-locked",
      );
      expect(lockedCall).toBeTruthy();
      expect((lockedCall![0] as { enabled: boolean }).enabled).toBe(false);
    });

    it("shows 'No matches' when no entries match host", async () => {
      updateContextMenuForTab(1, "https://nomatch.example.com");

      await new Promise((r) => setTimeout(r, 300));

      const createCalls = chromeMock.contextMenus.create.mock.calls;
      const noMatchCall = createCalls.find(
        (c: unknown[]) => (c[0] as { id: string }).id === "psso-login-none",
      );
      expect(noMatchCall).toBeTruthy();
    });

    it("limits displayed entries to 5", async () => {
      const manyEntries: DecryptedEntry[] = Array.from({ length: 8 }, (_, i) => ({
        id: `e-${i}`,
        title: `Entry ${i}`,
        username: `user${i}`,
        urlHost: "example.com",
        entryType: "LOGIN",
      }));

      deps = createDeps({
        getCachedEntries: vi.fn().mockResolvedValue(manyEntries),
      });
      initContextMenu(deps);

      updateContextMenuForTab(1, "https://example.com");

      await new Promise((r) => setTimeout(r, 300));

      const createCalls = chromeMock.contextMenus.create.mock.calls;
      const entryCalls = createCalls.filter(
        (c: unknown[]) => {
          const id = (c[0] as { id: string }).id;
          return id.startsWith("psso-login-e-");
        },
      );
      expect(entryCalls).toHaveLength(5);
    });

    it("debounces rapid calls", async () => {
      updateContextMenuForTab(1, "https://github.com");
      updateContextMenuForTab(1, "https://gitlab.com");
      updateContextMenuForTab(1, "https://example.com");

      await new Promise((r) => setTimeout(r, 300));

      // getCachedEntries should only be called once (last debounced call)
      expect(deps.getCachedEntries).toHaveBeenCalledTimes(1);
    });
  });

  describe("handleContextMenuClick", () => {
    it("calls performAutofill for entry clicks", () => {
      handleContextMenuClick(
        { menuItemId: "psso-login-e1" } as chrome.contextMenus.OnClickData,
        { id: 1 } as chrome.tabs.Tab,
      );

      expect(deps.performAutofill).toHaveBeenCalledWith("e1", 1);
    });

    it("opens popup for psso-open-popup click", () => {
      handleContextMenuClick(
        { menuItemId: "psso-open-popup" } as chrome.contextMenus.OnClickData,
        { id: 1 } as chrome.tabs.Tab,
      );

      expect(chromeMock.action.openPopup).toHaveBeenCalled();
    });

    it("ignores disabled items (locked, none, sep)", () => {
      handleContextMenuClick(
        { menuItemId: "psso-login-locked" } as chrome.contextMenus.OnClickData,
        { id: 1 } as chrome.tabs.Tab,
      );

      expect(deps.performAutofill).not.toHaveBeenCalled();
    });

    it("ignores clicks without tab", () => {
      handleContextMenuClick(
        { menuItemId: "psso-login-e1" } as chrome.contextMenus.OnClickData,
        undefined,
      );

      expect(deps.performAutofill).not.toHaveBeenCalled();
    });
  });
});
