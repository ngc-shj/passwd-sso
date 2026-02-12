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

// ── In-memory token storage (never persisted to disk) ────────

let currentToken: string | null = null;
let tokenExpiresAt: number | null = null;
let encryptionKey: CryptoKey | null = null;
let currentUserId: string | null = null;

const ALARM_NAME = "extension-token-ttl";
const VAULT_ALARM = "vault-auto-lock";
const VAULT_TIMEOUT_MS = 15 * 60 * 1000;

/** Securely clear token from memory */
function clearToken(): void {
  currentToken = null;
  tokenExpiresAt = null;
  clearVault();
}

function clearVault(): void {
  encryptionKey = null;
  currentUserId = null;
  chrome.alarms.clear(VAULT_ALARM);
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
            chrome.alarms.create(VAULT_ALARM, {
              delayInMinutes: VAULT_TIMEOUT_MS / 60000,
            });

            sendResponse({ type: "UNLOCK_VAULT", ok: true });
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

            const raw = (await res.json()) as Array<{
              id: string;
              encryptedOverview: { ciphertext: string; iv: string; authTag: string };
              entryType: string;
              aadVersion?: number;
            }>;

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

            sendResponse({
              type: "FETCH_PASSWORDS",
              entries,
            });
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

      default:
        // Unknown message — do not hold the channel open
        return false;
    }

    // Return true to indicate async sendResponse
    return true;
  },
);
