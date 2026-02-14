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
} from "../lib/crypto";
import { EXT_API_PATH, extApiPath } from "../lib/api-paths";
import { getSettings } from "../lib/storage";
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
  TOKEN_BRIDGE_SCRIPT_ID,
  CMD_TRIGGER_AUTOFILL,
  EXT_ENTRY_TYPE,
} from "../lib/constants";

// ── In-memory state (token/userId persisted to chrome.storage.session) ──

let currentToken: string | null = null;
let tokenExpiresAt: number | null = null;
let encryptionKey: CryptoKey | null = null;
let currentUserId: string | null = null;
let currentVaultSecretKeyHex: string | null = null;

const CACHE_TTL_MS = 60_000; // 1 minute
const REFRESH_BUFFER_MS = 2 * 60 * 1000; // refresh 2 min before expiry

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

function invalidateCache(): void {
  cachedEntries = null;
  cacheTimestamp = 0;
}

async function getCachedEntries(): Promise<DecryptedEntry[]> {
  if (cachedEntries && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedEntries;
  }
  const res = await swFetch(EXT_API_PATH.PASSWORDS);
  if (!res.ok) return [];
  const raw = (await res.json()) as RawEntry[];
  const entries = await decryptOverviews(raw);
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
  invalidateCache();
  chrome.alarms.clear(ALARM_VAULT_LOCK);
  persistState();
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

// ── Session persistence & token refresh ──────────────────────

/** Fire-and-forget persist of token state to chrome.storage.session */
function persistState(): void {
  if (currentToken && tokenExpiresAt) {
    persistSession({
      token: currentToken,
      expiresAt: tokenExpiresAt,
      userId: currentUserId ?? undefined,
      vaultSecretKey: currentVaultSecretKeyHex ?? undefined,
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
  }

  // Re-create TTL expiry alarm
  chrome.alarms.create(ALARM_TOKEN_TTL, { when: state.expiresAt });
  // Schedule refresh
  scheduleRefreshAlarm(state.expiresAt);

  // Restore vault auto-lock alarm if vault is unlocked
  if (encryptionKey) {
    const { autoLockMinutes } = await getSettings();
    if (autoLockMinutes > 0) {
      chrome.alarms.create(ALARM_VAULT_LOCK, { delayInMinutes: autoLockMinutes });
    }
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
    let origin: string;
    try {
      origin = new URL(serverUrl).origin;
    } catch {
      return;
    }

    const res = await fetch(`${origin}${EXT_API_PATH.EXTENSION_TOKEN_REFRESH}`, {
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
    let origin: string;
    try {
      origin = new URL(serverUrl).origin;
    } catch {
      return;
    }
    await fetch(`${origin}${EXT_API_PATH.EXTENSION_TOKEN}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${currentToken}` },
    });
  } catch {
    // Best-effort revoke; local clear still proceeds.
  }
}

async function shouldSuppressInlineMatches(url: string): Promise<boolean> {
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
  let serverOrigin: string;
  try {
    serverOrigin = new URL(serverUrl).origin;
  } catch {
    return false;
  }
  if (pageUrl.origin !== serverOrigin) {
    return false;
  }

  // Suppress inline suggestions on the passwd-sso app origin.
  return true;
}

// Harden session storage visibility on SW startup (best-effort).
void configureSessionStorageAccess();

// Hydrate on SW startup
const hydrationPromise = hydrateFromSession().catch(() => {});

// ── Alarm: auto-clear on expiry ──────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_TOKEN_TTL) {
    clearToken();
  }
  if (alarm.name === ALARM_VAULT_LOCK) {
    clearVault();
  }
  if (alarm.name === ALARM_TOKEN_REFRESH) {
    attemptTokenRefresh().catch(() => {});
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

  chrome.alarms.clear(ALARM_VAULT_LOCK);
  if (newValue > 0) {
    chrome.alarms.create(ALARM_VAULT_LOCK, { delayInMinutes: newValue });
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
  if (command !== CMD_TRIGGER_AUTOFILL) return;
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
});

async function swFetch(path: string): Promise<Response> {
  if (!currentToken) {
    throw new Error("NO_TOKEN");
  }
  const { serverUrl } = await getSettings();
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
  targetHint?: AutofillTargetHint,
): Promise<{ ok: boolean; error?: string }> {
  if (!encryptionKey || !currentUserId) {
    return { ok: false, error: "VAULT_LOCKED" };
  }
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

  const blob = JSON.parse(blobPlain) as {
    password?: string | null;
    username?: string | null;
    loginId?: string | null;
    userId?: string | null;
    email?: string | null;
    customFields?: Array<{ label?: string; value?: string; type?: string }>;
  };
  const overview = JSON.parse(overviewPlain) as { username?: string | null };
  const password = blob.password ?? null;
  const username =
    overview.username ??
    blob.username ??
    blob.loginId ??
    blob.userId ??
    blob.email ??
    "";

  const customFields = Array.isArray(blob.customFields) ? blob.customFields : [];
  const findCustomFieldValue = (pattern: RegExp): string | null => {
    for (const field of customFields) {
      const label = (field?.label ?? "").toString();
      const value = (field?.value ?? "").toString();
      if (!label || !value) continue;
      if (pattern.test(label)) return value;
    }
    return null;
  };
  const awsAccountIdOrAlias =
    findCustomFieldValue(
      /(aws.*account|account.*(id|alias)|account id|account alias|アカウント|アカウントID|エイリアス)/i,
    ) ?? "";
  const awsIamUsername =
    findCustomFieldValue(
      /(iam.*(user|username)|user ?name|iamユーザー|iamユーザ|ユーザー名)/i,
    ) ?? "";

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

  if (!password) {
    return { ok: false, error: "NO_PASSWORD" };
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content/autofill.js"],
    });
    await chrome.tabs.sendMessage(tabId, {
      type: "AUTOFILL_FILL",
      username,
      password,
      ...(serializableTargetHint ? { targetHint: serializableTargetHint } : {}),
      ...(awsAccountIdOrAlias ? { awsAccountIdOrAlias } : {}),
      ...(awsIamUsername ? { awsIamUsername } : {}),
    });
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
        password,
        hintArg,
        awsAccountIdOrAlias,
        awsIamUsername,
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
        awsAccountIdOrAliasArg?: string,
        awsIamUsernameArg?: string,
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
      const isAwsSignInPage =
        window.location.hostname.includes("signin.aws.amazon.com") ||
        window.location.hostname.includes("sign-in.aws.amazon.com");

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

      if (fallbackUsername && usernameArg) setInputValue(fallbackUsername, usernameArg);
      if (isAwsSignInPage) {
        const readHints = (input: HTMLInputElement) => {
          const labelText =
            (input.id
              ? document.querySelector(`label[for="${input.id.replace(/["\\]/g, "\\$&")}"]`)
                  ?.textContent ?? ""
              : "") + (input.getAttribute("aria-label") ?? "") + (input.placeholder ?? "");
          return `${input.name} ${input.id} ${labelText}`.toLowerCase();
        };
        const accountInput = inputs.find((i) => {
          if (!isUsableInput(i) || !["text", "email", "tel"].includes(i.type)) return false;
          const hints = readHints(i);
          return /(account|alias|アカウント|エイリアス)/.test(hints);
        });
        const iamInput = inputs.find((i) => {
          if (!isUsableInput(i) || !["text", "email", "tel"].includes(i.type)) return false;
          const hints = readHints(i);
          return /(iam|username|user.?name|ユーザー名|ユーザ名)/.test(hints);
        });
        if (accountInput && awsAccountIdOrAliasArg) setInputValue(accountInput, awsAccountIdOrAliasArg);
        if (iamInput && awsIamUsernameArg) setInputValue(iamInput, awsIamUsernameArg);
      }
      if (passwordInput) setInputValue(passwordInput, passwordArg);
      },
    });

  try {
    await injectDirectAutofill(serializableTargetHint);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/unserializable/i.test(message)) throw err;
    await injectDirectAutofill(null);
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
        persistState();
        const { autoLockMinutes } = await getSettings();
        if (autoLockMinutes > 0) {
          chrome.alarms.create(ALARM_VAULT_LOCK, {
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
        const res = await swFetch(EXT_API_PATH.PASSWORDS);
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
      return;
    }

    case "AUTOFILL": {
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
      return;
    }

    case "GET_MATCHES_FOR_URL": {
      const effectiveUrl = message.topUrl ?? message.url;
      if (await shouldSuppressInlineMatches(effectiveUrl)) {
        sendResponse({
          type: "GET_MATCHES_FOR_URL",
          entries: [],
          vaultLocked: false,
          suppressInline: true,
        });
        return;
      }
      if (!encryptionKey || !currentUserId || !currentToken) {
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
        const matches = entries.filter(
          (e) =>
            e.entryType === EXT_ENTRY_TYPE.LOGIN &&
            e.urlHost &&
            isHostMatch(e.urlHost, tabHost),
        );
        sendResponse({
          type: "GET_MATCHES_FOR_URL",
          entries: matches,
          vaultLocked: false,
          suppressInline: false,
        });
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
            sendResponse({ type: "GET_MATCHES_FOR_URL", entries: [], vaultLocked: true, suppressInline: false } as ExtensionResponse);
            break;
          case "FETCH_PASSWORDS":
            sendResponse({ type: "FETCH_PASSWORDS", entries: null, error: "INTERNAL_ERROR" } as ExtensionResponse);
            break;
          case "COPY_PASSWORD":
            sendResponse({ type: "COPY_PASSWORD", password: null, error: "INTERNAL_ERROR" } as ExtensionResponse);
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
