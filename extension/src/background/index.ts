import type {
  AutofillTargetHint,
  DecryptedEntry,
  ExtensionMessage,
  ExtensionResponse,
} from "../types/messages";
import {
  buildPersonalEntryAAD,
  decryptData,
  deriveEncryptionKey,
  deriveWrappingKey,
  hexDecode,
  unwrapSecretKey,
  verifyKey,
  type EncryptedData,
} from "../lib/crypto";
import { EXT_API_PATH, extApiPath } from "../lib/api-paths";
import {
  deriveEcdhWrappingKey,
  unwrapEcdhPrivateKey,
  importEcdhPrivateKey,
  unwrapTeamKey,
  deriveTeamEncryptionKey,
  unwrapItemKey,
  deriveItemEncryptionKey,
  buildTeamEntryAAD,
  buildItemKeyWrapAAD,
  type TeamKeyWrapContext,
} from "../lib/crypto-team";
import { getSettings, validateSettings } from "../lib/storage";
import { normalizeErrorCode } from "../lib/error-utils";
import { extractHost, isHostMatch } from "../lib/url-matching";
import {
  persistSession,
  loadSession,
  clearSession,
} from "../lib/session-storage";
import {
  ALARM_TOKEN_TTL,
  ALARM_VAULT_LOCK,
  ALARM_TOKEN_REFRESH,
  ALARM_CLEAR_CLIPBOARD,
  TOKEN_BRIDGE_SCRIPT_ID,
  CMD_TRIGGER_AUTOFILL,
  CMD_COPY_PASSWORD,
  CMD_COPY_USERNAME,
  CMD_LOCK_VAULT,
  EXT_ENTRY_TYPE,
} from "../lib/constants";
import { generateTOTPCode } from "../lib/totp";
import {
  initContextMenu,
  setupContextMenu,
  updateContextMenuForTab,
  handleContextMenuClick,
  invalidateContextMenu,
} from "./context-menu";
import {
  initLoginSave,
  handleLoginDetected,
  handleSaveLogin,
  handleUpdateLogin,
} from "./login-save";
import { copyToClipboard } from "./clipboard";

// ── In-memory state (token/userId persisted to chrome.storage.session) ──

let currentToken: string | null = null;
let tokenExpiresAt: number | null = null;
let encryptionKey: CryptoKey | null = null;
let currentUserId: string | null = null;
let currentVaultSecretKeyHex: string | null = null;
// Tenant policy auto-lock override (null = use local setting)
let tenantAutoLockMinutes: number | null = null;

// ── Team key state ──────────────────────────────────────────────
let ecdhPrivateKeyBytes: Uint8Array | null = null;
/** Encrypted ECDH data for session persistence (re-unwrap on SW restart) */
let ecdhEncryptedData: { ciphertext: string; iv: string; authTag: string } | null = null;

interface TeamKeyCacheEntry {
  key: CryptoKey;
  cachedAt: number;
}
const teamKeyCache = new Map<string, TeamKeyCacheEntry>();
const TEAM_KEY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_TEAM_KEY_CACHE = 50;
const MAX_TEAMS = 10;

const CACHE_TTL_MS = 60_000; // 1 minute
const REFRESH_BUFFER_MS = 2 * 60 * 1000; // refresh 2 min before expiry

let lastClipboardCopyTime = 0;

/** Resolve effective auto-lock minutes: tenant policy > local setting */
async function getEffectiveAutoLockMinutes(): Promise<number> {
  if (tenantAutoLockMinutes != null && tenantAutoLockMinutes > 0) {
    return tenantAutoLockMinutes;
  }
  const { autoLockMinutes } = await getSettings();
  return autoLockMinutes;
}

// ── Pending save prompts (login detection → post-navigation banner) ──

interface PendingSavePrompt {
  host: string;
  username: string;
  password: string;
  action: "save" | "update";
  existingEntryId?: string;
  existingTitle?: string;
  timestamp: number;
}

const PENDING_SAVE_TTL_MS = 30_000; // 30 seconds
const MAX_PENDING_SAVES = 5;
const pendingSavePrompts = new Map<number, PendingSavePrompt>();

// ── Entry cache (TTL-based) ─────────────────────────────────

let cachedEntries: DecryptedEntry[] | null = null;
let cacheTimestamp = 0;

async function configureSessionStorageAccess(): Promise<void> {
  try {
    // Limit session storage to trusted extension contexts.
    await chrome.storage.session.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS",
    });
  } catch {
    // Best effort: older browsers or restricted environments may not support this.
  }
}

// ── Offscreen keepalive ───────────────────────────────────
// Prevents SW termination during the 30-second idle timeout
// by pinging from the existing offscreen document (shared with clipboard).

async function ensureOffscreen(): Promise<void> {
  try {
    const exists = await chrome.offscreen.hasDocument?.();
    if (!exists) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["CLIPBOARD" as chrome.offscreen.Reason],
        justification: "Clipboard access and SW keepalive",
      });
    }
  } catch {
    // Best effort
  }
}

async function startKeepalive(): Promise<void> {
  await ensureOffscreen();
  try {
    await chrome.runtime.sendMessage({ target: "offscreen", type: "start-keepalive" });
  } catch {
    // ignore
  }
}

async function stopKeepalive(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ target: "offscreen", type: "stop-keepalive" });
  } catch {
    // ignore — offscreen document may not exist
  }
}

function invalidateCache(): void {
  cachedEntries = null;
  cacheTimestamp = 0;
}

async function getCachedEntries(): Promise<DecryptedEntry[]> {
  if (cachedEntries && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedEntries;
  }
  const [personalResult, teamResult] = await Promise.allSettled([
    (async () => {
      const res = await swFetch(EXT_API_PATH.PASSWORDS);
      if (!res.ok) return [];
      const raw = (await res.json()) as RawEntry[];
      return decryptOverviews(raw);
    })(),
    fetchAllTeamEntries(),
  ]);
  const personal = personalResult.status === "fulfilled" ? personalResult.value : [];
  const team = teamResult.status === "fulfilled" ? teamResult.value : [];
  const entries = [...personal, ...team];
  cachedEntries = entries;
  cacheTimestamp = Date.now();
  return entries;
}

/** Securely clear token from memory and session storage */
function clearToken(): void {
  currentToken = null;
  tokenExpiresAt = null;
  clearVault();
  chrome.alarms.clear(ALARM_TOKEN_REFRESH);
  clearSession().catch(() => {});
  void updateBadge();
}

function clearVault(): void {
  encryptionKey = null;
  currentUserId = null;
  currentVaultSecretKeyHex = null;
  tenantAutoLockMinutes = null;
  // Zero-clear ECDH private key bytes (defense-in-depth)
  if (ecdhPrivateKeyBytes) {
    ecdhPrivateKeyBytes.fill(0);
    ecdhPrivateKeyBytes = null;
  }
  ecdhEncryptedData = null;
  teamKeyCache.clear();
  invalidateCache();
  invalidateContextMenu();
  pendingSavePrompts.clear();
  chrome.alarms.clear(ALARM_VAULT_LOCK);
  void stopKeepalive();
  persistState();
  void updateBadge();
}

async function clearAllTabBadges(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    // Use null to remove per-tab override so the global badge (×/!) becomes visible.
    // An empty string "" would set a per-tab override that hides the global badge.
    await Promise.all(
      tabs
        .filter((tab) => tab.id)
        .map((tab) => chrome.action.setBadgeText({ text: null as unknown as string, tabId: tab.id! }).catch(() => {})),
    );
  } catch {
    // ignore — best effort cleanup
  }
}

async function updateBadgeForTab(tabId: number, url: string | undefined): Promise<void> {
  if (!currentToken || !encryptionKey) return;
  const { showBadgeCount } = validateSettings(await getSettings());
  if (!showBadgeCount) {
    await chrome.action.setBadgeText({ text: "", tabId }).catch(() => {});
    return;
  }
  try {
    if (!url) {
      await chrome.action.setBadgeText({ text: "", tabId });
      return;
    }
    const host = extractHost(url);
    if (!host || await isOwnAppPage(url)) {
      await chrome.action.setBadgeText({ text: "", tabId });
      return;
    }
    // Read from cache only — never trigger network fetches from badge updates.
    // Cache is populated by FETCH_PASSWORDS (popup open) and GET_MATCHES_FOR_URL
    // (form detection). Fetching here would race with autofill operations.
    if (!cachedEntries) {
      await chrome.action.setBadgeText({ text: "", tabId });
      return;
    }
    const count = cachedEntries.filter((e) => {
      if (e.entryType !== EXT_ENTRY_TYPE.LOGIN) return false;
      if (e.urlHost && isHostMatch(e.urlHost, host)) return true;
      return (e.additionalUrlHosts ?? []).some((h) => isHostMatch(h, host));
    }).length;
    const text = count === 0 ? "" : count > 99 ? "99+" : count.toString();
    await chrome.action.setBadgeText({ text, tabId });
    if (count > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: "#3B82F6", tabId });
    }
  } catch {
    await chrome.action.setBadgeText({ text: "", tabId }).catch(() => {});
  }
}

async function updateBadge(): Promise<void> {
  if (!currentToken) {
    await clearAllTabBadges();
    await chrome.action.setBadgeText({ text: "×" });
    await chrome.action.setBadgeBackgroundColor({ color: "#9CA3AF" });
    return;
  }
  if (!encryptionKey) {
    await clearAllTabBadges();
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#F59E0B" });
    return;
  }
  // Connected and vault unlocked — clear stale per-tab badges.
  // Per-tab match counts will be set by tabs.onActivated / tabs.onUpdated events.
  await clearAllTabBadges();
  await chrome.action.setBadgeText({ text: "" });
}

// ── Session persistence & token refresh ──────────────────────

/** Fire-and-forget persist of token state to chrome.storage.session */
function persistState(): void {
  if (currentToken && tokenExpiresAt) {
    persistSession({
      token: currentToken,
      expiresAt: tokenExpiresAt,
      userId: currentUserId ?? undefined,
      vaultSecretKey: currentVaultSecretKeyHex ?? undefined,
      ecdhEncrypted: ecdhEncryptedData ?? undefined,
    }).catch(() => {});
  }
}

/** Restore in-memory state from chrome.storage.session on SW startup */
async function hydrateFromSession(): Promise<void> {
  const state = await loadSession();
  if (!state) return;

  if (Date.now() >= state.expiresAt) {
    await clearSession();
    return;
  }

  currentToken = state.token;
  tokenExpiresAt = state.expiresAt;
  currentUserId = state.userId ?? null;
  currentVaultSecretKeyHex = state.vaultSecretKey ?? null;

  if (currentVaultSecretKeyHex) {
    try {
      const secretKey = hexDecode(currentVaultSecretKeyHex);
      encryptionKey = await deriveEncryptionKey(secretKey);
      secretKey.fill(0);
    } catch {
      encryptionKey = null;
      currentVaultSecretKeyHex = null;
      persistState();
    }

    // Restore ECDH private key for team features
    if (state.ecdhEncrypted && currentVaultSecretKeyHex) {
      try {
        const secretKeyForEcdh = hexDecode(currentVaultSecretKeyHex!);
        const ecdhWrappingKey = await deriveEcdhWrappingKey(secretKeyForEcdh);
        secretKeyForEcdh.fill(0);
        ecdhPrivateKeyBytes = await unwrapEcdhPrivateKey(
          state.ecdhEncrypted,
          ecdhWrappingKey,
        );
        ecdhEncryptedData = state.ecdhEncrypted;
      } catch {
        ecdhPrivateKeyBytes = null;
        ecdhEncryptedData = null;
      }
    }
  }

  // Re-create TTL expiry alarm
  chrome.alarms.create(ALARM_TOKEN_TTL, { when: state.expiresAt });
  // Schedule refresh
  scheduleRefreshAlarm(state.expiresAt);

  // Restore vault auto-lock alarm and keepalive if vault is unlocked
  if (encryptionKey) {
    const effectiveLock = await getEffectiveAutoLockMinutes();
    if (effectiveLock > 0) {
      chrome.alarms.create(ALARM_VAULT_LOCK, { delayInMinutes: effectiveLock });
    }
    void startKeepalive();
  }

  void updateBadge();
}

function scheduleRefreshAlarm(expiresAt: number): void {
  const refreshAt = expiresAt - REFRESH_BUFFER_MS;
  if (refreshAt <= Date.now()) {
    // Already within the refresh window — attempt immediately
    attemptTokenRefresh().catch(() => {});
  } else {
    chrome.alarms.create(ALARM_TOKEN_REFRESH, { when: refreshAt });
  }
}

async function attemptTokenRefresh(): Promise<void> {
  if (!currentToken || !tokenExpiresAt) return;
  if (Date.now() >= tokenExpiresAt) return;

  try {
    const { serverUrl } = await getSettings();
    try {
      new URL(serverUrl);
    } catch {
      return;
    }

    const res = await fetch(`${serverUrl}${EXT_API_PATH.EXTENSION_TOKEN_REFRESH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${currentToken}` },
    });

    if (res.ok) {
      const data = (await res.json()) as {
        token: string;
        expiresAt: string;
        scope: string[];
      };
      const newExpiresAt = new Date(data.expiresAt).getTime();
      currentToken = data.token;
      tokenExpiresAt = newExpiresAt;

      chrome.alarms.create(ALARM_TOKEN_TTL, { when: newExpiresAt });
      scheduleRefreshAlarm(newExpiresAt);
      persistState();
    } else if (res.status === 401 || res.status === 403 || res.status === 404) {
      // Permanent rejection — token is invalid/revoked/session gone
      clearToken();
    } else {
      // Transient error (429, 5xx) — retry if enough TTL remains
      if (tokenExpiresAt && tokenExpiresAt - Date.now() > 60_000) {
        chrome.alarms.create(ALARM_TOKEN_REFRESH, {
          delayInMinutes: 1,
        });
      }
    }
  } catch {
    // Network error — keep current token, retry if enough TTL remains
    if (tokenExpiresAt && tokenExpiresAt - Date.now() > 60_000) {
      chrome.alarms.create(ALARM_TOKEN_REFRESH, {
        delayInMinutes: 1,
      });
    }
  }
}

async function revokeCurrentTokenOnServer(): Promise<void> {
  if (!currentToken) return;
  try {
    const { serverUrl } = await getSettings();
    try {
      new URL(serverUrl);
    } catch {
      return;
    }
    await fetch(`${serverUrl}${EXT_API_PATH.EXTENSION_TOKEN}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${currentToken}` },
    });
  } catch {
    // Best-effort revoke; local clear still proceeds.
  }
}

async function isOwnAppPage(url: string): Promise<boolean> {
  let pageUrl: URL;
  try {
    pageUrl = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(pageUrl.protocol)) return false;

  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  if (typeof serverUrl !== "string" || !serverUrl) {
    return false;
  }
  let base: URL;
  try {
    base = new URL(serverUrl);
  } catch {
    return false;
  }
  if (pageUrl.origin !== base.origin) {
    return false;
  }
  const bp = base.pathname || "/";
  if (pageUrl.pathname !== bp && !pageUrl.pathname.startsWith(bp.endsWith("/") ? bp : `${bp}/`)) {
    return false;
  }

  // This is our own app — suppress inline suggestions, auto-save banner, etc.
  return true;
}

// Harden session storage visibility on SW startup (best-effort).
void configureSessionStorageAccess();

// Hydrate on SW startup
const hydrationPromise = hydrateFromSession().catch(() => {});

// ── Context menu ─────────────────────────────────────────────

initContextMenu({
  getCachedEntries,
  isHostMatch,
  extractHost,
  isConnected: () => currentToken !== null,
  isVaultUnlocked: () => encryptionKey !== null,
  isContextMenuEnabled: async () => validateSettings(await getSettings()).enableContextMenu,
  performAutofill: async (entryId, tabId, teamId) => {
    await performAutofillForEntry(entryId, tabId, undefined, teamId);
  },
});

// ── Login save ──────────────────────────────────────────────

initLoginSave({
  getEncryptionKey: () => encryptionKey,
  getCurrentUserId: () => currentUserId,
  getCachedEntries,
  isHostMatch,
  extractHost,
  swFetch,
  invalidateCache,
});

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();
});
chrome.runtime.onStartup.addListener(() => {
  setupContextMenu();
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId).then((tab) => {
    updateContextMenuForTab(tab.id!, tab.url);
    void updateBadgeForTab(tab.id!, tab.url);
  }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") {
    // Clear stale badge count during navigation
    chrome.action.setBadgeText({ text: "", tabId }).catch(() => {});
  }
  if (changeInfo.status === "complete") {
    updateContextMenuForTab(tabId, tab.url);
    void updateBadgeForTab(tabId, tab.url);

    // Push pending save prompt to the new page after navigation.
    // Use a short delay to give content scripts (document_idle) time to load.
    // Do NOT delete from the map before confirming delivery — the pull
    // mechanism (CHECK_PENDING_SAVE) acts as a fallback if push fails.
    const pending = pendingSavePrompts.get(tabId);
    if (pending) {
      if (Date.now() - pending.timestamp >= PENDING_SAVE_TTL_MS) {
        pendingSavePrompts.delete(tabId);
      } else {
        // Security: only push to pages on the same host as the original login.
        // Prevents sending plain-text password to unrelated domains after
        // cross-origin redirects (e.g., OAuth flows).
        const tabHost = tab.url ? extractHost(tab.url) : null;
        if (!tabHost || !isHostMatch(pending.host, tabHost)) {
          pendingSavePrompts.delete(tabId);
          return;
        }
        setTimeout(async () => {
          // Re-check prompt preferences at delivery time
          const deliverySettings = validateSettings(await getSettings());
          if (pending.action === "save" && !deliverySettings.showSavePrompt) {
            pendingSavePrompts.delete(tabId);
            return;
          }
          if (pending.action === "update" && !deliverySettings.showUpdatePrompt) {
            pendingSavePrompts.delete(tabId);
            return;
          }
          chrome.tabs.sendMessage(tabId, {
            type: "PSSO_SHOW_SAVE_BANNER",
            host: pending.host,
            username: pending.username,
            password: pending.password,
            action: pending.action,
            existingEntryId: pending.existingEntryId,
            existingTitle: pending.existingTitle,
          }).then(() => {
            // Delivered successfully — remove from pending
            pendingSavePrompts.delete(tabId);
          }).catch(() => {
            // Content script not ready — leave in map for pull mechanism
          });
        }, 500);
      }
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingSavePrompts.delete(tabId);
});

chrome.contextMenus.onClicked.addListener(handleContextMenuClick);

// ── Alarm: auto-clear on expiry ──────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_TOKEN_TTL) {
    clearToken();
  }
  if (alarm.name === ALARM_VAULT_LOCK) {
    (async () => {
      const { vaultTimeoutAction } = validateSettings(await getSettings());
      if (vaultTimeoutAction === "logout") {
        await revokeCurrentTokenOnServer();
        clearToken();
      } else {
        clearVault();
      }
    })().catch(() => {});
  }
  if (alarm.name === ALARM_TOKEN_REFRESH) {
    attemptTokenRefresh().catch(() => {});
  }
  if (alarm.name === ALARM_CLEAR_CLIPBOARD) {
    (async () => {
      const { clipboardClearSeconds } = validateSettings(await getSettings());
      if (Date.now() - lastClipboardCopyTime >= clipboardClearSeconds * 1000) {
        await copyToClipboard("");
      }
    })().catch(() => {});
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.serverUrl?.newValue) {
    registerTokenBridgeScript(String(changes.serverUrl.newValue)).catch(() => {});
  }
  // Context menu toggle
  if (changes.enableContextMenu) {
    if (changes.enableContextMenu.newValue === false) {
      chrome.contextMenus.removeAll().catch(() => {});
    } else {
      setupContextMenu();
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) updateContextMenuForTab(tabs[0].id, tabs[0].url);
      });
    }
  }
  // Badge toggle — refresh active tab badge
  if (changes.showBadgeCount) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) void updateBadgeForTab(tabs[0].id, tabs[0].url);
    });
  }
  // Clipboard clear delay — reschedule alarm if a copy is pending
  if (changes.clipboardClearSeconds && lastClipboardCopyTime > 0) {
    const raw = changes.clipboardClearSeconds.newValue;
    if (typeof raw === "number" && raw > 0) {
      chrome.alarms.clear(ALARM_CLEAR_CLIPBOARD).catch(() => {});
      chrome.alarms.create(ALARM_CLEAR_CLIPBOARD, {
        delayInMinutes: Math.max((raw * 2) / 60, 1),
      });
    }
  }
  // Auto-lock minutes
  if (changes.autoLockMinutes) {
    if (!encryptionKey) return;
    // Tenant policy takes precedence — ignore local setting changes
    if (tenantAutoLockMinutes != null && tenantAutoLockMinutes > 0) return;
    const newValue = changes.autoLockMinutes.newValue;
    if (typeof newValue !== "number" || !Number.isFinite(newValue)) return;
    chrome.alarms.clear(ALARM_VAULT_LOCK);
    if (newValue > 0) {
      chrome.alarms.create(ALARM_VAULT_LOCK, { delayInMinutes: newValue });
    }
  }
});

async function registerTokenBridgeScript(serverUrl: string): Promise<void> {
  let origin: string;
  try {
    origin = new URL(serverUrl).origin;
  } catch {
    return;
  }
  try {
    await chrome.scripting.unregisterContentScripts({
      ids: [TOKEN_BRIDGE_SCRIPT_ID],
    });
  } catch {
    // ignore
  }
  const allowed = await chrome.permissions.contains({
    origins: [`${origin}/*`],
  });
  if (!allowed) return;
  await chrome.scripting.registerContentScripts([
    {
      id: TOKEN_BRIDGE_SCRIPT_ID,
      matches: [`${origin}/*`],
      js: ["src/content/token-bridge.js"],
      runAt: "document_start",
    },
  ]);
}

getSettings()
  .then(({ serverUrl }) => registerTokenBridgeScript(serverUrl))
  .catch(() => {});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === CMD_TRIGGER_AUTOFILL) {
    if (!currentToken || !encryptionKey || !currentUserId) return;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) return;
    if (!extractHost(tab.url)) return;

    try {
      await chrome.tabs.sendMessage(tab.id, { type: "PSSO_TRIGGER_INLINE_SUGGESTIONS" });
    } catch {
      // Ensure content script is present on already-open tabs, then retry.
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ["src/content/form-detector.js"],
        });
        await chrome.tabs.sendMessage(tab.id, { type: "PSSO_TRIGGER_INLINE_SUGGESTIONS" });
      } catch {
        // ignore on restricted pages
      }
    }
    return;
  }

  if (command === CMD_LOCK_VAULT) {
    clearVault();
    return;
  }

  if (command === CMD_COPY_PASSWORD || command === CMD_COPY_USERNAME) {
    if (!currentToken || !encryptionKey || !currentUserId) {
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
      return;
    }

    const tabHost = extractHost(tab.url);
    if (!tabHost) {
      return;
    }

    try {
      const entries = await getCachedEntries();
      const match = entries.find(
        (e) => e.entryType === EXT_ENTRY_TYPE.LOGIN && (
          (e.urlHost && isHostMatch(e.urlHost, tabHost)) ||
          (e.additionalUrlHosts ?? []).some((h) => isHostMatch(h, tabHost))
        ),
      );
      if (!match) {
        return;
      }

      // Fetch full blob to get password/username
      let blob: { password?: string | null; username?: string | null };

      if (match.teamId) {
        const result = await fetchAndDecryptTeamBlob(match.teamId, match.id);
        if (!result) return;
        blob = result.blob as typeof blob;
      } else {
        const res = await swFetch(extApiPath.passwordById(match.id));
        if (!res.ok) return;

        const data = (await res.json()) as {
          encryptedBlob: { ciphertext: string; iv: string; authTag: string };
          aadVersion?: number;
          id: string;
        };

        const aad =
          (data.aadVersion ?? 0) >= 1
            ? buildPersonalEntryAAD(currentUserId!, data.id)
            : undefined;
        const plaintext = await decryptData(data.encryptedBlob, encryptionKey!, aad);
        blob = JSON.parse(plaintext) as typeof blob;
      }

      const value =
        command === CMD_COPY_PASSWORD
          ? blob.password ?? null
          : blob.username ?? null;
      if (!value) return;

      // Copy via offscreen document (no page DOM manipulation, no focus stealing)
      await copyToClipboard(value);

      // Schedule clipboard clear: dynamic delay from settings + alarm fallback
      const { clipboardClearSeconds } = validateSettings(await getSettings());
      const clipMs = clipboardClearSeconds * 1000;
      lastClipboardCopyTime = Date.now();
      await chrome.alarms.clear(ALARM_CLEAR_CLIPBOARD).catch(() => {});
      setTimeout(async () => {
        try {
          if (Date.now() - lastClipboardCopyTime >= clipMs) {
            await copyToClipboard("");
          }
        } catch {
          // ignore — offscreen document may have been closed
        }
      }, clipMs);
      chrome.alarms.create(ALARM_CLEAR_CLIPBOARD, {
        delayInMinutes: Math.max((clipboardClearSeconds * 2) / 60, 1),
      });
    } catch (err) {
      console.warn("[psso] copy command failed:", err);
    }
  }
});

async function swFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!currentToken) {
    throw new Error("NO_TOKEN");
  }
  const { serverUrl } = await getSettings();
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new Error("INVALID_SERVER_URL");
  }
  const allowed = await chrome.permissions.contains({
    origins: [`${parsed.origin}/*`],
  });
  if (!allowed) {
    throw new Error("PERMISSION_DENIED");
  }

  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${currentToken}`);
  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(`${serverUrl}${path}`, { ...init, headers });
}

type RawEntry = {
  id: string;
  encryptedOverview: { ciphertext: string; iv: string; authTag: string };
  entryType: string;
  aadVersion?: number;
  urlHost?: string;
  deletedAt?: string | null;
  isArchived?: boolean;
};

async function decryptOverviews(raw: RawEntry[]): Promise<DecryptedEntry[]> {
  if (!encryptionKey || !currentUserId) return [];
  // Defense-in-depth: API should already filter these, but exclude
  // trashed/archived entries client-side in case of stale cache or API bug.
  const ACTIONABLE_TYPES: Set<string> = new Set([EXT_ENTRY_TYPE.LOGIN, EXT_ENTRY_TYPE.CREDIT_CARD, EXT_ENTRY_TYPE.IDENTITY]);
  const active = raw.filter((item) => !item.deletedAt && !item.isArchived && ACTIONABLE_TYPES.has(item.entryType));
  const entries: DecryptedEntry[] = [];
  for (const item of active) {
    const aad =
      (item.aadVersion ?? 0) >= 1
        ? buildPersonalEntryAAD(currentUserId, item.id)
        : undefined;
    try {
      const plaintext = await decryptData(
        item.encryptedOverview,
        encryptionKey,
        aad
      );
      const overview = JSON.parse(plaintext) as {
        title?: string;
        username?: string;
        urlHost?: string;
        additionalUrlHosts?: string[];
        cardholderName?: string;
        fullName?: string;
      };
      const additionalUrlHosts = Array.isArray(overview.additionalUrlHosts)
        ? overview.additionalUrlHosts.filter((h) => typeof h === "string" && h)
        : [];
      entries.push({
        id: item.id,
        title: overview.title ?? "",
        username:
          overview.username ??
          overview.cardholderName ??
          overview.fullName ??
          "",
        urlHost: overview.urlHost ?? "",
        ...(additionalUrlHosts.length > 0 && { additionalUrlHosts }),
        entryType: item.entryType,
      });
    } catch {
      // Skip entries that fail to decrypt/parse
    }
  }
  return entries;
}

// ── Team types ──────────────────────────────────────────────────

type RawTeamEntry = {
  id: string;
  entryType: string;
  encryptedOverview: string;
  overviewIv: string;
  overviewAuthTag: string;
  aadVersion?: number;
  teamKeyVersion: number;
  itemKeyVersion?: number;
  encryptedItemKey?: string;
  itemKeyIv?: string;
  itemKeyAuthTag?: string;
  deletedAt?: string | null;
  isArchived?: boolean;
};

// ── Team key management ─────────────────────────────────────────

async function getTeamEncryptionKey(
  teamId: string,
  keyVersion?: number,
): Promise<CryptoKey | null> {
  if (!ecdhPrivateKeyBytes || !currentUserId) return null;

  // Check cache first when keyVersion is known (avoids redundant network request)
  // Include userId in cache key to prevent cross-user cache reuse
  if (keyVersion != null) {
    const earlyKey = `${currentUserId}:${teamId}:${keyVersion}`;
    const earlyCached = teamKeyCache.get(earlyKey);
    if (earlyCached && Date.now() - earlyCached.cachedAt < TEAM_KEY_CACHE_TTL_MS) {
      return earlyCached.key;
    }
  }

  // Fetch member key from server
  const queryParam = keyVersion != null ? `?keyVersion=${keyVersion}` : "";
  const res = await swFetch(`${extApiPath.teamMemberKey(teamId)}${queryParam}`);
  if (!res.ok) return null;

  const memberKey = (await res.json()) as {
    encryptedTeamKey: string;
    teamKeyIv: string;
    teamKeyAuthTag: string;
    ephemeralPublicKey: string;
    hkdfSalt: string;
    keyVersion: number;
    wrapVersion: number;
  };

  const cacheKey = `${currentUserId}:${teamId}:${memberKey.keyVersion}`;

  // Check cache
  const cached = teamKeyCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < TEAM_KEY_CACHE_TTL_MS) {
    return cached.key;
  }

  // Import ECDH private key and unwrap team key
  const memberPrivateKey = await importEcdhPrivateKey(ecdhPrivateKeyBytes);

  const ctx: TeamKeyWrapContext = {
    teamId,
    toUserId: currentUserId,
    keyVersion: memberKey.keyVersion,
    wrapVersion: memberKey.wrapVersion,
  };

  const encrypted: EncryptedData = {
    ciphertext: memberKey.encryptedTeamKey,
    iv: memberKey.teamKeyIv,
    authTag: memberKey.teamKeyAuthTag,
  };

  const teamKeyBytes = await unwrapTeamKey(
    encrypted,
    memberKey.ephemeralPublicKey,
    memberPrivateKey,
    memberKey.hkdfSalt,
    ctx,
  );

  const teamEncKey = await deriveTeamEncryptionKey(teamKeyBytes);
  teamKeyBytes.fill(0);

  // LRU eviction if cache is full
  if (teamKeyCache.size >= MAX_TEAM_KEY_CACHE) {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [k, v] of teamKeyCache) {
      if (v.cachedAt < oldestTime) {
        oldestTime = v.cachedAt;
        oldestKey = k;
      }
    }
    if (oldestKey) teamKeyCache.delete(oldestKey);
  }

  teamKeyCache.set(cacheKey, { key: teamEncKey, cachedAt: Date.now() });
  return teamEncKey;
}

// ── Team overview decryption ────────────────────────────────────

async function decryptTeamOverviews(
  teamId: string,
  teamName: string,
  raw: RawTeamEntry[],
): Promise<DecryptedEntry[]> {
  const ACTIONABLE_TYPES: Set<string> = new Set([EXT_ENTRY_TYPE.LOGIN, EXT_ENTRY_TYPE.CREDIT_CARD, EXT_ENTRY_TYPE.IDENTITY]);
  const active = raw.filter(
    (item) => !item.deletedAt && !item.isArchived && ACTIONABLE_TYPES.has(item.entryType),
  );

  async function decryptSingleEntry(item: RawTeamEntry): Promise<DecryptedEntry | null> {
    const itemKeyVersion = item.itemKeyVersion ?? 0;
    let decryptionKey: CryptoKey | null;

    if (itemKeyVersion >= 1) {
      // ItemKey required but missing — skip entry
      if (!item.encryptedItemKey || !item.itemKeyIv || !item.itemKeyAuthTag) return null;
      const teamEncKey = await getTeamEncryptionKey(teamId, item.teamKeyVersion);
      if (!teamEncKey) return null;
      const itemKeyWrapAAD = buildItemKeyWrapAAD(teamId, item.id, item.teamKeyVersion);
      const itemKeyBytes = await unwrapItemKey(
        { ciphertext: item.encryptedItemKey, iv: item.itemKeyIv, authTag: item.itemKeyAuthTag },
        teamEncKey,
        itemKeyWrapAAD,
      );
      decryptionKey = await deriveItemEncryptionKey(itemKeyBytes);
      itemKeyBytes.fill(0);
    } else {
      decryptionKey = await getTeamEncryptionKey(teamId, item.teamKeyVersion);
    }

    if (!decryptionKey) return null;
    const aad = buildTeamEntryAAD(teamId, item.id, "overview", itemKeyVersion);
    const plaintext = await decryptData(
      { ciphertext: item.encryptedOverview, iv: item.overviewIv, authTag: item.overviewAuthTag },
      decryptionKey,
      aad,
    );
    const overview = JSON.parse(plaintext) as {
      title?: string;
      username?: string;
      urlHost?: string;
      additionalUrlHosts?: string[];
      cardholderName?: string;
      fullName?: string;
    };
    const additionalUrlHosts = Array.isArray(overview.additionalUrlHosts)
      ? overview.additionalUrlHosts.filter((h) => typeof h === "string" && h)
      : [];
    return {
      id: item.id,
      title: overview.title ?? "",
      username: overview.username ?? overview.cardholderName ?? overview.fullName ?? "",
      urlHost: overview.urlHost ?? "",
      ...(additionalUrlHosts.length > 0 && { additionalUrlHosts }),
      entryType: item.entryType,
      teamId,
      teamName,
    };
  }

  const entries: DecryptedEntry[] = [];
  for (const item of active) {
    try {
      const result = await decryptSingleEntry(item);
      if (result) entries.push(result);
    } catch {
      // Invalidate cache and retry once
      const cacheKey = `${teamId}:${item.teamKeyVersion}`;
      if (teamKeyCache.has(cacheKey)) {
        teamKeyCache.delete(cacheKey);
        try {
          const result = await decryptSingleEntry(item);
          if (result) entries.push(result);
        } catch {
          // Second attempt failed — skip this entry
        }
      }
    }
  }
  return entries;
}

// ── Fetch all team entries ──────────────────────────────────────

async function fetchAllTeamEntries(): Promise<DecryptedEntry[]> {
  if (!ecdhPrivateKeyBytes || !currentUserId) return [];

  try {
    const teamsRes = await swFetch(EXT_API_PATH.TEAMS);
    if (!teamsRes.ok) return [];

    const teams = (await teamsRes.json()) as Array<{ id: string; name: string }>;
    const limitedTeams = teams.slice(0, MAX_TEAMS);

    const results = await Promise.allSettled(
      limitedTeams.map(async (team) => {
        const res = await swFetch(extApiPath.teamPasswords(team.id));
        if (!res.ok) return [];
        const raw = (await res.json()) as RawTeamEntry[];
        return decryptTeamOverviews(team.id, team.name, raw);
      }),
    );

    const entries: DecryptedEntry[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        entries.push(...result.value);
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// ── Team entry blob decryption helper ───────────────────────────

async function fetchAndDecryptTeamBlob(
  teamId: string,
  entryId: string,
): Promise<{ blob: Record<string, unknown>; overview: Record<string, unknown>; entryType: string } | null> {
  const res = await swFetch(extApiPath.teamPasswordById(teamId, entryId));
  if (!res.ok) return null;

  const data = (await res.json()) as {
    id: string;
    entryType: string;
    encryptedBlob: string;
    blobIv: string;
    blobAuthTag: string;
    encryptedOverview: string;
    overviewIv: string;
    overviewAuthTag: string;
    aadVersion?: number;
    teamKeyVersion: number;
    itemKeyVersion?: number;
    encryptedItemKey?: string;
    itemKeyIv?: string;
    itemKeyAuthTag?: string;
  };

  const itemKeyVersion = data.itemKeyVersion ?? 0;
  let decryptionKey: CryptoKey | null;

  if (itemKeyVersion >= 1) {
    if (!data.encryptedItemKey || !data.itemKeyIv || !data.itemKeyAuthTag) return null;
    const teamEncKey = await getTeamEncryptionKey(teamId, data.teamKeyVersion);
    if (!teamEncKey) return null;
    const itemKeyWrapAAD = buildItemKeyWrapAAD(teamId, data.id, data.teamKeyVersion);
    const itemKeyBytes = await unwrapItemKey(
      { ciphertext: data.encryptedItemKey, iv: data.itemKeyIv, authTag: data.itemKeyAuthTag },
      teamEncKey,
      itemKeyWrapAAD,
    );
    decryptionKey = await deriveItemEncryptionKey(itemKeyBytes);
    itemKeyBytes.fill(0);
  } else {
    decryptionKey = await getTeamEncryptionKey(teamId, data.teamKeyVersion);
  }

  if (!decryptionKey) return null;

  const blobAAD = buildTeamEntryAAD(teamId, data.id, "blob", itemKeyVersion);
  const blobPlain = await decryptData(
    { ciphertext: data.encryptedBlob, iv: data.blobIv, authTag: data.blobAuthTag },
    decryptionKey,
    blobAAD,
  );

  const overviewAAD = buildTeamEntryAAD(teamId, data.id, "overview", itemKeyVersion);
  const overviewPlain = await decryptData(
    { ciphertext: data.encryptedOverview, iv: data.overviewIv, authTag: data.overviewAuthTag },
    decryptionKey,
    overviewAAD,
  );

  return {
    blob: JSON.parse(blobPlain) as Record<string, unknown>,
    overview: JSON.parse(overviewPlain) as Record<string, unknown>,
    entryType: data.entryType,
  };
}

async function performAutofillForEntry(
  entryId: string,
  tabId: number,
  targetHint?: AutofillTargetHint,
  teamId?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!encryptionKey || !currentUserId) {
    return { ok: false, error: "VAULT_LOCKED" };
  }

  let blobPlain: string;
  let overviewPlain: string;
  let entryType: string;

  if (teamId) {
    // Team entry — use team API + team crypto
    const result = await fetchAndDecryptTeamBlob(teamId, entryId);
    if (!result) return { ok: false, error: "FETCH_FAILED" };
    blobPlain = JSON.stringify(result.blob);
    overviewPlain = JSON.stringify(result.overview);
    entryType = result.entryType;
  } else {
    // Personal entry
    const res = await swFetch(extApiPath.passwordById(entryId));
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      return { ok: false, error: json.error || "FETCH_FAILED" };
    }
    const data = (await res.json()) as {
      encryptedBlob: { ciphertext: string; iv: string; authTag: string };
      encryptedOverview: { ciphertext: string; iv: string; authTag: string };
      aadVersion?: number;
      id: string;
      entryType: string;
    };

    const aad =
      (data.aadVersion ?? 0) >= 1
        ? buildPersonalEntryAAD(currentUserId, data.id)
        : undefined;
    blobPlain = await decryptData(data.encryptedBlob, encryptionKey, aad);
    overviewPlain = await decryptData(
      data.encryptedOverview,
      encryptionKey,
      aad,
    );
    entryType = data.entryType;
  }

  const blob = JSON.parse(blobPlain) as {
    password?: string | null;
    username?: string | null;
    loginId?: string | null;
    userId?: string | null;
    email?: string | null;
    customFields?: Array<{ label?: string; value?: string; type?: string }>;
    totp?: { secret: string; algorithm?: string; digits?: number; period?: number };
    // CREDIT_CARD fields
    cardholderName?: string | null;
    cardNumber?: string | null;
    expiryMonth?: string | null;
    expiryYear?: string | null;
    cvv?: string | null;
    // IDENTITY fields
    fullName?: string | null;
    address?: string | null;
    postalCode?: string | null;
    phone?: string | null;
    dateOfBirth?: string | null;
    nationality?: string | null;
    idNumber?: string | null;
  };
  const overview = JSON.parse(overviewPlain) as { username?: string | null };

  // ── Credit Card autofill path ──
  if (entryType === EXT_ENTRY_TYPE.CREDIT_CARD) {
    const cardNumber = blob.cardNumber ?? "";
    if (!cardNumber) {
      return { ok: false, error: "NO_CARD_NUMBER" };
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["src/content/autofill-cc.js"],
      });
      await chrome.tabs.sendMessage(tabId, {
        type: "AUTOFILL_CC_FILL",
        cardholderName: blob.cardholderName ?? "",
        cardNumber,
        expiryMonth: blob.expiryMonth ?? "",
        expiryYear: blob.expiryYear ?? "",
        cvv: blob.cvv ?? "",
      });
    } catch {
      // CC/Identity do not support direct fallback injection
      return { ok: false, error: "AUTOFILL_INJECT_FAILED" };
    }
    return { ok: true };
  }

  // ── Identity autofill path ──
  if (entryType === EXT_ENTRY_TYPE.IDENTITY) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["src/content/autofill-identity.js"],
      });
      await chrome.tabs.sendMessage(tabId, {
        type: "AUTOFILL_IDENTITY_FILL",
        fullName: blob.fullName ?? "",
        address: blob.address ?? "",
        postalCode: blob.postalCode ?? "",
        phone: blob.phone ?? "",
        email: blob.email ?? "",
        dateOfBirth: blob.dateOfBirth ?? "",
        nationality: blob.nationality ?? "",
        idNumber: blob.idNumber ?? "",
      });
    } catch {
      return { ok: false, error: "AUTOFILL_INJECT_FAILED" };
    }
    return { ok: true };
  }

  // ── LOGIN autofill path (original logic) ──
  const password = blob.password ?? null;
  const username =
    overview.username ??
    blob.username ??
    blob.loginId ??
    blob.userId ??
    blob.email ??
    "";

  const customFields = Array.isArray(blob.customFields) ? blob.customFields : [];

  // Generic text custom fields for autofill by input id/name matching
  const textCustomFields = customFields
    .filter((f) => (!f.type || f.type.toLowerCase() === "text") && f.label && f.value)
    .map(({ label, value }) => ({ label: label!, value: value! }));

  const serializableTargetHint = targetHint
    ? {
        ...(typeof targetHint.id === "string" && targetHint.id
          ? { id: targetHint.id }
          : {}),
        ...(typeof targetHint.name === "string" && targetHint.name
          ? { name: targetHint.name }
          : {}),
        ...(typeof targetHint.type === "string" && targetHint.type
          ? { type: targetHint.type }
          : {}),
        ...(typeof targetHint.autocomplete === "string" &&
        targetHint.autocomplete
          ? { autocomplete: targetHint.autocomplete }
          : {}),
      }
    : null;

  let totpCode: string | undefined;
  if (blob.totp?.secret) {
    try {
      totpCode = generateTOTPCode(blob.totp);
    } catch {
      // TOTP generation failure must not block username/password autofill
    }
  }

  if (!password && !totpCode) {
    return { ok: false, error: "NO_PASSWORD" };
  }

  let messageFillSucceeded = false;
  // autofill-lib.ts is bundled in form-detector.ts (manifest content_scripts),
  // so the AUTOFILL_FILL listener is already present — no executeScript needed.
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "AUTOFILL_FILL",
      username,
      ...(password ? { password } : {}),
      ...(totpCode ? { totpCode } : {}),
      ...(serializableTargetHint ? { targetHint: serializableTargetHint } : {}),
      ...(textCustomFields.length ? { customFields: textCustomFields } : {}),
    });
    messageFillSucceeded = true;
  } catch {
    // Continue to direct fallback injection below.
  }

  // Direct fallback for pages where content-script messaging is blocked/unstable.
  // Runs in all frames so login forms inside iframes are also covered.
  const injectDirectAutofill = async (
    hintArg: { id?: string; name?: string; type?: string; autocomplete?: string } | null,
  ) =>
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: [
        username,
        password ?? "",
        hintArg,
        textCustomFields,
      ],
      func: (
        usernameArg: string,
        passwordArg: string,
        targetHintArg?: {
          id?: string;
          name?: string;
          type?: string;
          autocomplete?: string;
        } | null,
        customFieldsArg?: Array<{ label: string; value: string }>,
      ) => {
      const isUsableInput = (input: HTMLInputElement) =>
        !input.disabled && !input.readOnly;
      const isVisible = (input: HTMLInputElement) =>
        getComputedStyle(input).display !== "none" &&
        getComputedStyle(input).visibility !== "hidden";

      const setInputValue = (input: HTMLInputElement, value: string) => {
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        if (setter) setter.call(input, value);
        else input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
        input.dispatchEvent(new Event("blur", { bubbles: true }));
      };

      const inputs = Array.from(
        document.querySelectorAll("input"),
      ) as HTMLInputElement[];

      const findInputByHint = () => {
        if (!targetHintArg) return null;
        return (
          inputs.find((i) => !!targetHintArg.id && i.id === targetHintArg.id) ??
          inputs.find((i) => !!targetHintArg.name && i.name === targetHintArg.name) ??
          inputs.find(
            (i) =>
              !!targetHintArg.autocomplete &&
              i.autocomplete === targetHintArg.autocomplete &&
              (!targetHintArg.type || i.type === targetHintArg.type),
          ) ??
          null
        );
      };

      const active = document.activeElement;
      const hintedInput = findInputByHint();
      const usernameInput: HTMLInputElement | null =
        hintedInput instanceof HTMLInputElement &&
        isUsableInput(hintedInput) &&
        ["text", "email", "tel"].includes(hintedInput.type)
          ? hintedInput
          : active instanceof HTMLInputElement &&
              isUsableInput(active) &&
              ["text", "email", "tel"].includes(active.type)
            ? active
            : null;

      const findPasswordInScope = (scopeInputs: HTMLInputElement[]) => {
        const byAutocomplete = scopeInputs.find(
          (i) =>
            isUsableInput(i) &&
            i.type === "password" &&
            isVisible(i) &&
            i.autocomplete === "current-password",
        );
        if (byAutocomplete) return byAutocomplete;
        const pwInputs = scopeInputs.filter(
          (i) => isUsableInput(i) && i.type === "password" && isVisible(i),
        );
        return pwInputs.length ? pwInputs[pwInputs.length - 1] : null;
      };

      const scopeForm = (usernameInput ?? hintedInput)?.form ?? null;
      const scopedInputs = scopeForm
        ? (Array.from(scopeForm.querySelectorAll("input")) as HTMLInputElement[])
        : inputs;
      const passwordInput =
        findPasswordInScope(scopedInputs) ?? findPasswordInScope(inputs);

      let fallbackUsername = usernameInput;
      if (!fallbackUsername && passwordInput) {
        const pwIndex = inputs.indexOf(passwordInput);
        for (let i = pwIndex - 1; i >= 0; i -= 1) {
          const c = inputs[i];
          if (
            isUsableInput(c) &&
            ["text", "email", "tel"].includes(c.type)
          ) {
            fallbackUsername = c;
            break;
          }
        }
      }

      // Fill custom fields by matching label to input id/name
      const cfTargets = new Set<HTMLInputElement>();
      if (customFieldsArg) {
        for (const { label, value } of customFieldsArg) {
          const lower = label.toLowerCase();
          const target = inputs.find(
            (i) => isUsableInput(i) && (i.id.toLowerCase() === lower || i.name.toLowerCase() === lower),
          );
          if (target) {
            cfTargets.add(target);
            setInputValue(target, value);
          }
        }
      }

      // Skip username fill if target is reserved for a custom field
      if (fallbackUsername && usernameArg && !cfTargets.has(fallbackUsername)) {
        setInputValue(fallbackUsername, usernameArg);
      }
      if (passwordInput && passwordArg) setInputValue(passwordInput, passwordArg);
      },
    });

  // Only run direct fallback when message-based autofill failed.
  // The direct fallback doesn't support TOTP and would overwrite OTP fields
  // with username values, so running both approaches causes conflicts.
  if (!messageFillSucceeded) {
    try {
      await injectDirectAutofill(serializableTargetHint);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/unserializable/i.test(message)) throw err;
      await injectDirectAutofill(null);
    }
  }

  // Auto-copy TOTP to clipboard after successful LOGIN autofill
  if (totpCode && entryType === EXT_ENTRY_TYPE.LOGIN) {
    const { autoCopyTotp, clipboardClearSeconds } = validateSettings(await getSettings());
    if (autoCopyTotp) {
      const clipMs = clipboardClearSeconds * 1000;
      await chrome.alarms.clear(ALARM_CLEAR_CLIPBOARD).catch(() => {});
      await copyToClipboard(totpCode);
      lastClipboardCopyTime = Date.now();
      setTimeout(async () => {
        try {
          if (Date.now() - lastClipboardCopyTime >= clipMs) {
            await copyToClipboard("");
          }
        } catch {
          // ignore
        }
      }, clipMs);
      chrome.alarms.create(ALARM_CLEAR_CLIPBOARD, {
        delayInMinutes: Math.max((clipboardClearSeconds * 2) / 60, 1),
      });
    }
  }

  return { ok: true };
}

// ── Message handler ──────────────────────────────────────────

async function handleMessage(
  message: ExtensionMessage,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: ExtensionResponse) => void,
): Promise<void> {
  // Wait for session hydration to complete before processing any message.
  // This prevents race conditions where the SW restarts and messages arrive
  // before in-memory state (token, encryptionKey) is restored.
  await hydrationPromise;

  switch (message.type) {
    case "SET_TOKEN": {
      const tokenChanged = currentToken !== null && currentToken !== message.token;
      if (tokenChanged) {
        // A new token may represent a different auth session/user.
        // Force vault relock to avoid carrying unlocked state across token rotation.
        clearVault();
      }

      currentToken = message.token;
      tokenExpiresAt = message.expiresAt;

      // Set alarm for TTL expiry
      const delayMs = message.expiresAt - Date.now();
      if (delayMs > 0) {
        chrome.alarms.create(ALARM_TOKEN_TTL, {
          when: message.expiresAt,
        });
        scheduleRefreshAlarm(message.expiresAt);
        persistState();
      } else {
        // Already expired
        clearToken();
      }

      sendResponse({ type: "SET_TOKEN", ok: true });
      void updateBadge();
      return;
    }

    case "GET_TOKEN": {
      if (tokenExpiresAt && Date.now() >= tokenExpiresAt) {
        clearToken();
      }
      sendResponse({ type: "GET_TOKEN", token: currentToken });
      return;
    }

    case "CLEAR_TOKEN": {
      await revokeCurrentTokenOnServer();
      clearToken();
      chrome.alarms.clear(ALARM_TOKEN_TTL);
      sendResponse({ type: "CLEAR_TOKEN", ok: true });
      return;
    }

    case "KEEPALIVE_PING":
      // No-op — receiving the message keeps the SW alive
      return;

    case "GET_STATUS": {
      if (tokenExpiresAt && Date.now() >= tokenExpiresAt) {
        clearToken();
      }
      sendResponse({
        type: "GET_STATUS",
        hasToken: currentToken !== null,
        expiresAt: tokenExpiresAt,
        vaultUnlocked: encryptionKey !== null,
      });
      return;
    }

    case "UNLOCK_VAULT": {
      if (!currentToken) {
        sendResponse({
          type: "UNLOCK_VAULT",
          ok: false,
          error: "NO_TOKEN",
        });
        return;
      }

      try {
        const res = await swFetch(EXT_API_PATH.VAULT_UNLOCK_DATA);
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          sendResponse({
            type: "UNLOCK_VAULT",
            ok: false,
            error: json.error || "UNLOCK_FAILED",
          });
          return;
        }

        const data = await res.json();
        const wrappingKey = await deriveWrappingKey(
          message.passphrase,
          hexDecode(data.accountSalt)
        );

        let secretKey: Uint8Array;
        try {
          secretKey = await unwrapSecretKey(
            {
              ciphertext: data.encryptedSecretKey,
              iv: data.secretKeyIv,
              authTag: data.secretKeyAuthTag,
            },
            wrappingKey
          );
        } catch {
          sendResponse({
            type: "UNLOCK_VAULT",
            ok: false,
            error: "INVALID_PASSPHRASE",
          });
          return;
        }

        const encKey = await deriveEncryptionKey(secretKey);
        currentVaultSecretKeyHex = Array.from(secretKey)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        secretKey.fill(0);

        if (data.verificationArtifact) {
          const ok = await verifyKey(encKey, data.verificationArtifact);
          if (!ok) {
            sendResponse({
              type: "UNLOCK_VAULT",
              ok: false,
              error: "INVALID_PASSPHRASE",
            });
            return;
          }
        }

        encryptionKey = encKey;
        currentUserId = data.userId || null;
        // Store tenant policy auto-lock override from server
        tenantAutoLockMinutes = typeof data.vaultAutoLockMinutes === "number"
          ? data.vaultAutoLockMinutes
          : null;

        // Unwrap ECDH private key for team key derivation (if available)
        if (data.encryptedEcdhPrivateKey && data.ecdhPrivateKeyIv && data.ecdhPrivateKeyAuthTag) {
          try {
            const secretKeyForEcdh = hexDecode(currentVaultSecretKeyHex!);
            const ecdhWrappingKey = await deriveEcdhWrappingKey(secretKeyForEcdh);
            secretKeyForEcdh.fill(0);
            const ecdhEnc = {
              ciphertext: data.encryptedEcdhPrivateKey,
              iv: data.ecdhPrivateKeyIv,
              authTag: data.ecdhPrivateKeyAuthTag,
            };
            ecdhPrivateKeyBytes = await unwrapEcdhPrivateKey(ecdhEnc, ecdhWrappingKey);
            ecdhEncryptedData = ecdhEnc;
          } catch {
            // ECDH key not available — team features silently unavailable
            ecdhPrivateKeyBytes = null;
            ecdhEncryptedData = null;
          }
        }

        persistState();
        const effectiveLock = await getEffectiveAutoLockMinutes();
        if (effectiveLock > 0) {
          chrome.alarms.create(ALARM_VAULT_LOCK, {
            delayInMinutes: effectiveLock,
          });
        }
        void startKeepalive();

        sendResponse({ type: "UNLOCK_VAULT", ok: true });
        invalidateContextMenu();
        void updateBadge();
      } catch (err) {
        sendResponse({
          type: "UNLOCK_VAULT",
          ok: false,
          error: normalizeErrorCode(err, "UNLOCK_FAILED"),
        });
      }
      return;
    }

    case "LOCK_VAULT": {
      clearVault();
      sendResponse({ type: "LOCK_VAULT", ok: true });
      return;
    }

    case "FETCH_PASSWORDS": {
      if (!encryptionKey || !currentUserId) {
        sendResponse({
          type: "FETCH_PASSWORDS",
          entries: null,
          error: "VAULT_LOCKED",
        });
        return;
      }

      try {
        // Fetch personal and team entries in parallel
        const [personalResult, teamResult] = await Promise.allSettled([
          (async () => {
            const res = await swFetch(EXT_API_PATH.PASSWORDS);
            if (!res.ok) return [];
            const raw = (await res.json()) as RawEntry[];
            return decryptOverviews(raw);
          })(),
          fetchAllTeamEntries(),
        ]);

        const personal = personalResult.status === "fulfilled" ? personalResult.value : [];
        const team = teamResult.status === "fulfilled" ? teamResult.value : [];
        const entries = [...personal, ...team];

        // Update cache so inline suggestions stay in sync with popup.
        cachedEntries = entries;
        cacheTimestamp = Date.now();
        sendResponse({ type: "FETCH_PASSWORDS", entries });
        // Update badge count now that cache is populated
        void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
          if (tab?.id) void updateBadgeForTab(tab.id, tab.url);
        }).catch(() => {});
      } catch (err) {
        sendResponse({
          type: "FETCH_PASSWORDS",
          entries: null,
          error: normalizeErrorCode(err, "FETCH_FAILED"),
        });
      }
      return;
    }

    case "COPY_PASSWORD": {
      if (!encryptionKey || !currentUserId) {
        sendResponse({
          type: "COPY_PASSWORD",
          password: null,
          error: "VAULT_LOCKED",
        });
        return;
      }

      try {
        let password: string | null = null;

        if (message.teamId) {
          // Team entry
          const result = await fetchAndDecryptTeamBlob(message.teamId, message.entryId);
          if (!result) {
            sendResponse({ type: "COPY_PASSWORD", password: null, error: "FETCH_FAILED" });
            return;
          }
          password = (result.blob.password as string) ?? null;
        } else {
          // Personal entry
          const res = await swFetch(extApiPath.passwordById(message.entryId));
          if (!res.ok) {
            const json = await res.json().catch(() => ({}));
            sendResponse({
              type: "COPY_PASSWORD",
              password: null,
              error: json.error || "FETCH_FAILED",
            });
            return;
          }

          const data = (await res.json()) as {
            encryptedBlob: { ciphertext: string; iv: string; authTag: string };
            aadVersion?: number;
            id: string;
          };

          const aad =
            (data.aadVersion ?? 0) >= 1
              ? buildPersonalEntryAAD(currentUserId, data.id)
              : undefined;
          const plaintext = await decryptData(
            data.encryptedBlob,
            encryptionKey,
            aad
          );
          try {
            const blob = JSON.parse(plaintext) as { password?: string | null };
            password = blob.password ?? null;
          } catch {
            password = null;
          }
        }

        if (!password) {
          sendResponse({
            type: "COPY_PASSWORD",
            password: null,
            error: "NO_PASSWORD",
          });
          return;
        }

        sendResponse({ type: "COPY_PASSWORD", password });
      } catch (err) {
        sendResponse({
          type: "COPY_PASSWORD",
          password: null,
          error: normalizeErrorCode(err, "FETCH_FAILED"),
        });
      }
      return;
    }

    case "COPY_TOTP": {
      if (!encryptionKey || !currentUserId) {
        sendResponse({
          type: "COPY_TOTP",
          code: null,
          error: "VAULT_LOCKED",
        });
        return;
      }

      try {
        let totp: { secret: string; algorithm?: string; digits?: number; period?: number } | null = null;

        if (message.teamId) {
          // Team entry
          const result = await fetchAndDecryptTeamBlob(message.teamId, message.entryId);
          if (!result) {
            sendResponse({ type: "COPY_TOTP", code: null, error: "FETCH_FAILED" });
            return;
          }
          const blobTotp = result.blob.totp as { secret: string; algorithm?: string; digits?: number; period?: number } | undefined;
          totp = blobTotp ?? null;
        } else {
          // Personal entry
          const res = await swFetch(extApiPath.passwordById(message.entryId));
          if (!res.ok) {
            const json = await res.json().catch(() => ({}));
            sendResponse({
              type: "COPY_TOTP",
              code: null,
              error: json.error || "FETCH_FAILED",
            });
            return;
          }

          const data = (await res.json()) as {
            encryptedBlob: { ciphertext: string; iv: string; authTag: string };
            aadVersion?: number;
            id: string;
          };

          const aad =
            (data.aadVersion ?? 0) >= 1
              ? buildPersonalEntryAAD(currentUserId, data.id)
              : undefined;
          const plaintext = await decryptData(
            data.encryptedBlob,
            encryptionKey,
            aad,
          );
          try {
            const blob = JSON.parse(plaintext) as {
              totp?: { secret: string; algorithm?: string; digits?: number; period?: number };
            };
            totp = blob.totp ?? null;
          } catch {
            totp = null;
          }
        }

        if (!totp?.secret) {
          sendResponse({
            type: "COPY_TOTP",
            code: null,
            error: "NO_TOTP",
          });
          return;
        }

        let code: string;
        try {
          code = generateTOTPCode(totp);
        } catch {
          sendResponse({
            type: "COPY_TOTP",
            code: null,
            error: "INVALID_TOTP",
          });
          return;
        }
        sendResponse({ type: "COPY_TOTP", code });
      } catch {
        sendResponse({
          type: "COPY_TOTP",
          code: null,
          error: "FETCH_FAILED",
        });
      }
      return;
    }

    case "AUTOFILL": {
      try {
        const result = await performAutofillForEntry(
          message.entryId,
          message.tabId,
          undefined,
          message.teamId,
        );
        sendResponse({
          type: "AUTOFILL",
          ok: result.ok,
          error: result.error,
        });
      } catch (err) {
        sendResponse({
          type: "AUTOFILL",
          ok: false,
          error: normalizeErrorCode(err, "AUTOFILL_FAILED"),
        });
      }
      return;
    }

    case "AUTOFILL_CREDIT_CARD": {
      try {
        const result = await performAutofillForEntry(
          message.entryId,
          message.tabId,
          undefined,
          message.teamId,
        );
        sendResponse({
          type: "AUTOFILL_CREDIT_CARD",
          ok: result.ok,
          error: result.error,
        });
      } catch (err) {
        sendResponse({
          type: "AUTOFILL_CREDIT_CARD",
          ok: false,
          error: normalizeErrorCode(err, "AUTOFILL_FAILED"),
        });
      }
      return;
    }

    case "AUTOFILL_IDENTITY": {
      try {
        const result = await performAutofillForEntry(
          message.entryId,
          message.tabId,
          undefined,
          message.teamId,
        );
        sendResponse({
          type: "AUTOFILL_IDENTITY",
          ok: result.ok,
          error: result.error,
        });
      } catch (err) {
        sendResponse({
          type: "AUTOFILL_IDENTITY",
          ok: false,
          error: normalizeErrorCode(err, "AUTOFILL_FAILED"),
        });
      }
      return;
    }

    case "GET_MATCHES_FOR_URL": {
      const { enableInlineSuggestions } = validateSettings(await getSettings());
      if (!enableInlineSuggestions) {
        sendResponse({
          type: "GET_MATCHES_FOR_URL",
          entries: [],
          vaultLocked: false,
          suppressInline: true,
        });
        return;
      }
      const effectiveUrl = message.topUrl ?? message.url;
      if (await isOwnAppPage(effectiveUrl)) {
        sendResponse({
          type: "GET_MATCHES_FOR_URL",
          entries: [],
          vaultLocked: false,
          suppressInline: true,
        });
        return;
      }
      if (!currentToken) {
        sendResponse({
          type: "GET_MATCHES_FOR_URL",
          entries: [],
          vaultLocked: false,
          disconnected: true,
          suppressInline: false,
        });
        return;
      }
      if (!encryptionKey || !currentUserId) {
        sendResponse({
          type: "GET_MATCHES_FOR_URL",
          entries: [],
          vaultLocked: true,
          suppressInline: false,
        });
        return;
      }

      try {
        const tabHost = extractHost(effectiveUrl);
        if (!tabHost) {
          sendResponse({
            type: "GET_MATCHES_FOR_URL",
            entries: [],
            vaultLocked: false,
            suppressInline: false,
          });
          return;
        }
        const entries = await getCachedEntries();
        const matches = entries.filter((e) => {
          if (e.entryType !== EXT_ENTRY_TYPE.LOGIN) return false;
          if (e.urlHost && isHostMatch(e.urlHost, tabHost)) return true;
          return (e.additionalUrlHosts ?? []).some((h) => isHostMatch(h, tabHost));
        });
        sendResponse({
          type: "GET_MATCHES_FOR_URL",
          entries: matches,
          vaultLocked: false,
          suppressInline: false,
        });
        // Cache was just populated — update badge for sender tab
        if (_sender.tab?.id) {
          void updateBadgeForTab(_sender.tab.id, effectiveUrl);
        }
      } catch {
        sendResponse({
          type: "GET_MATCHES_FOR_URL",
          entries: [],
          vaultLocked: false,
          suppressInline: false,
        });
      }
      return;
    }

    case "AUTOFILL_FROM_CONTENT": {
      if (!encryptionKey || !currentUserId) {
        sendResponse({
          type: "AUTOFILL_FROM_CONTENT",
          ok: false,
          error: "VAULT_LOCKED",
        });
        return;
      }

      try {
        const tabId = _sender.tab?.id;
        if (!tabId) {
          sendResponse({
            type: "AUTOFILL_FROM_CONTENT",
            ok: false,
            error: "NO_TAB",
          });
          return;
        }
        const result = await performAutofillForEntry(
          message.entryId,
          tabId,
          message.targetHint,
          message.teamId,
        );
        sendResponse({
          type: "AUTOFILL_FROM_CONTENT",
          ok: result.ok,
          error: result.error,
        });
      } catch (err) {
        sendResponse({
          type: "AUTOFILL_FROM_CONTENT",
          ok: false,
          error: normalizeErrorCode(err, "AUTOFILL_FAILED"),
        });
      }
      return;
    }

    case "LOGIN_DETECTED": {
      try {
        // Use sender's tab URL for security — don't trust message.url
        const senderUrl = _sender.tab?.url;
        if (!senderUrl) {
          sendResponse({ type: "LOGIN_DETECTED", action: "none" });
          return;
        }
        // Never offer to save credentials entered on our own app
        if (await isOwnAppPage(senderUrl)) {
          sendResponse({ type: "LOGIN_DETECTED", action: "none" });
          return;
        }
        const result = await handleLoginDetected(
          senderUrl,
          message.username,
          message.password,
        );

        // Check prompt preferences at detection time
        if (result.action !== "none") {
          const promptSettings = validateSettings(await getSettings());
          if (result.action === "save" && !promptSettings.showSavePrompt) {
            sendResponse({ type: "LOGIN_DETECTED", action: "none" });
            return;
          }
          if (result.action === "update" && !promptSettings.showUpdatePrompt) {
            sendResponse({ type: "LOGIN_DETECTED", action: "none" });
            return;
          }
        }

        // Store pending save for this tab. After form submit the page
        // typically navigates, so the sendResponse callback on the content
        // script side may never fire. The tabs.onUpdated handler will push
        // the save banner to the new page.
        const senderTabId = _sender.tab?.id;
        if (senderTabId && result.action !== "none") {
          let host: string;
          try {
            host = new URL(senderUrl).hostname;
          } catch {
            host = senderUrl;
          }
          // Evict oldest entry if at capacity
          if (pendingSavePrompts.size >= MAX_PENDING_SAVES && !pendingSavePrompts.has(senderTabId)) {
            const oldestKey = pendingSavePrompts.keys().next().value;
            if (oldestKey !== undefined) pendingSavePrompts.delete(oldestKey);
          }
          pendingSavePrompts.set(senderTabId, {
            host,
            username: message.username,
            password: message.password,
            action: result.action,
            existingEntryId: result.existingEntryId,
            existingTitle: result.existingTitle,
            timestamp: Date.now(),
          });
        }

        sendResponse({
          type: "LOGIN_DETECTED",
          action: result.action,
          existingEntryId: result.existingEntryId,
          existingTitle: result.existingTitle,
        });
      } catch {
        sendResponse({ type: "LOGIN_DETECTED", action: "none" });
      }
      return;
    }

    case "SAVE_LOGIN": {
      // Clear pending save — user acted on the banner (page didn't navigate)
      if (_sender.tab?.id) pendingSavePrompts.delete(_sender.tab.id);
      try {
        // Use sender's tab URL for security — don't trust message.url
        const senderUrl = _sender.tab?.url;
        if (!senderUrl) {
          sendResponse({ type: "SAVE_LOGIN", ok: false, error: "NO_TAB" });
          return;
        }
        // Defense-in-depth: refuse to save credentials from our own app
        if (await isOwnAppPage(senderUrl)) {
          sendResponse({ type: "SAVE_LOGIN", ok: false, error: "OWN_APP" });
          return;
        }
        // Derive title from trusted sender URL instead of message.title
        // to prevent content-script spoofing.
        const title = (() => {
          try { return new URL(senderUrl).hostname; } catch { return senderUrl; }
        })();
        const result = await handleSaveLogin(
          senderUrl,
          title,
          message.username,
          message.password,
        );
        sendResponse({ type: "SAVE_LOGIN", ok: result.ok, error: result.error });
      } catch {
        sendResponse({ type: "SAVE_LOGIN", ok: false, error: "SAVE_FAILED" });
      }
      return;
    }

    case "UPDATE_LOGIN": {
      if (_sender.tab?.id) pendingSavePrompts.delete(_sender.tab.id);
      try {
        const senderUrl = _sender.tab?.url;
        if (!senderUrl) {
          sendResponse({ type: "UPDATE_LOGIN", ok: false, error: "NO_TAB" });
          return;
        }
        // Defense-in-depth: refuse to update credentials from our own app
        if (await isOwnAppPage(senderUrl)) {
          sendResponse({ type: "UPDATE_LOGIN", ok: false, error: "OWN_APP" });
          return;
        }
        const result = await handleUpdateLogin(
          message.entryId,
          message.password,
        );
        sendResponse({ type: "UPDATE_LOGIN", ok: result.ok, error: result.error });
      } catch {
        sendResponse({ type: "UPDATE_LOGIN", ok: false, error: "UPDATE_FAILED" });
      }
      return;
    }

    case "DISMISS_SAVE_PROMPT": {
      if (_sender.tab?.id) pendingSavePrompts.delete(_sender.tab.id);
      sendResponse({ type: "DISMISS_SAVE_PROMPT", ok: true });
      return;
    }

    case "CHECK_PENDING_SAVE": {
      const tabId = _sender.tab?.id;
      if (!tabId) {
        sendResponse({ type: "CHECK_PENDING_SAVE", action: "none" });
        return;
      }
      const pending = pendingSavePrompts.get(tabId);
      if (pending && Date.now() - pending.timestamp < PENDING_SAVE_TTL_MS) {
        // Security: verify the requesting page is on the same host as the
        // original login, mirroring the push-path check in tabs.onUpdated.
        const senderHost = _sender.tab?.url ? extractHost(_sender.tab.url) : null;
        if (!senderHost || !isHostMatch(pending.host, senderHost)) {
          pendingSavePrompts.delete(tabId);
          sendResponse({ type: "CHECK_PENDING_SAVE", action: "none" });
          return;
        }
        pendingSavePrompts.delete(tabId);
        sendResponse({
          type: "CHECK_PENDING_SAVE",
          action: pending.action,
          host: pending.host,
          username: pending.username,
          password: pending.password,
          existingEntryId: pending.existingEntryId,
          existingTitle: pending.existingTitle,
        });
      } else {
        if (pending) pendingSavePrompts.delete(tabId);
        sendResponse({ type: "CHECK_PENDING_SAVE", action: "none" });
      }
      return;
    }
  }
}

chrome.runtime.onMessage.addListener(
  (
    message: ExtensionMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: ExtensionResponse) => void,
  ) => {
    handleMessage(message, _sender, sendResponse).catch(() => {
      // Failsafe: ensure sendResponse is called even on unexpected errors
      // to prevent the caller (popup/content script) from hanging.
      // Each branch returns the correct response shape for the message type.
      try {
        switch (message.type) {
          case "GET_STATUS":
            sendResponse({ type: "GET_STATUS", hasToken: false, expiresAt: null, vaultUnlocked: false } as ExtensionResponse);
            break;
          case "GET_TOKEN":
            sendResponse({ type: "GET_TOKEN", token: null } as ExtensionResponse);
            break;
          case "GET_MATCHES_FOR_URL":
            sendResponse({ type: "GET_MATCHES_FOR_URL", entries: [], vaultLocked: !!currentToken && !encryptionKey, disconnected: !currentToken, suppressInline: false } as ExtensionResponse);
            break;
          case "FETCH_PASSWORDS":
            sendResponse({ type: "FETCH_PASSWORDS", entries: null, error: "INTERNAL_ERROR" } as ExtensionResponse);
            break;
          case "COPY_PASSWORD":
            sendResponse({ type: "COPY_PASSWORD", password: null, error: "INTERNAL_ERROR" } as ExtensionResponse);
            break;
          case "COPY_TOTP":
            sendResponse({ type: "COPY_TOTP", code: null, error: "INTERNAL_ERROR" } as ExtensionResponse);
            break;
          case "LOGIN_DETECTED":
            sendResponse({ type: "LOGIN_DETECTED", action: "none" } as ExtensionResponse);
            break;
          case "SAVE_LOGIN":
            sendResponse({ type: "SAVE_LOGIN", ok: false, error: "INTERNAL_ERROR" } as ExtensionResponse);
            break;
          case "UPDATE_LOGIN":
            sendResponse({ type: "UPDATE_LOGIN", ok: false, error: "INTERNAL_ERROR" } as ExtensionResponse);
            break;
          case "CHECK_PENDING_SAVE":
            sendResponse({ type: "CHECK_PENDING_SAVE", action: "none" } as ExtensionResponse);
            break;
          case "AUTOFILL_CREDIT_CARD":
            sendResponse({ type: "AUTOFILL_CREDIT_CARD", ok: false, error: "INTERNAL_ERROR" } as ExtensionResponse);
            break;
          case "AUTOFILL_IDENTITY":
            sendResponse({ type: "AUTOFILL_IDENTITY", ok: false, error: "INTERNAL_ERROR" } as ExtensionResponse);
            break;
          default:
            sendResponse({ type: message.type, ok: false, error: "INTERNAL_ERROR" } as ExtensionResponse);
        }
      } catch {
        // sendResponse may already have been called or the port may be closed
      }
    });
    return true;
  },
);
