/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DecryptedEntry } from "../types/messages";
import { extractHost } from "../lib/url-matching";

// Mock chrome API before importing
// Override navigator.language for consistent i18n
Object.defineProperty(navigator, "language", { value: "en-US", configurable: true });

const chromeMock = {
  contextMenus: {
    create: vi.fn((_props: unknown, cb?: () => void) => cb?.()),
    removeAll: vi.fn((cb?: () => void) => cb?.()),
    onClicked: {
      addListener: vi.fn(),
    },
  },
  action: {
    openPopup: vi.fn().mockResolvedValue(undefined),
  },
  tabs: {
    query: vi.fn().mockResolvedValue([]),
  },
};

vi.stubGlobal("chrome", {
  ...chromeMock,
  runtime: { lastError: undefined },
});

import {
  initContextMenu,
  setupContextMenu,
  updateContextMenuForTab,
  handleContextMenuClick,
  invalidateContextMenu,
  disableContextMenu,
  DEBOUNCE_MS,
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
    // The production predicate, not a lookalike: a fixture that accepted
    // chrome:// URLs or skipped www.-stripping would let the deny-path tests
    // pass for the wrong reason.
    extractHost: vi.fn(extractHost),
    isConnected: vi.fn().mockReturnValue(true),
    isVaultUnlocked: vi.fn().mockReturnValue(true),
    isContextMenuEnabled: vi.fn().mockResolvedValue(true),
    performAutofill: vi.fn().mockResolvedValue({ ok: true }),
    notifyFillFailure: vi.fn(),
    ...overrides,
  };
}

describe("context-menu", () => {
  let deps: ContextMenuDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-arm both callback-taking stubs symmetrically. createMenuItem awaits
    // create's callback, so a stub that never invokes it leaves the menu chain
    // pending forever — a hang rather than a legible failure.
    chromeMock.contextMenus.create.mockImplementation((_props: unknown, cb?: () => void) => cb?.());
    chromeMock.contextMenus.removeAll.mockImplementation((cb?: () => void) => cb?.());
    // Some tests override tabs.query to a specific tab so their own
    // invalidateContextMenu() call rebuilds against it; without resetting it
    // back here, that leaked resolution would drive THIS beforeEach's own
    // invalidateContextMenu() (below) to rebuild the menu asynchronously in
    // the background of whatever test runs next.
    chromeMock.tabs.query.mockResolvedValue([]);
    deps = createDeps();
    initContextMenu(deps);
    invalidateContextMenu();
  });

  describe("setupContextMenu", () => {
    it("creates parent menu item", async () => {
      await setupContextMenu();

      expect(chromeMock.contextMenus.removeAll).toHaveBeenCalled();
      expect(chromeMock.contextMenus.create).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "psso-parent",
          title: "passwd-sso",
          contexts: ["editable"],
        }),
        expect.any(Function),
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

    it("shows 'Not connected' when disconnected", async () => {
      deps = createDeps({ isConnected: vi.fn().mockReturnValue(false) });
      initContextMenu(deps);

      updateContextMenuForTab(1, "https://github.com");

      await new Promise((r) => setTimeout(r, 300));

      const createCalls = chromeMock.contextMenus.create.mock.calls;
      const disconnectedCall = createCalls.find(
        (c: unknown[]) => (c[0] as { id: string }).id === "psso-login-disconnected",
      );
      expect(disconnectedCall).toBeTruthy();
      expect((disconnectedCall![0] as { enabled: boolean }).enabled).toBe(false);
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

    it("encodes teamId in menu item IDs for team entries", async () => {
      const teamId = "c0000000-0000-0000-0000-000000000001";
      const teamEntries: DecryptedEntry[] = [
        { id: "te1", title: "Team GitHub", username: "team-alice", urlHost: "github.com", entryType: "LOGIN", teamId, teamName: "My Team" },
      ];

      deps = createDeps({
        getCachedEntries: vi.fn().mockResolvedValue(teamEntries),
      });
      initContextMenu(deps);

      updateContextMenuForTab(1, "https://github.com");
      await new Promise((r) => setTimeout(r, 300));

      const createCalls = chromeMock.contextMenus.create.mock.calls;
      const teamEntryCall = createCalls.find(
        (c: unknown[]) => (c[0] as { id: string }).id === `psso-login-${teamId}:te1`,
      );
      expect(teamEntryCall).toBeTruthy();
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

    it("removes child items when url is undefined", async () => {
      updateContextMenuForTab(1, undefined);

      await new Promise((r) => setTimeout(r, 300));

      // removeAll should be called to clear child items
      expect(chromeMock.contextMenus.removeAll).toHaveBeenCalled();
      // getCachedEntries should NOT be called
      expect(deps.getCachedEntries).not.toHaveBeenCalled();
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

  describe("invalidateContextMenu", () => {
    it("forces rebuild even for same host", async () => {
      chromeMock.tabs.query.mockResolvedValue([{ id: 1, url: "https://github.com" }]);

      updateContextMenuForTab(1, "https://github.com/login");
      await new Promise((r) => setTimeout(r, 300));
      const callsBefore = (deps.getCachedEntries as ReturnType<typeof vi.fn>).mock.calls.length;

      // Calling invalidateContextMenu should reset lastMenuHost and rebuild
      invalidateContextMenu();
      await new Promise((r) => setTimeout(r, 300));

      expect((deps.getCachedEntries as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  describe("handleContextMenuClick", () => {
    it("calls performAutofill for entry clicks", () => {
      const entryUuid = "a0000000-0000-0000-0000-000000000001";
      handleContextMenuClick(
        { menuItemId: `psso-login-${entryUuid}`, frameUrl: "https://github.com/login" } as chrome.contextMenus.OnClickData,
        { id: 1 } as chrome.tabs.Tab,
      );

      expect(deps.performAutofill).toHaveBeenCalledWith(entryUuid, 1, undefined, "github.com", undefined);
    });

    it("calls performAutofill with teamId for team entry clicks", () => {
      const teamUuid = "b0000000-0000-0000-0000-000000000001";
      const entryUuid = "a0000000-0000-0000-0000-000000000002";
      handleContextMenuClick(
        { menuItemId: `psso-login-${teamUuid}:${entryUuid}`, frameUrl: "https://github.com/login" } as chrome.contextMenus.OnClickData,
        { id: 1 } as chrome.tabs.Tab,
      );

      expect(deps.performAutofill).toHaveBeenCalledWith(entryUuid, 1, teamUuid, "github.com", undefined);
    });

    it("calls performAutofill with teamId for CC entry clicks", () => {
      const teamUuid = "b0000000-0000-0000-0000-000000000001";
      const entryUuid = "a0000000-0000-0000-0000-000000000003";
      handleContextMenuClick(
        { menuItemId: `psso-cc-${teamUuid}:${entryUuid}`, frameUrl: "https://shop.example/checkout" } as chrome.contextMenus.OnClickData,
        { id: 2 } as chrome.tabs.Tab,
      );

      expect(deps.performAutofill).toHaveBeenCalledWith(entryUuid, 2, teamUuid, "shop.example", undefined);
    });

    it("calls performAutofill with teamId for ID entry clicks", () => {
      const teamUuid = "b0000000-0000-0000-0000-000000000001";
      const entryUuid = "a0000000-0000-0000-0000-000000000004";
      handleContextMenuClick(
        { menuItemId: `psso-id-${teamUuid}:${entryUuid}`, frameUrl: "https://forms.example/apply" } as chrome.contextMenus.OnClickData,
        { id: 3 } as chrome.tabs.Tab,
      );

      expect(deps.performAutofill).toHaveBeenCalledWith(entryUuid, 3, teamUuid, "forms.example", undefined);
    });

    it("rejects malformed teamId:entryId format", () => {
      handleContextMenuClick(
        { menuItemId: "psso-login-not-a-uuid:also-not-uuid" } as chrome.contextMenus.OnClickData,
        { id: 1 } as chrome.tabs.Tab,
      );

      expect(deps.performAutofill).not.toHaveBeenCalled();
    });

    it("opens popup for psso-open-popup click", () => {
      handleContextMenuClick(
        { menuItemId: "psso-open-popup" } as chrome.contextMenus.OnClickData,
        { id: 1 } as chrome.tabs.Tab,
      );

      expect(chromeMock.action.openPopup).toHaveBeenCalled();
    });

    it("ignores disabled items (locked, disconnected, none, sep)", () => {
      for (const id of ["psso-login-locked", "psso-login-disconnected", "psso-login-none", "psso-login-sep"]) {
        handleContextMenuClick(
          { menuItemId: id } as chrome.contextMenus.OnClickData,
          { id: 1 } as chrome.tabs.Tab,
        );
      }

      expect(deps.performAutofill).not.toHaveBeenCalled();
    });

    it("ignores clicks without tab", () => {
      handleContextMenuClick(
        { menuItemId: "psso-login-e1" } as chrome.contextMenus.OnClickData,
        undefined,
      );

      expect(deps.performAutofill).not.toHaveBeenCalled();
    });

    it("ignores clicks when tab has no id", () => {
      handleContextMenuClick(
        { menuItemId: "psso-login-e1" } as chrome.contextMenus.OnClickData,
        {} as chrome.tabs.Tab,
      );

      expect(deps.performAutofill).not.toHaveBeenCalled();
    });
  });

  describe("create failure reporting", () => {
    it("classifies and logs a duplicate-id rejection from the create callback", async () => {
      // The wiring, not the classifier: proves createMenuItem actually reads
      // lastError and routes it to warnBackground. AD1 leans on this path being
      // live in the field, since no browser harness covers it.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const chromeGlobal = globalThis.chrome as unknown as { runtime: { lastError?: { message?: string } } };
      chromeMock.contextMenus.create.mockImplementation((_props: unknown, cb?: () => void) => {
        chromeGlobal.runtime.lastError = { message: "Cannot create item with duplicate id psso-parent" };
        cb?.();
        chromeGlobal.runtime.lastError = undefined;
      });

      await setupContextMenu();

      expect(warn).toHaveBeenCalledWith("[passwd-sso] context-menu-create-failed: duplicate-id");
      warn.mockRestore();
    });
  });

  // ── C5: credential release bound to the clicked frame's host ──
  describe("click host binding (C5)", () => {
    const entryUuid = "a0000000-0000-0000-0000-000000000001";

    it("passes the frame host, not the tab host, when the click is in a subframe", () => {
      handleContextMenuClick(
        {
          menuItemId: `psso-login-${entryUuid}`,
          frameUrl: "https://widget.example/embed",
          pageUrl: "https://bank.example/account",
          frameId: 7,
        } as chrome.contextMenus.OnClickData,
        { id: 1, url: "https://bank.example/account" } as chrome.tabs.Tab,
      );

      expect(deps.performAutofill).toHaveBeenCalledWith(
        entryUuid, 1, undefined, "widget.example", 7,
      );
    });

    it("falls back to pageUrl for a top-frame click (Chrome omits frameUrl)", () => {
      handleContextMenuClick(
        {
          menuItemId: `psso-login-${entryUuid}`,
          pageUrl: "https://github.com/login",
          frameId: 0,
        } as chrome.contextMenus.OnClickData,
        { id: 1 } as chrome.tabs.Tab,
      );

      expect(deps.performAutofill).toHaveBeenCalledWith(
        entryUuid, 1, undefined, "github.com", 0,
      );
    });

    it("falls back to tab.url when neither frameUrl nor pageUrl is present", () => {
      handleContextMenuClick(
        { menuItemId: `psso-login-${entryUuid}` } as chrome.contextMenus.OnClickData,
        { id: 1, url: "https://github.com/login" } as chrome.tabs.Tab,
      );

      expect(deps.performAutofill).toHaveBeenCalledWith(
        entryUuid, 1, undefined, "github.com", undefined,
      );
    });

    it("normalizes the resolved host the same way production does", () => {
      // extractHost strips a leading www. and lowercases; a fixture that
      // returned URL.hostname raw would pass "www.github.com" here and quietly
      // disagree with the host the entries were matched against.
      handleContextMenuClick(
        {
          menuItemId: `psso-login-${entryUuid}`,
          frameUrl: "https://WWW.GitHub.com/login",
        } as chrome.contextMenus.OnClickData,
        { id: 1 } as chrome.tabs.Tab,
      );

      expect(deps.performAutofill).toHaveBeenCalledWith(
        entryUuid, 1, undefined, "github.com", undefined,
      );
    });

    it("denies the fill when no URL yields a host", () => {
      handleContextMenuClick(
        { menuItemId: `psso-login-${entryUuid}` } as chrome.contextMenus.OnClickData,
        { id: 1 } as chrome.tabs.Tab,
      );

      expect(deps.performAutofill).not.toHaveBeenCalled();
      expect(deps.notifyFillFailure).toHaveBeenCalledWith("UNKNOWN_ORIGIN");
    });

    it("denies the fill for a non-http scheme", () => {
      handleContextMenuClick(
        {
          menuItemId: `psso-login-${entryUuid}`,
          frameUrl: "chrome://settings",
        } as chrome.contextMenus.OnClickData,
        { id: 1 } as chrome.tabs.Tab,
      );

      expect(deps.performAutofill).not.toHaveBeenCalled();
      expect(deps.notifyFillFailure).toHaveBeenCalledWith("UNKNOWN_ORIGIN");
    });

    it("reports a refused fill distinguishably from an unverifiable page", async () => {
      deps = createDeps({
        performAutofill: vi.fn().mockResolvedValue({ ok: false, error: "ORIGIN_MISMATCH" }),
      });
      initContextMenu(deps);

      handleContextMenuClick(
        {
          menuItemId: `psso-login-${entryUuid}`,
          frameUrl: "https://evil.example/x",
        } as chrome.contextMenus.OnClickData,
        { id: 1 } as chrome.tabs.Tab,
      );
      await new Promise((r) => setTimeout(r, 10));

      expect(deps.notifyFillFailure).toHaveBeenCalledWith("ORIGIN_MISMATCH");
    });

    it("reports nothing when the fill succeeds", async () => {
      handleContextMenuClick(
        {
          menuItemId: `psso-login-${entryUuid}`,
          frameUrl: "https://github.com/login",
        } as chrome.contextMenus.OnClickData,
        { id: 1 } as chrome.tabs.Tab,
      );
      await new Promise((r) => setTimeout(r, 10));

      expect(deps.notifyFillFailure).not.toHaveBeenCalled();
    });
  });

  // ── C1: serialization + generation token ──
  describe("rebuild serialization (C1)", () => {
    const mixed: DecryptedEntry[] = [
      { id: "L1", title: "Login", username: "u", urlHost: "example.com", entryType: "LOGIN" },
      { id: "C1", title: "Card", entryType: "CREDIT_CARD" } as DecryptedEntry,
      { id: "I1", title: "Ident", entryType: "IDENTITY" } as DecryptedEntry,
    ];

    function idsCreated(): string[] {
      return chromeMock.contextMenus.create.mock.calls.map(
        (c: unknown[]) => (c[0] as { id: string }).id,
      );
    }

    /**
     * Split the create log into per-rebuild segments using the interleaved
     * removeAll calls as boundaries. Chrome's duplicate-id rejection is scoped to
     * currently-registered items, so this is the segmentation that matches it.
     */
    function idsCreatedPerRebuild(): string[][] {
      const events: Array<{ kind: "create" | "reset"; order: number; id?: string }> = [];
      chromeMock.contextMenus.create.mock.invocationCallOrder.forEach((order: number, i: number) => {
        const props = chromeMock.contextMenus.create.mock.calls[i][0] as { id: string };
        events.push({ kind: "create", order, id: props.id });
      });
      chromeMock.contextMenus.removeAll.mock.invocationCallOrder.forEach((order: number) => {
        events.push({ kind: "reset", order });
      });
      events.sort((a, b) => a.order - b.order);
      const segments: string[][] = [[]];
      for (const e of events) {
        if (e.kind === "reset") segments.push([]);
        else segments[segments.length - 1].push(e.id!);
      }
      return segments;
    }

    it("runs both rebuilds to completion without interleaving their create batches", async () => {
      let release: (v: DecryptedEntry[]) => void = () => {};
      const gate = new Promise<DecryptedEntry[]>((r) => { release = r; });
      let call = 0;
      const getCachedEntries = vi.fn(() => {
        call += 1;
        return call === 1 ? gate : Promise.resolve(mockEntries);
      });
      deps = createDeps({ getCachedEntries });
      initContextMenu(deps);

      // A: past its debounce and suspended inside doUpdateMenu.
      updateContextMenuForTab(1, "https://github.com/login");
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 60));
      expect(getCachedEntries).toHaveBeenCalledTimes(1);

      // B: a second, concurrent request while A is still suspended.
      chromeMock.tabs.query.mockResolvedValue([{ id: 1, url: "https://gitlab.com/x" }]);
      invalidateContextMenu();
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 60));

      release(mockEntries);
      await new Promise((r) => setTimeout(r, 60));

      // Cardinality floor: without this, "no duplicates" holds vacuously over
      // an empty or single-rebuild call log.
      // Chrome rejects a duplicate id only among items currently registered, and
      // every rebuild starts with removeAll — so the invariant is per-rebuild, not
      // over the whole call log. Segment by removeAll and require each segment to
      // be internally unique.
      //
      // Note on what this does and does not prove: because createMenuItem awaits
      // each callback, a single rebuild's batch cannot interleave with another's
      // here, so this assertion stays green even with serialization removed. It
      // pins that both rebuilds ran and neither emitted a self-duplicate. The
      // supersession behaviour that the generation token actually provides is
      // pinned by the next test, which does redden when the guard is disabled.
      expect(getCachedEntries.mock.calls.length).toBe(2);
      const segments = idsCreatedPerRebuild();
      expect(segments.some((seg) => seg.length > 0)).toBe(true);
      for (const seg of segments) {
        expect(new Set(seg).size).toBe(seg.length);
      }
    });

    it("keeps the newest host's items when an older rebuild resolves last", async () => {
      let release: (v: DecryptedEntry[]) => void = () => {};
      const gate = new Promise<DecryptedEntry[]>((r) => { release = r; });
      let call = 0;
      const getCachedEntries = vi.fn(() => {
        call += 1;
        return call === 1 ? gate : Promise.resolve(mockEntries);
      });
      deps = createDeps({ getCachedEntries });
      initContextMenu(deps);

      updateContextMenuForTab(1, "https://github.com/login");
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 60));
      chromeMock.contextMenus.create.mockClear();

      chromeMock.tabs.query.mockResolvedValue([{ id: 1, url: "https://gitlab.com/x" }]);
      invalidateContextMenu();
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 60));

      release(mockEntries);
      await new Promise((r) => setTimeout(r, 60));

      const ids = idsCreated();
      // gitlab.com is the newest request; github.com's stale item must not survive.
      expect(ids).toContain("psso-login-e2");
      expect(ids).not.toContain("psso-login-e1");
    });

    it("does not wedge the chain when a rebuild dependency rejects", async () => {
      deps = createDeps({
        isContextMenuEnabled: vi.fn().mockRejectedValue(new Error("boom")),
      });
      initContextMenu(deps);
      updateContextMenuForTab(1, "https://github.com/login");
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 60));

      deps = createDeps();
      initContextMenu(deps);
      chromeMock.contextMenus.create.mockClear();
      updateContextMenuForTab(1, "https://gitlab.com/x");
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 60));

      // The guarded side effect, not merely a settled promise.
      //
      // Two mechanisms keep the chain moving past a rejection and either alone
      // suffices, so this reddens only when both are removed: `then(task, task)`
      // runs the next task on the rejection path, and the stored handle's
      // `.catch()` keeps a rejected promise from becoming the chain's terminal
      // state. Verified by mutation — dropping either one leaves this green,
      // dropping both makes it fail.
      expect(idsCreated()).toContain("psso-login-e2");
    });

    it("creates the full item set in order for the non-racing case", async () => {
      deps = createDeps({ getCachedEntries: vi.fn().mockResolvedValue(mixed) });
      initContextMenu(deps);
      await setupContextMenu();
      chromeMock.contextMenus.create.mockClear();

      updateContextMenuForTab(1, "https://example.com/x");
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 60));

      const ids = idsCreated();
      expect(ids.length).toBeGreaterThan(0);
      expect(ids).toEqual([
        "psso-parent",
        "psso-login-L1",
        "psso-cc-sep",
        "psso-cc-C1",
        "psso-id-sep",
        "psso-id-I1",
        "psso-login-sep",
        "psso-open-popup",
      ]);
    });

    it("creates no child items when the context menu is disabled", async () => {
      deps = createDeps({
        getCachedEntries: vi.fn().mockResolvedValue(mixed),
        isContextMenuEnabled: vi.fn().mockResolvedValue(false),
      });
      initContextMenu(deps);

      updateContextMenuForTab(1, "https://example.com/x");
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 60));

      expect(idsCreated()).toEqual([]);
      // removeAll still runs: Chrome retains registrations across SW restarts,
      // so a disabled startup must still clear items left from an enabled one.
      expect(chromeMock.contextMenus.removeAll).toHaveBeenCalled();
    });

    it("tears down without a rebuild resurrecting the menu", async () => {
      deps = createDeps();
      initContextMenu(deps);
      await setupContextMenu();
      chromeMock.contextMenus.create.mockClear();

      updateContextMenuForTab(1, "https://github.com/login");
      await disableContextMenu();
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 80));

      expect(chromeMock.contextMenus.removeAll).toHaveBeenCalled();
      expect(idsCreated()).toEqual([]);
    });
  });

});
