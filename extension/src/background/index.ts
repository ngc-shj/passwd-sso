import type {
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
} from "../lib/crypto";
import { getSettings } from "../lib/storage";
import { extractHost, isHostMatch } from "../lib/url-matching";

// ── In-memory token storage (never persisted to disk) ────────

let currentToken: string | null = null;
let tokenExpiresAt: number | null = null;
let encryptionKey: CryptoKey | null = null;
let currentUserId: string | null = null;

const ALARM_NAME = "extension-token-ttl";
const VAULT_ALARM = "vault-auto-lock";
const TOKEN_BRIDGE_SCRIPT_ID = "token-bridge";
const CACHE_TTL_MS = 60_000; // 1 minute

// ── Entry cache (TTL-based) ─────────────────────────────────

let cachedEntries: DecryptedEntry[] | null = null;
let cacheTimestamp = 0;

function invalidateCache(): void {
  cachedEntries = null;
  cacheTimestamp = 0;
}

async function getCachedEntries(): Promise<DecryptedEntry[]> {
  if (cachedEntries && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedEntries;
  }
  const res = await swFetch("/api/passwords");
  if (!res.ok) return [];
  const raw = (await res.json()) as RawEntry[];
  const entries = await decryptOverviews(raw);
  cachedEntries = entries;
  cacheTimestamp = Date.now();
  return entries;
}

/** Securely clear token from memory */
function clearToken(): void {
  currentToken = null;
  tokenExpiresAt = null;
  clearVault();
  void updateBadge();
}

function clearVault(): void {
  encryptionKey = null;
  currentUserId = null;
  invalidateCache();
  chrome.alarms.clear(VAULT_ALARM);
  void updateBadge();
}

async function updateBadge(): Promise<void> {
  if (!currentToken) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  if (!encryptionKey) {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#F59E0B" });
    return;
  }
  await chrome.action.setBadgeText({ text: "" });
}

// ── Alarm: auto-clear on expiry ──────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    clearToken();
  }
  if (alarm.name === VAULT_ALARM) {
    clearVault();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.serverUrl?.newValue) {
    registerTokenBridgeScript(String(changes.serverUrl.newValue)).catch(() => {});
  }
  if (!changes.autoLockMinutes) return;
  if (!encryptionKey) return;

  const newValue = changes.autoLockMinutes.newValue;
  if (typeof newValue !== "number" || !Number.isFinite(newValue)) return;

  chrome.alarms.clear(VAULT_ALARM);
  if (newValue > 0) {
    chrome.alarms.create(VAULT_ALARM, { delayInMinutes: newValue });
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
      runAt: "document_idle",
    },
  ]);
}

getSettings()
  .then(({ serverUrl }) => registerTokenBridgeScript(serverUrl))
  .catch(() => {});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "trigger-autofill") return;
  if (!currentToken || !encryptionKey || !currentUserId) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return;
  const tabHost = extractHost(tab.url);
  if (!tabHost) return;

  const entries = await getCachedEntries();
  const match = entries.find(
    (e) => e.entryType === "LOGIN" && e.urlHost && isHostMatch(e.urlHost, tabHost)
  );
  if (!match) return;
  await performAutofillForEntry(match.id, tab.id);
});

async function swFetch(path: string): Promise<Response> {
  if (!currentToken) {
    throw new Error("NO_TOKEN");
  }
  const { serverUrl } = await chrome.storage.local.get({
    serverUrl: "https://localhost:3000",
  });
  let origin: string;
  try {
    origin = new URL(serverUrl).origin;
  } catch {
    throw new Error("INVALID_SERVER_URL");
  }
  const allowed = await chrome.permissions.contains({
    origins: [`${origin}/*`],
  });
  if (!allowed) {
    throw new Error("PERMISSION_DENIED");
  }

  return fetch(`${origin}${path}`, {
    headers: { Authorization: `Bearer ${currentToken}` },
  });
}

type RawEntry = {
  id: string;
  encryptedOverview: { ciphertext: string; iv: string; authTag: string };
  entryType: string;
  aadVersion?: number;
  urlHost?: string;
};

async function decryptOverviews(raw: RawEntry[]): Promise<DecryptedEntry[]> {
  if (!encryptionKey || !currentUserId) return [];
  const entries: DecryptedEntry[] = [];
  for (const item of raw) {
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
        cardholderName?: string;
        fullName?: string;
      };
      entries.push({
        id: item.id,
        title: overview.title ?? "",
        username:
          overview.username ??
          overview.cardholderName ??
          overview.fullName ??
          "",
        urlHost: overview.urlHost ?? "",
        entryType: item.entryType,
      });
    } catch {
      // Skip entries that fail to decrypt/parse
    }
  }
  return entries;
}

async function performAutofillForEntry(
  entryId: string,
  tabId: number,
): Promise<{ ok: boolean; error?: string }> {
  if (!encryptionKey || !currentUserId) {
    return { ok: false, error: "VAULT_LOCKED" };
  }
  const res = await swFetch(`/api/passwords/${entryId}`);
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    return { ok: false, error: json.error || "FETCH_FAILED" };
  }
  const data = (await res.json()) as {
    encryptedBlob: { ciphertext: string; iv: string; authTag: string };
    encryptedOverview: { ciphertext: string; iv: string; authTag: string };
    aadVersion?: number;
    id: string;
  };

  const aad =
    (data.aadVersion ?? 0) >= 1
      ? buildPersonalEntryAAD(currentUserId, data.id)
      : undefined;
  const blobPlain = await decryptData(data.encryptedBlob, encryptionKey, aad);
  const overviewPlain = await decryptData(
    data.encryptedOverview,
    encryptionKey,
    aad,
  );

  const blob = JSON.parse(blobPlain) as { password?: string | null };
  const overview = JSON.parse(overviewPlain) as { username?: string | null };
  const password = blob.password ?? null;
  const username = overview.username ?? "";

  if (!password) {
    return { ok: false, error: "NO_PASSWORD" };
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/content/autofill.js"],
  });
  await chrome.tabs.sendMessage(tabId, {
    type: "AUTOFILL_FILL",
    username,
    password,
  });
  return { ok: true };
}

// ── Message handler ──────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    message: ExtensionMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: ExtensionResponse) => void,
  ) => {
    switch (message.type) {
      case "SET_TOKEN": {
        currentToken = message.token;
        tokenExpiresAt = message.expiresAt;

        // Set alarm for TTL expiry
        const delayMs = message.expiresAt - Date.now();
        if (delayMs > 0) {
          chrome.alarms.create(ALARM_NAME, {
            when: message.expiresAt,
          });
        } else {
          // Already expired
          clearToken();
        }

        sendResponse({ type: "SET_TOKEN", ok: true });
        void updateBadge();
        break;
      }

      case "GET_TOKEN": {
        // Check if expired
        if (tokenExpiresAt && Date.now() >= tokenExpiresAt) {
          clearToken();
        }
        sendResponse({ type: "GET_TOKEN", token: currentToken });
        break;
      }

      case "CLEAR_TOKEN": {
        clearToken();
        chrome.alarms.clear(ALARM_NAME);
        sendResponse({ type: "CLEAR_TOKEN", ok: true });
        break;
      }

      case "GET_STATUS": {
        // Check if expired
        if (tokenExpiresAt && Date.now() >= tokenExpiresAt) {
          clearToken();
        }
        sendResponse({
          type: "GET_STATUS",
          hasToken: currentToken !== null,
          expiresAt: tokenExpiresAt,
          vaultUnlocked: encryptionKey !== null,
        });
        break;
      }

      case "UNLOCK_VAULT": {
        if (!currentToken) {
          sendResponse({
            type: "UNLOCK_VAULT",
            ok: false,
            error: "NO_TOKEN",
          });
          break;
        }

        (async () => {
          try {
            const res = await swFetch("/api/vault/unlock/data");
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
            const { autoLockMinutes } = await getSettings();
            if (autoLockMinutes > 0) {
              chrome.alarms.create(VAULT_ALARM, {
                delayInMinutes: autoLockMinutes,
              });
            }

            sendResponse({ type: "UNLOCK_VAULT", ok: true });
            void updateBadge();
          } catch (err) {
            sendResponse({
              type: "UNLOCK_VAULT",
              ok: false,
              error: err instanceof Error ? err.message : "UNLOCK_FAILED",
            });
          }
        })();

        return true;
      }

      case "LOCK_VAULT": {
        clearVault();
        sendResponse({ type: "LOCK_VAULT", ok: true });
        break;
      }

      case "FETCH_PASSWORDS": {
        if (!encryptionKey || !currentUserId) {
          sendResponse({
            type: "FETCH_PASSWORDS",
            entries: null,
            error: "VAULT_LOCKED",
          });
          break;
        }

        (async () => {
          try {
            const res = await swFetch("/api/passwords");
            if (!res.ok) {
              const json = await res.json().catch(() => ({}));
              sendResponse({
                type: "FETCH_PASSWORDS",
                entries: null,
                error: json.error || "FETCH_FAILED",
              });
              return;
            }

            const raw = (await res.json()) as RawEntry[];
            const entries = await decryptOverviews(raw);
            sendResponse({ type: "FETCH_PASSWORDS", entries });
          } catch (err) {
            sendResponse({
              type: "FETCH_PASSWORDS",
              entries: null,
              error: err instanceof Error ? err.message : "FETCH_FAILED",
            });
          }
        })();

        return true;
      }

      case "COPY_PASSWORD": {
        if (!encryptionKey || !currentUserId) {
          sendResponse({
            type: "COPY_PASSWORD",
            password: null,
            error: "VAULT_LOCKED",
          });
          break;
        }

        (async () => {
          try {
            const res = await swFetch(`/api/passwords/${message.entryId}`);
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
            let password: string | null = null;
            try {
              const blob = JSON.parse(plaintext) as { password?: string | null };
              password = blob.password ?? null;
            } catch {
              password = null;
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
              error: err instanceof Error ? err.message : "FETCH_FAILED",
            });
          }
        })();

        return true;
      }

      case "AUTOFILL": {
        (async () => {
          try {
            const result = await performAutofillForEntry(
              message.entryId,
              message.tabId,
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
              error: err instanceof Error ? err.message : "AUTOFILL_FAILED",
            });
          }
        })();

        return true;
      }

      case "GET_MATCHES_FOR_URL": {
        const vaultLocked = !encryptionKey || !currentUserId;
        if (vaultLocked || !currentToken) {
          sendResponse({
            type: "GET_MATCHES_FOR_URL",
            entries: [],
            vaultLocked: true,
          });
          break;
        }

        (async () => {
          try {
            const tabHost = extractHost(message.url);
            if (!tabHost) {
              sendResponse({
                type: "GET_MATCHES_FOR_URL",
                entries: [],
                vaultLocked: false,
              });
              return;
            }
            const entries = await getCachedEntries();
            const matches = entries.filter(
              (e) =>
                e.entryType === "LOGIN" &&
                e.urlHost &&
                isHostMatch(e.urlHost, tabHost),
            );
            sendResponse({
              type: "GET_MATCHES_FOR_URL",
              entries: matches,
              vaultLocked: false,
            });
          } catch {
            sendResponse({
              type: "GET_MATCHES_FOR_URL",
              entries: [],
              vaultLocked: false,
            });
          }
        })();

        return true;
      }

      case "AUTOFILL_FROM_CONTENT": {
        if (!encryptionKey || !currentUserId) {
          sendResponse({
            type: "AUTOFILL_FROM_CONTENT",
            ok: false,
            error: "VAULT_LOCKED",
          });
          break;
        }

        (async () => {
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
              error: err instanceof Error ? err.message : "AUTOFILL_FAILED",
            });
          }
        })();

        return true;
      }

      default:
        // Unknown message — do not hold the channel open
        return false;
    }

    // Return true to indicate async sendResponse
    return true;
  },
);
