import type { DecryptedEntry } from "../types/messages";
import { EXT_ENTRY_TYPE } from "../lib/constants";
import { t } from "../lib/i18n";

const PARENT_ID = "psso-parent";
const ITEM_PREFIX = "psso-login-";
const CC_ITEM_PREFIX = "psso-cc-";
const ID_ITEM_PREFIX = "psso-id-";
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
  isConnected: () => boolean;
  isVaultUnlocked: () => boolean;
  isContextMenuEnabled: () => Promise<boolean>;
  performAutofill: (entryId: string, tabId: number, teamId?: string) => Promise<void>;
}

let deps: ContextMenuDeps | null = null;

export function initContextMenu(d: ContextMenuDeps): void {
  deps = d;
}

/**
 * Create the static parent menu item.
 * Call on `chrome.runtime.onInstalled` and `chrome.runtime.onStartup`.
 */
/** Remove all menu items and recreate parent if enabled. */
async function resetMenuWithParent(): Promise<void> {
  const enabled = deps ? await deps.isContextMenuEnabled() : true;
  return new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => {
      if (enabled) {
        chrome.contextMenus.create({
          id: PARENT_ID,
          title: t("contextMenu.title"),
          contexts: ["editable"],
        });
      }
      resolve();
    });
  });
}

export async function setupContextMenu(): Promise<void> {
  await resetMenuWithParent();
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

  if (!deps.isConnected()) {
    chrome.contextMenus.create({
      id: `${ITEM_PREFIX}disconnected`,
      parentId: PARENT_ID,
      title: t("contextMenu.disconnected"),
      contexts: ["editable"],
      enabled: false,
    });
    return;
  }

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
    const loginMatches = entries.filter(
      (e) => e.entryType === EXT_ENTRY_TYPE.LOGIN && (
        (e.urlHost && deps!.isHostMatch(e.urlHost, host)) ||
        (e.additionalUrlHosts ?? []).some((h) => deps!.isHostMatch(h, host))
      ),
    );
    const ccEntries = entries.filter(
      (e) => e.entryType === EXT_ENTRY_TYPE.CREDIT_CARD,
    );
    const idEntries = entries.filter(
      (e) => e.entryType === EXT_ENTRY_TYPE.IDENTITY,
    );

    const hasAnyItems = loginMatches.length > 0 || ccEntries.length > 0 || idEntries.length > 0;

    if (!hasAnyItems) {
      chrome.contextMenus.create({
        id: `${ITEM_PREFIX}none`,
        parentId: PARENT_ID,
        title: t("contextMenu.noMatches"),
        contexts: ["editable"],
        enabled: false,
      });
    } else {
      // Logins section
      if (loginMatches.length > 0) {
        for (const entry of loginMatches.slice(0, MAX_ITEMS)) {
          const label = entry.username
            ? `${entry.title} (${entry.username})`
            : entry.title;
          chrome.contextMenus.create({
            id: `${ITEM_PREFIX}${encodeMenuEntryId(entry.id, entry.teamId)}`,
            parentId: PARENT_ID,
            title: label,
            contexts: ["editable"],
          });
        }
      }

      // Credit Cards section
      if (ccEntries.length > 0) {
        if (loginMatches.length > 0) {
          chrome.contextMenus.create({
            id: `${CC_ITEM_PREFIX}sep`,
            parentId: PARENT_ID,
            type: "separator",
            contexts: ["editable"],
          });
        }
        for (const entry of ccEntries.slice(0, MAX_ITEMS)) {
          const label = entry.title || t("contextMenu.creditCard");
          chrome.contextMenus.create({
            id: `${CC_ITEM_PREFIX}${encodeMenuEntryId(entry.id, entry.teamId)}`,
            parentId: PARENT_ID,
            title: `💳 ${label}`,
            contexts: ["editable"],
          });
        }
      }

      // Identity section
      if (idEntries.length > 0) {
        if (loginMatches.length > 0 || ccEntries.length > 0) {
          chrome.contextMenus.create({
            id: `${ID_ITEM_PREFIX}sep`,
            parentId: PARENT_ID,
            type: "separator",
            contexts: ["editable"],
          });
        }
        for (const entry of idEntries.slice(0, MAX_ITEMS)) {
          const label = entry.title || t("contextMenu.identity");
          chrome.contextMenus.create({
            id: `${ID_ITEM_PREFIX}${encodeMenuEntryId(entry.id, entry.teamId)}`,
            parentId: PARENT_ID,
            title: `👤 ${label}`,
            contexts: ["editable"],
          });
        }
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

async function removeChildItems(): Promise<void> {
  await resetMenuWithParent();
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

  const prefixes = [ITEM_PREFIX, CC_ITEM_PREFIX, ID_ITEM_PREFIX] as const;
  for (const prefix of prefixes) {
    if (menuId.startsWith(prefix)) {
      const { entryId, teamId } = parseMenuEntryId(menuId.slice(prefix.length));
      if (entryId) {
        deps.performAutofill(entryId, tab.id, teamId).catch(() => {});
      }
      return;
    }
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Encode entryId + optional teamId into a menu item ID suffix. */
function encodeMenuEntryId(entryId: string, teamId?: string): string {
  return teamId ? `${teamId}:${entryId}` : entryId;
}

/** Parse entryId + optional teamId from a menu item ID suffix. */
function parseMenuEntryId(suffix: string): { entryId: string | null; teamId?: string } {
  const colonIdx = suffix.indexOf(":");
  if (colonIdx > 0) {
    const teamId = suffix.slice(0, colonIdx);
    const entryId = suffix.slice(colonIdx + 1);
    if (UUID_RE.test(teamId) && UUID_RE.test(entryId)) {
      return { entryId, teamId };
    }
  }
  if (UUID_RE.test(suffix)) {
    return { entryId: suffix };
  }
  return { entryId: null };
}

/** Force menu rebuild (e.g., after vault unlock/lock). */
export function invalidateContextMenu(): void {
  lastMenuHost = null;
  // Immediately rebuild menu for the active tab
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab?.id) {
      updateContextMenuForTab(tab.id, tab.url);
    }
  }).catch(() => {});
}
