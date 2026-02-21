import type { DecryptedEntry } from "../types/messages";
import { t } from "../lib/i18n";

const PARENT_ID = "psso-parent";
const ITEM_PREFIX = "psso-login-";
const OPEN_POPUP_ID = "psso-open-popup";
const MAX_ITEMS = 5;

/** Debounce interval for menu updates (ms). */
const DEBOUNCE_MS = 200;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastMenuHost: string | null = null;

export interface ContextMenuDeps {
  getCachedEntries: () => Promise<DecryptedEntry[]>;
  isHostMatch: (entryHost: string, tabHost: string) => boolean;
  extractHost: (url: string) => string | null;
  isVaultUnlocked: () => boolean;
  performAutofill: (entryId: string, tabId: number) => Promise<void>;
}

let deps: ContextMenuDeps | null = null;

export function initContextMenu(d: ContextMenuDeps): void {
  deps = d;
}

/**
 * Create the static parent menu item.
 * Call on `chrome.runtime.onInstalled` and `chrome.runtime.onStartup`.
 */
export function setupContextMenu(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: PARENT_ID,
      title: t("contextMenu.title"),
      contexts: ["editable"],
    });
  });
}

/**
 * Update child menu items for the given tab URL.
 * Debounced to avoid excessive API calls on rapid tab switches.
 */
export function updateContextMenuForTab(
  _tabId: number,
  url: string | undefined,
): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void doUpdateMenu(url);
  }, DEBOUNCE_MS);
}

async function doUpdateMenu(url: string | undefined): Promise<void> {
  if (!deps) return;

  if (!url) {
    await removeChildItems();
    lastMenuHost = null;
    return;
  }

  const host = deps.extractHost(url);
  if (!host) {
    await removeChildItems();
    lastMenuHost = null;
    return;
  }

  // Skip rebuild if same host
  if (host === lastMenuHost) return;

  await removeChildItems();
  lastMenuHost = host;

  if (!deps.isVaultUnlocked()) {
    chrome.contextMenus.create({
      id: `${ITEM_PREFIX}locked`,
      parentId: PARENT_ID,
      title: t("contextMenu.vaultLocked"),
      contexts: ["editable"],
      enabled: false,
    });
    return;
  }

  try {
    const entries = await deps.getCachedEntries();
    const matches = entries.filter((e) => deps!.isHostMatch(e.urlHost, host));

    if (matches.length === 0) {
      chrome.contextMenus.create({
        id: `${ITEM_PREFIX}none`,
        parentId: PARENT_ID,
        title: t("contextMenu.noMatches"),
        contexts: ["editable"],
        enabled: false,
      });
    } else {
      const displayed = matches.slice(0, MAX_ITEMS);
      for (const entry of displayed) {
        const label = entry.username
          ? `${entry.title} (${entry.username})`
          : entry.title;
        chrome.contextMenus.create({
          id: `${ITEM_PREFIX}${entry.id}`,
          parentId: PARENT_ID,
          title: label,
          contexts: ["editable"],
        });
      }
    }

    // Separator + "Open passwd-sso"
    chrome.contextMenus.create({
      id: `${ITEM_PREFIX}sep`,
      parentId: PARENT_ID,
      type: "separator",
      contexts: ["editable"],
    });
    chrome.contextMenus.create({
      id: OPEN_POPUP_ID,
      parentId: PARENT_ID,
      title: t("contextMenu.openPopup"),
      contexts: ["editable"],
    });
  } catch {
    // Silently fail on cache errors
  }
}

function removeChildItems(): Promise<void> {
  return new Promise((resolve) => {
    // Remove all and recreate parent to clear children
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: PARENT_ID,
        title: t("contextMenu.title"),
        contexts: ["editable"],
      });
      resolve();
    });
  });
}

/**
 * Handle context menu item clicks.
 */
export function handleContextMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
): void {
  if (!deps || !tab?.id) return;

  const menuId = String(info.menuItemId);

  if (menuId === OPEN_POPUP_ID) {
    chrome.action.openPopup().catch(() => {});
    return;
  }

  if (menuId.startsWith(ITEM_PREFIX)) {
    const entryId = menuId.slice(ITEM_PREFIX.length);
    if (entryId && entryId !== "locked" && entryId !== "none" && entryId !== "sep") {
      deps.performAutofill(entryId, tab.id).catch(() => {});
    }
  }
}

/** Force menu rebuild (e.g., after vault unlock/lock). */
export function invalidateContextMenu(): void {
  lastMenuHost = null;
}
