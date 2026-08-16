import type { DecryptedEntry } from "../types/messages";
import { EXT_ENTRY_TYPE } from "../lib/constants";
import { t } from "../lib/i18n";
import { classifyLastError, warnBackground } from "./log";

const PARENT_ID = "psso-parent";
const ITEM_PREFIX = "psso-login-";
const CC_ITEM_PREFIX = "psso-cc-";
const ID_ITEM_PREFIX = "psso-id-";
const OPEN_POPUP_ID = "psso-open-popup";
const MAX_ITEMS = 5;

/** Debounce interval for menu updates (ms). */
export const DEBOUNCE_MS = 200;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastMenuHost: string | null = null;

export interface ContextMenuDeps {
  getCachedEntries: () => Promise<DecryptedEntry[]>;
  isHostMatch: (entryHost: string, tabHost: string) => boolean;
  extractHost: (url: string) => string | null;
  isConnected: () => boolean;
  isVaultUnlocked: () => boolean;
  isContextMenuEnabled: () => Promise<boolean>;
  performAutofill: (
    entryId: string,
    tabId: number,
    teamId?: string,
    enforceSenderHost?: string,
    frameId?: number,
  ) => Promise<{ ok: boolean; error?: string }>;
  notifyFillFailure: (error: string) => void;
}

let deps: ContextMenuDeps | null = null;

export function initContextMenu(d: ContextMenuDeps): void {
  deps = d;
}

/**
 * Menu mutations are serialized on a single chain and stamped with a generation
 * token. The chain handle is assigned SYNCHRONOUSLY at call time — the previous
 * implementation read its guard inside the task body, after the task had already
 * started, so two callers arriving in the same tick never awaited each other and
 * raced into duplicate-ID errors.
 */
let menuChain: Promise<void> = Promise.resolve();
let menuGeneration = 0;

function serializeMenuTask(task: () => Promise<void>): Promise<void> {
  // Both handlers are `task`: a rejected predecessor must not skip the next
  // rebuild. The stored handle swallows rejections so the chain cannot wedge.
  const next = menuChain.then(task, task);
  menuChain = next.catch(() => {});
  return next;
}

/** Claim the next generation. A task holding a stale one abandons its writes. */
function nextGeneration(): number {
  menuGeneration += 1;
  return menuGeneration;
}

function isCurrent(generation: number): boolean {
  return generation === menuGeneration;
}

/**
 * Run a callback-style contextMenus call as a promise, reporting any failure.
 *
 * Reading lastError is required by the API to avoid "unchecked
 * runtime.lastError" noise, but the value is classified into a fixed code
 * rather than discarded: a duplicate id here means the serialization above
 * regressed, and that has to stay visible in the field.
 */
function menuCall(invoke: (done: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    invoke(() => {
      const code = classifyLastError(chrome.runtime.lastError);
      if (code) warnBackground("context-menu-create-failed", code);
      resolve();
    });
  });
}

function createMenuItem(props: chrome.contextMenus.CreateProperties): Promise<void> {
  return menuCall((done) => chrome.contextMenus.create(props, done));
}

function removeAllMenuItems(): Promise<void> {
  return menuCall((done) => chrome.contextMenus.removeAll(done));
}

/**
 * Remove all items and recreate the parent when enabled. removeAll must remain
 * the first step of every rebuild: Chrome retains menu registrations across
 * service-worker termination, so this is what makes each rebuild self-correcting
 * against state that outlived the worker.
 */
async function resetMenuWithParent(generation: number): Promise<void> {
  const enabled = deps ? await deps.isContextMenuEnabled() : false;
  if (!isCurrent(generation)) return;
  await removeAllMenuItems();
  if (!isCurrent(generation) || !enabled) return;
  await createMenuItem({
    id: PARENT_ID,
    title: t("contextMenu.title"),
    contexts: ["editable"],
  });
}

export async function setupContextMenu(): Promise<void> {
  const generation = nextGeneration();
  await serializeMenuTask(() => resetMenuWithParent(generation));
}

/**
 * Tear the menu down when the user disables it. Generation-exempt by design: it
 * bumps the counter so an in-flight rebuild abandons, but never re-checks it, so
 * a rebuild queued behind the teardown cannot resurrect a menu the user just
 * switched off. It still runs on the chain, so ordering is preserved.
 */
export async function disableContextMenu(): Promise<void> {
  // Cancel any debounced rebuild that has not fired yet. Such a request claims
  // its generation inside the timer callback, so it would otherwise claim a
  // NEWER token than this teardown and rebuild the menu the user just switched
  // off — the counter alone cannot supersede a task that has not started.
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  lastMenuHost = null;
  nextGeneration();
  await serializeMenuTask(() => removeAllMenuItems());
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
    const generation = nextGeneration();
    void serializeMenuTask(() => doUpdateMenu(url, generation));
  }, DEBOUNCE_MS);
}

async function doUpdateMenu(
  url: string | undefined,
  generation: number,
): Promise<void> {
  if (!deps || !isCurrent(generation)) return;

  if (!url) {
    await resetMenuWithParent(generation);
    if (isCurrent(generation)) lastMenuHost = null;
    return;
  }

  const host = deps.extractHost(url);
  if (!host) {
    await resetMenuWithParent(generation);
    if (isCurrent(generation)) lastMenuHost = null;
    return;
  }

  // Skip rebuild if same host
  if (host === lastMenuHost) return;

  // Read the toggle here as well as in resetMenuWithParent: with it off, the
  // parent is never created, and creating children against a missing parent is
  // what produced the orphan-parent failures on the non-racing disabled path.
  const enabled = await deps.isContextMenuEnabled();
  if (!isCurrent(generation)) return;

  await resetMenuWithParent(generation);
  if (!isCurrent(generation)) return;
  lastMenuHost = host;
  if (!enabled) return;

  if (!deps.isConnected()) {
    await createMenuItem({
      id: `${ITEM_PREFIX}disconnected`,
      parentId: PARENT_ID,
      title: t("contextMenu.disconnected"),
      contexts: ["editable"],
      enabled: false,
    });
    return;
  }

  if (!deps.isVaultUnlocked()) {
    await createMenuItem({
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
    if (!isCurrent(generation)) return;
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
      await createMenuItem({
        id: `${ITEM_PREFIX}none`,
        parentId: PARENT_ID,
        title: t("contextMenu.noMatches"),
        contexts: ["editable"],
        enabled: false,
      });
      if (!isCurrent(generation)) return;
    } else {
      // Logins section
      if (loginMatches.length > 0) {
        for (const entry of loginMatches.slice(0, MAX_ITEMS)) {
          const label = entry.username
            ? `${entry.title} (${entry.username})`
            : entry.title;
          await createMenuItem({
            id: `${ITEM_PREFIX}${encodeMenuEntryId(entry.id, entry.teamId)}`,
            parentId: PARENT_ID,
            title: label,
            contexts: ["editable"],
          });
          if (!isCurrent(generation)) return;
        }
      }

      // Credit Cards section
      if (ccEntries.length > 0) {
        if (loginMatches.length > 0) {
          await createMenuItem({
            id: `${CC_ITEM_PREFIX}sep`,
            parentId: PARENT_ID,
            type: "separator",
            contexts: ["editable"],
          });
          if (!isCurrent(generation)) return;
        }
        for (const entry of ccEntries.slice(0, MAX_ITEMS)) {
          const label = entry.title || t("contextMenu.creditCard");
          await createMenuItem({
            id: `${CC_ITEM_PREFIX}${encodeMenuEntryId(entry.id, entry.teamId)}`,
            parentId: PARENT_ID,
            title: `💳 ${label}`,
            contexts: ["editable"],
          });
          if (!isCurrent(generation)) return;
        }
      }

      // Identity section
      if (idEntries.length > 0) {
        if (loginMatches.length > 0 || ccEntries.length > 0) {
          await createMenuItem({
            id: `${ID_ITEM_PREFIX}sep`,
            parentId: PARENT_ID,
            type: "separator",
            contexts: ["editable"],
          });
          if (!isCurrent(generation)) return;
        }
        for (const entry of idEntries.slice(0, MAX_ITEMS)) {
          const label = entry.title || t("contextMenu.identity");
          await createMenuItem({
            id: `${ID_ITEM_PREFIX}${encodeMenuEntryId(entry.id, entry.teamId)}`,
            parentId: PARENT_ID,
            title: `👤 ${label}`,
            contexts: ["editable"],
          });
          if (!isCurrent(generation)) return;
        }
      }
    }

    // Separator + "Open passwd-sso"
    await createMenuItem({
      id: `${ITEM_PREFIX}sep`,
      parentId: PARENT_ID,
      type: "separator",
      contexts: ["editable"],
    });
    if (!isCurrent(generation)) return;
    await createMenuItem({
      id: OPEN_POPUP_ID,
      parentId: PARENT_ID,
      title: t("contextMenu.openPopup"),
      contexts: ["editable"],
    });
  } catch {
    // Silently fail on cache errors
  }
}

/**
 * Handle context menu item clicks.
 */
/**
 * Resolve the host of the document the user actually clicked in.
 *
 * Menu items are registered with `contexts: ["editable"]` and no
 * documentUrlPatterns, so they appear on an editable field in EVERY frame,
 * including a cross-origin iframe. Binding to the tab's top-level URL would
 * therefore adjudicate a different document than the one clicked — the same
 * reasoning the content path already applies to `_sender.url` over
 * `_sender.tab.url`.
 *
 * frameUrl/pageUrl are supplied by Chrome on the click event itself and need no
 * `tabs` permission; tab.url (which does) is only the last fallback.
 */
function resolveClickHost(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
): string | null {
  if (!deps) return null;
  for (const candidate of [info.frameUrl, info.pageUrl, tab?.url]) {
    if (!candidate) continue;
    const host = deps.extractHost(candidate);
    if (host) return host;
  }
  return null;
}

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
      if (!entryId) return;

      // Fail closed when the clicked document cannot be identified. Passing
      // undefined here would mean "trusted UI, skip the origin check", which is
      // the opposite of what an unresolvable host warrants.
      const host = resolveClickHost(info, tab);
      if (!host) {
        deps.notifyFillFailure("UNKNOWN_ORIGIN");
        return;
      }

      const tabId = tab.id;
      void (async () => {
        try {
          const result = await deps!.performAutofill(
            entryId,
            tabId,
            teamId,
            host,
            info.frameId,
          );
          if (!result.ok) deps!.notifyFillFailure(result.error ?? "FILL_FAILED");
        } catch {
          deps!.notifyFillFailure("FILL_FAILED");
        }
      })();
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

/**
 * Force a menu rebuild (e.g. after vault unlock/lock). Nulling lastMenuHost
 * synchronously is what defeats the same-host early return for a rebuild that is
 * already in flight — the reason this path participates in the race rather than
 * being serialized away by the debounce.
 */
export function invalidateContextMenu(): void {
  lastMenuHost = null;
  // Immediately rebuild menu for the active tab
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab?.id) {
      updateContextMenuForTab(tab.id, tab.url);
    }
  }).catch(() => {});
}
