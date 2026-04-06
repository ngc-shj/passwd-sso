import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ALARM_VAULT_LOCK,
  ALARM_TOKEN_REFRESH,
  CMD_TRIGGER_AUTOFILL,
  EXT_ENTRY_TYPE,
} from "../lib/constants";
import { EXT_API_PATH, extApiPath } from "../lib/api-paths";
import type { SessionState } from "../lib/session-storage";

const PASSWORD_BY_ID_PREFIX = extApiPath.passwordById("");

const sessionStorageMocks = vi.hoisted(() => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
  loadSession: vi.fn().mockResolvedValue(null),
  clearSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/session-storage", () => sessionStorageMocks);

const cryptoMocks = vi.hoisted(() => ({
  deriveWrappingKey: vi.fn().mockResolvedValue("wrap-key"),
  unwrapSecretKey: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  deriveEncryptionKey: vi.fn().mockResolvedValue("enc-key"),
  verifyKey: vi.fn().mockResolvedValue(true),
  decryptData: vi.fn().mockResolvedValue(
    JSON.stringify({ title: "Example", username: "alice", urlHost: "example.com" })
  ),
  buildPersonalEntryAAD: vi.fn().mockReturnValue(new Uint8Array([1, 2])),
  hexDecode: vi.fn().mockReturnValue(new Uint8Array([0, 1])),
}));

vi.mock("../lib/crypto", () => cryptoMocks);

type MessageHandler = (
  message: unknown,
  sender: unknown,
  sendResponse: (resp: unknown) => void
) => boolean | void;

let messageHandlers: MessageHandler[] = [];
let alarmHandlers: Array<(alarm: { name: string }) => void> = [];
let chromeMock: ReturnType<typeof installChromeMock> | null = null;
let storageChangeHandlers: Array<
  (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void
> = [];
let commandHandlers: Array<(command: string) => void | Promise<void>> = [];
let tabActivatedHandlers: Array<(activeInfo: { tabId: number; windowId: number }) => void> = [];
let tabUpdatedHandlers: Array<(tabId: number, changeInfo: { status?: string }, tab: { id?: number; url?: string }) => void> = [];

function installChromeMock() {
  messageHandlers = [];
  alarmHandlers = [];
  storageChangeHandlers = [];
  commandHandlers = [];
  tabActivatedHandlers = [];
  tabUpdatedHandlers = [];

  const chromeMock = {
    runtime: {
      onMessage: {
        addListener: (fn: MessageHandler) => {
          messageHandlers.push(fn);
        },
      },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      sendMessage: vi.fn().mockResolvedValue({ ok: true }),
      getContexts: vi.fn().mockResolvedValue([]),
    },
    offscreen: {
      createDocument: vi.fn().mockResolvedValue(undefined),
      hasDocument: vi.fn().mockResolvedValue(false),
      Reason: { CLIPBOARD: "CLIPBOARD" },
    },
    alarms: {
      onAlarm: {
        addListener: (fn: (alarm: { name: string }) => void) => {
          alarmHandlers.push(fn);
        },
      },
      create: vi.fn(),
      clear: vi.fn(),
    },
    scripting: {
      executeScript: vi.fn().mockResolvedValue([]),
      registerContentScripts: vi.fn().mockResolvedValue(undefined),
      unregisterContentScripts: vi.fn().mockResolvedValue(undefined),
    },
    tabs: {
      sendMessage: vi.fn().mockResolvedValue({}),
      get: vi.fn().mockResolvedValue({ id: 1, url: "https://github.com" }),
      query: vi.fn().mockResolvedValue([{ id: 1, url: "https://github.com" }]),
      onActivated: {
        addListener: (fn: (activeInfo: { tabId: number; windowId: number }) => void) => {
          tabActivatedHandlers.push(fn);
        },
      },
      onUpdated: {
        addListener: (fn: (tabId: number, changeInfo: { status?: string }, tab: { id?: number; url?: string }) => void) => {
          tabUpdatedHandlers.push(fn);
        },
      },
      onRemoved: { addListener: vi.fn() },
    },
    action: {
      setBadgeText: vi.fn().mockResolvedValue(undefined),
      setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
    },
    contextMenus: {
      create: vi.fn(),
      removeAll: vi.fn((cb?: () => void) => cb?.()),
      onClicked: { addListener: vi.fn() },
    },
    permissions: {
      contains: vi.fn().mockResolvedValue(true),
    },
    storage: {
      local: {
        get: vi
          .fn()
          .mockResolvedValue({ serverUrl: "https://localhost:3000", autoLockMinutes: 15 }),
      },
      session: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: {
        addListener: (fn: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void) => {
          storageChangeHandlers.push(fn);
        },
      },
    },
    commands: {
      onCommand: {
        addListener: (fn: (command: string) => void | Promise<void>) => {
          commandHandlers.push(fn);
        },
      },
    },
  };

  vi.stubGlobal("chrome", chromeMock);
  return chromeMock;
}

async function loadBackground() {
  await import("../background/index");
}

function sendMessage(message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const handler = messageHandlers[0];
    handler(message, {}, (resp) => resolve(resp));
  });
}

function sendMessageWithSender(message: unknown, sender: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const handler = messageHandlers[0];
    handler(message, sender, (resp) => resolve(resp));
  });
}

describe("background message flow", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chromeMock = installChromeMock();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes(EXT_API_PATH.EXTENSION_TOKEN_REFRESH)) {
          return {
            ok: true,
            json: async () => ({
              token: "refreshed-tok",
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
              scope: ["passwords:read", "vault:unlock-data"],
            }),
          };
        }
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_DATA)) {
          return {
            ok: true,
            json: async () => ({
              userId: "user-1",
              accountSalt: "00",
              encryptedSecretKey: "aa",
              secretKeyIv: "bb",
              secretKeyAuthTag: "cc",
              verificationArtifact: { ciphertext: "11", iv: "22", authTag: "33" },
            }),
          };
        }
        if (url.includes(PASSWORD_BY_ID_PREFIX)) {
          return {
            ok: true,
            json: async () => ({
              id: "pw-1",
              encryptedBlob: { ciphertext: "aa", iv: "bb", authTag: "cc" },
              encryptedOverview: { ciphertext: "11", iv: "22", authTag: "33" },
              aadVersion: 1,
            }),
          };
        }
        if (url.includes(EXT_API_PATH.PASSWORDS)) {
          return {
            ok: true,
            json: async () => [
              {
                id: "pw-1",
                encryptedOverview: { ciphertext: "11", iv: "22", authTag: "33" },
                entryType: EXT_ENTRY_TYPE.LOGIN,
                aadVersion: 1,
              },
            ],
          };
        }
        return { ok: false, json: async () => ({}) };
      })
    );

    await loadBackground();
  });

  it("unlocks the vault and reports vaultUnlocked status", async () => {
    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });

    const res = await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });
    expect(res).toEqual({ type: "UNLOCK_VAULT", ok: true });

    const status = await sendMessage({ type: "GET_STATUS" });
    expect(status).toEqual(
      expect.objectContaining({ type: "GET_STATUS", vaultUnlocked: true })
    );
    expect(chromeMock?.alarms.create).toHaveBeenCalledWith(
      ALARM_VAULT_LOCK,
      expect.objectContaining({ delayInMinutes: 15 })
    );

    // Keepalive: offscreen document ensured + start-keepalive sent
    expect(chromeMock?.offscreen.hasDocument).toHaveBeenCalled();
    expect(chromeMock?.offscreen.createDocument).toHaveBeenCalled();
    expect(chromeMock?.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ target: "offscreen", type: "start-keepalive" })
    );
  });

  it("sends stop-keepalive on LOCK_VAULT", async () => {
    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });
    (chromeMock?.runtime.sendMessage as ReturnType<typeof vi.fn>).mockClear();

    await sendMessage({ type: "LOCK_VAULT" });

    expect(chromeMock?.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ target: "offscreen", type: "stop-keepalive" })
    );
  });

  it("configures storage.session access level to trusted contexts on startup", async () => {
    expect(chromeMock?.storage.session.setAccessLevel).toHaveBeenCalledWith({
      accessLevel: "TRUSTED_CONTEXTS",
    });
  });

  it("relocks vault when token value changes", async () => {
    await sendMessage({
      type: "SET_TOKEN",
      token: "t-1",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const before = await sendMessage({ type: "GET_STATUS" });
    expect(before).toEqual(
      expect.objectContaining({ type: "GET_STATUS", hasToken: true, vaultUnlocked: true }),
    );

    await sendMessage({
      type: "SET_TOKEN",
      token: "t-2",
      expiresAt: Date.now() + 60_000,
    });

    const after = await sendMessage({ type: "GET_STATUS" });
    expect(after).toEqual(
      expect.objectContaining({ type: "GET_STATUS", hasToken: true, vaultUnlocked: false }),
    );
    expect(chromeMock?.alarms.clear).toHaveBeenCalledWith(ALARM_VAULT_LOCK);
  });

  it("returns error on invalid passphrase", async () => {
    cryptoMocks.unwrapSecretKey.mockRejectedValueOnce(new Error("bad passphrase"));
    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });

    const res = await sendMessage({ type: "UNLOCK_VAULT", passphrase: "bad" });
    expect(res).toEqual(
      expect.objectContaining({ type: "UNLOCK_VAULT", ok: false })
    );
  });

  it("removes persisted vault secret on LOCK_VAULT", async () => {
    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });
    await sendMessage({ type: "LOCK_VAULT" });

    // After LOCK_VAULT, persistSession should have been called with a token but no vault fields
    const calls = sessionStorageMocks.persistSession.mock.calls;
    const lastState = calls[calls.length - 1]?.[0] as SessionState | undefined;
    expect(lastState).toBeDefined();
    expect(typeof lastState?.token).toBe("string");
    expect(lastState?.userId).toBeUndefined();
    expect(lastState?.vaultSecretKey).toBeUndefined();
  });

  it("does not create auto-lock alarm when disabled", async () => {
    chromeMock?.storage.local.get.mockResolvedValue({
      serverUrl: "https://localhost:3000",
      autoLockMinutes: 0,
    });
    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });
    expect(chromeMock?.alarms.create).not.toHaveBeenCalledWith(
      ALARM_VAULT_LOCK,
      expect.anything()
    );
  });

  it("updates auto-lock timer when settings change", async () => {
    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const handler = storageChangeHandlers[0];
    handler({ autoLockMinutes: { newValue: 5 } }, "local");
    expect(chromeMock?.alarms.clear).toHaveBeenCalledWith(ALARM_VAULT_LOCK);
    expect(chromeMock?.alarms.create).toHaveBeenCalledWith(
      ALARM_VAULT_LOCK,
      expect.objectContaining({ delayInMinutes: 5 })
    );
  });

  it("clears auto-lock timer when set to 0", async () => {
    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const handler = storageChangeHandlers[0];
    handler({ autoLockMinutes: { newValue: 0 } }, "local");
    expect(chromeMock?.alarms.clear).toHaveBeenCalledWith(ALARM_VAULT_LOCK);
  });

  it("ignores auto-lock changes while vault is locked", async () => {
    const handler = storageChangeHandlers[0];
    handler({ autoLockMinutes: { newValue: 5 } }, "local");
    expect(chromeMock?.alarms.create).not.toHaveBeenCalledWith(
      ALARM_VAULT_LOCK,
      expect.anything()
    );
  });

  it("registers token bridge content script on startup", async () => {
    expect(chromeMock?.scripting.unregisterContentScripts).toHaveBeenCalled();
    expect(chromeMock?.scripting.registerContentScripts).toHaveBeenCalled();
  });

  it("skips token bridge registration when permission is denied", async () => {
    vi.resetModules();
    chromeMock = installChromeMock();
    chromeMock?.permissions.contains.mockResolvedValueOnce(false);
    await loadBackground();
    // WebAuthn interceptor is always registered, but token bridge should not be
    const calls = chromeMock?.scripting.registerContentScripts.mock.calls ?? [];
    const tokenBridgeCalls = calls.filter((c: unknown[]) =>
      JSON.stringify(c).includes("token-bridge"),
    );
    expect(tokenBridgeCalls).toHaveLength(0);
  });

  it("updates badge when token is set and vault unlocked", async () => {
    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });
    await vi.waitFor(() => {
      expect(chromeMock?.action.setBadgeText).toHaveBeenCalledWith({ text: "" });
      // Per-tab overrides removed (null) so global badge becomes visible
      expect(chromeMock?.action.setBadgeText).toHaveBeenCalledWith({ text: null, tabId: 1 });
    });
  });

  it("clears all tab badges on vault lock", async () => {
    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });
    chromeMock?.action.setBadgeText.mockClear();

    await sendMessage({ type: "LOCK_VAULT" });

    await vi.waitFor(() => {
      // Global badge should show "!"
      expect(chromeMock?.action.setBadgeText).toHaveBeenCalledWith({ text: "!" });
      // Per-tab overrides removed so global "!" becomes visible
      expect(chromeMock?.action.setBadgeText).toHaveBeenCalledWith({ text: null, tabId: 1 });
    });
  });

  it("clears all tab badges on disconnect", async () => {
    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    chromeMock?.action.setBadgeText.mockClear();

    await sendMessage({ type: "CLEAR_TOKEN" });

    await vi.waitFor(() => {
      expect(chromeMock?.action.setBadgeText).toHaveBeenCalledWith({ text: "×" });
      expect(chromeMock?.action.setBadgeText).toHaveBeenCalledWith({ text: null, tabId: 1 });
    });
  });

  it("handles trigger-autofill command by requesting inline suggestions", async () => {
    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const handler = commandHandlers[0];
    await handler(CMD_TRIGGER_AUTOFILL);
    expect(chromeMock?.tabs.sendMessage).toHaveBeenCalledWith(
      1,
      { type: "PSSO_TRIGGER_INLINE_SUGGESTIONS" },
    );
  });

  it("does nothing when command has no active tab url", async () => {
    chromeMock?.tabs.query.mockResolvedValueOnce([{ id: 1, url: undefined }]);
    const handler = commandHandlers[0];
    await handler(CMD_TRIGGER_AUTOFILL);
    expect(chromeMock?.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("injects form detector and retries when command message has no receiver", async () => {
    chromeMock?.tabs.sendMessage
      .mockRejectedValueOnce(new Error("Could not establish connection. Receiving end does not exist."))
      .mockResolvedValueOnce({});

    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const handler = commandHandlers[0];
    await handler(CMD_TRIGGER_AUTOFILL);

    expect(chromeMock?.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 1, allFrames: true },
        files: ["src/content/form-detector.js"],
      }),
    );
    expect(chromeMock?.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("fetches and decrypts password overviews", async () => {
    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const res = await sendMessage({ type: "FETCH_PASSWORDS" });
    expect(res).toEqual({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "pw-1",
          title: "Example",
          username: "alice",
          urlHost: "example.com",
          entryType: EXT_ENTRY_TYPE.LOGIN,
        },
      ],
    });
    expect(cryptoMocks.buildPersonalEntryAAD).toHaveBeenCalledWith(
      "user-1",
      "pw-1"
    );
  });

  it("returns error when COPY_PASSWORD called while vault locked", async () => {
    const res = await sendMessage({ type: "COPY_PASSWORD", entryId: "pw-1" });
    expect(res).toEqual({
      type: "COPY_PASSWORD",
      password: null,
      error: "VAULT_LOCKED",
    });
  });

  it("returns password for COPY_PASSWORD", async () => {
    cryptoMocks.decryptData.mockResolvedValueOnce(
      JSON.stringify({ password: "secret" })
    );
    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const res = await sendMessage({ type: "COPY_PASSWORD", entryId: "pw-1" });
    expect(res).toEqual({
      type: "COPY_PASSWORD",
      password: "secret",
    });
  });

  it("returns error when COPY_PASSWORD fetch fails", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes(EXT_API_PATH.EXTENSION_TOKEN_REFRESH)) {
        return {
          ok: true,
          json: async () => ({
            token: "refreshed-tok",
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
            scope: ["passwords:read", "vault:unlock-data"],
          }),
        };
      }
      if (url.includes(EXT_API_PATH.VAULT_UNLOCK_DATA)) {
        return {
          ok: true,
          json: async () => ({
            userId: "user-1",
            accountSalt: "00",
            encryptedSecretKey: "aa",
            secretKeyIv: "bb",
            secretKeyAuthTag: "cc",
            verificationArtifact: { ciphertext: "11", iv: "22", authTag: "33" },
          }),
        };
      }
      return { ok: false, json: async () => ({ error: "NOT_FOUND" }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const res = await sendMessage({ type: "COPY_PASSWORD", entryId: "pw-1" });
    expect(res).toEqual({
      type: "COPY_PASSWORD",
      password: null,
      error: "NOT_FOUND",
    });
  });

  it("returns error when AUTOFILL called while vault locked", async () => {
    const res = await sendMessage({ type: "AUTOFILL", entryId: "pw-1", tabId: 1 });
    expect(res).toEqual({ type: "AUTOFILL", ok: false, error: "VAULT_LOCKED" });
  });

  it("autofills successfully", async () => {
    cryptoMocks.decryptData
      .mockResolvedValueOnce(JSON.stringify({ password: "secret" }))
      .mockResolvedValueOnce(JSON.stringify({ username: "alice" }));

    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const res = await sendMessage({ type: "AUTOFILL", entryId: "pw-1", tabId: 1 });
    expect(res).toEqual({ type: "AUTOFILL", ok: true });
    expect(chromeMock?.tabs.sendMessage).toHaveBeenCalledWith(1, {
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
    });
  });

  it("autofills with blob username fallback when overview username is missing", async () => {
    cryptoMocks.decryptData
      .mockResolvedValueOnce(
        JSON.stringify({ password: "secret", loginId: "fallback-user" }),
      )
      .mockResolvedValueOnce(JSON.stringify({ username: null }));

    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const res = await sendMessage({ type: "AUTOFILL", entryId: "pw-1", tabId: 1 });
    expect(res).toEqual({ type: "AUTOFILL", ok: true });
    expect(chromeMock?.tabs.sendMessage).toHaveBeenCalledWith(1, {
      type: "AUTOFILL_FILL",
      username: "fallback-user",
      password: "secret",
    });
  });

  it("includes text custom fields in autofill payload", async () => {
    cryptoMocks.decryptData
      .mockResolvedValueOnce(
        JSON.stringify({
          password: "secret",
          customFields: [
            { label: "brchNum", value: "001", type: "text" },
            { label: "apiKey", value: "sk-123", type: "hidden" },
            { label: "https://example.com", value: "https://example.com", type: "url" },
          ],
        }),
      )
      .mockResolvedValueOnce(JSON.stringify({ username: "alice" }));

    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const res = await sendMessage({ type: "AUTOFILL", entryId: "pw-1", tabId: 1 });
    expect(res).toEqual({ type: "AUTOFILL", ok: true });
    expect(chromeMock?.tabs.sendMessage).toHaveBeenCalledWith(1,
      expect.objectContaining({
        type: "AUTOFILL_FILL",
        username: "alice",
        password: "secret",
        customFields: [{ label: "brchNum", value: "001" }],
      }),
    );
  });

  it("suppresses inline matches on passwd-sso origin", async () => {
    cryptoMocks.decryptData.mockResolvedValueOnce(
      JSON.stringify({
        title: "Local entry",
        username: "local-user",
        urlHost: "localhost",
      }),
    );

    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const res = await sendMessage({
      type: "GET_MATCHES_FOR_URL",
      url: "https://localhost:3000/ja/passwords/new",
    });

    expect(res).toEqual({
      type: "GET_MATCHES_FOR_URL",
      entries: [],
      vaultLocked: false,
      suppressInline: true,
    });
  });

  it("suppresses inline matches on passwd-sso origin even when vault is locked", async () => {
    const res = await sendMessage({
      type: "GET_MATCHES_FOR_URL",
      url: "https://localhost:3000/ja/dashboard",
    });

    expect(res).toEqual({
      type: "GET_MATCHES_FOR_URL",
      entries: [],
      vaultLocked: false,
      suppressInline: true,
    });
  });

  it("does not suppress inline matches when scheme differs from serverUrl", async () => {
    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const res = await sendMessage({
      type: "GET_MATCHES_FOR_URL",
      url: "http://localhost:3000/ja/dashboard",
    });

    expect(res).toEqual(
      expect.objectContaining({
        type: "GET_MATCHES_FOR_URL",
        vaultLocked: false,
        suppressInline: false,
      }),
    );
  });

  it("suppresses inline matches using topUrl from iframe context", async () => {
    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const res = await sendMessage({
      type: "GET_MATCHES_FOR_URL",
      url: "about:blank",
      topUrl: "https://localhost:3000/ja/dashboard",
    });

    expect(res).toEqual({
      type: "GET_MATCHES_FOR_URL",
      entries: [],
      vaultLocked: false,
      suppressInline: true,
    });
  });

  it("suppresses using topUrl even when frame url is external", async () => {
    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const res = await sendMessage({
      type: "GET_MATCHES_FOR_URL",
      url: "https://example.com/login",
      topUrl: "https://localhost:3000/ja/auth/signin",
    });

    expect(res).toEqual({
      type: "GET_MATCHES_FOR_URL",
      entries: [],
      vaultLocked: false,
      suppressInline: true,
    });
  });

  it("does not suppress when serverUrl is missing", async () => {
    chromeMock?.storage.local.get.mockImplementation(async (arg?: unknown) => {
      if (arg === "serverUrl") return {};
      return { serverUrl: "https://localhost:3000", autoLockMinutes: 15 };
    });

    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const res = await sendMessage({
      type: "GET_MATCHES_FOR_URL",
      url: "https://localhost:3000/ja/dashboard",
    });

    expect(res).toEqual(
      expect.objectContaining({
        type: "GET_MATCHES_FOR_URL",
        suppressInline: false,
      }),
    );
  });

  it("returns error when AUTOFILL fetch fails", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes(EXT_API_PATH.EXTENSION_TOKEN_REFRESH)) {
        return {
          ok: true,
          json: async () => ({
            token: "refreshed-tok",
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
            scope: ["passwords:read", "vault:unlock-data"],
          }),
        };
      }
      if (url.includes(EXT_API_PATH.VAULT_UNLOCK_DATA)) {
        return {
          ok: true,
          json: async () => ({
            userId: "user-1",
            accountSalt: "00",
            encryptedSecretKey: "aa",
            secretKeyIv: "bb",
            secretKeyAuthTag: "cc",
            verificationArtifact: { ciphertext: "11", iv: "22", authTag: "33" },
          }),
        };
      }
      return { ok: false, json: async () => ({ error: "NOT_FOUND" }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const res = await sendMessage({ type: "AUTOFILL", entryId: "pw-1", tabId: 1 });
    expect(res).toEqual({ type: "AUTOFILL", ok: false, error: "NOT_FOUND" });
  });

  it("succeeds via sendMessage even when executeScript injection fails", async () => {
    chromeMock?.scripting.executeScript.mockRejectedValue(new Error("CSP"));
    cryptoMocks.decryptData.mockReset();
    cryptoMocks.decryptData
      .mockResolvedValueOnce(JSON.stringify({ password: "secret" }))
      .mockResolvedValueOnce(JSON.stringify({ username: "alice" }));

    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const res = await sendMessage({ type: "AUTOFILL", entryId: "pw-1", tabId: 1 });
    // executeScript fails but sendMessage reaches the listener bundled in form-detector.ts
    expect(res).toEqual({ type: "AUTOFILL", ok: true });
  });

  it("retries direct inject without hint when args are unserializable", async () => {
    cryptoMocks.decryptData
      .mockResolvedValueOnce(JSON.stringify({ password: "secret" }))
      .mockResolvedValueOnce(JSON.stringify({ username: "alice" }));

    // Message-based autofill must fail so direct fallback runs.
    chromeMock?.tabs.sendMessage.mockRejectedValueOnce(
      new Error("Could not establish connection"),
    );
    // 1st call: direct fallback with hint -> unserializable, 2nd: retry with null hint
    chromeMock?.scripting.executeScript
      .mockRejectedValueOnce(new Error("Value is unserializable"))
      .mockResolvedValueOnce([]);

    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const res = await new Promise((resolve) => {
      const handler = messageHandlers[0];
      handler(
        { type: "AUTOFILL_FROM_CONTENT", entryId: "pw-1", targetHint: { id: "user" } },
        { tab: { id: 1 } },
        (resp) => resolve(resp),
      );
    });
    expect(res).toEqual({ type: "AUTOFILL_FROM_CONTENT", ok: true, error: undefined });

    const calls = chromeMock?.scripting.executeScript.mock.calls ?? [];
    const argsList = calls
      .map((call) => (call[0] as { args?: unknown[] }).args)
      .filter((v): v is unknown[] => Array.isArray(v));
    expect(argsList.length).toBeGreaterThanOrEqual(2);
    expect(argsList[argsList.length - 1]?.[2]).toBeNull();
  });
});

// ── Session persistence & token refresh ──────────────────────

describe("session persistence", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chromeMock = installChromeMock();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_DATA)) {
          return {
            ok: true,
            json: async () => ({
              userId: "user-1",
              accountSalt: "00",
              encryptedSecretKey: "aa",
              secretKeyIv: "bb",
              secretKeyAuthTag: "cc",
              verificationArtifact: { ciphertext: "11", iv: "22", authTag: "33" },
            }),
          };
        }
        if (url.includes(EXT_API_PATH.PASSWORDS)) {
          return {
            ok: true,
            json: async () => [],
          };
        }
        return { ok: false, json: async () => ({}) };
      })
    );

    await loadBackground();
  });

  it("persists state to session storage after SET_TOKEN", async () => {
    const expiresAt = Date.now() + 600_000;
    await sendMessage({ type: "SET_TOKEN", token: "tok-1", expiresAt });
    // userId is not set yet at SET_TOKEN time, so persistState requires all 3 fields.
    // After UNLOCK_VAULT, userId is set and persistState is called.
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    expect(sessionStorageMocks.persistSession).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "tok-1",
        userId: "user-1",
      }),
    );
  });

  it("clears session storage on CLEAR_TOKEN", async () => {
    await sendMessage({
      type: "SET_TOKEN",
      token: "tok-1",
      expiresAt: Date.now() + 600_000,
    });
    await sendMessage({ type: "CLEAR_TOKEN" });

    expect(sessionStorageMocks.clearSession).toHaveBeenCalled();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/extension/token"),
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          Authorization: "Bearer tok-1",
        }),
      }),
    );
  });

  it("clears refresh alarm on CLEAR_TOKEN", async () => {
    await sendMessage({
      type: "SET_TOKEN",
      token: "tok-1",
      expiresAt: Date.now() + 600_000,
    });
    await sendMessage({ type: "CLEAR_TOKEN" });

    expect(chromeMock?.alarms.clear).toHaveBeenCalledWith(ALARM_TOKEN_REFRESH);
  });

  it("still clears local state when revoke API fails on CLEAR_TOKEN", async () => {
    await sendMessage({
      type: "SET_TOKEN",
      token: "tok-1",
      expiresAt: Date.now() + 600_000,
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue({ ok: false, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const res = await sendMessage({ type: "CLEAR_TOKEN" });

    expect(res).toEqual({ type: "CLEAR_TOKEN", ok: true });
    expect(sessionStorageMocks.clearSession).toHaveBeenCalled();
    expect(chromeMock?.alarms.clear).toHaveBeenCalledWith(ALARM_TOKEN_REFRESH);
  });

  it("schedules refresh alarm on SET_TOKEN", async () => {
    const expiresAt = Date.now() + 600_000;
    await sendMessage({ type: "SET_TOKEN", token: "tok-1", expiresAt });

    expect(chromeMock?.alarms.create).toHaveBeenCalledWith(
      ALARM_TOKEN_REFRESH,
      expect.objectContaining({ when: expect.any(Number) })
    );
  });
});

describe("session hydration", () => {
  it("restores token and unlocked vault state from session storage on startup", async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chromeMock = installChromeMock();

    const expiresAt = Date.now() + 600_000;
    sessionStorageMocks.loadSession.mockResolvedValueOnce({
      token: "hydrated-tok",
      expiresAt,
      userId: "u-1",
      vaultSecretKey: "010203",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) }))
    );

    await loadBackground();

    const status = await sendMessage({ type: "GET_STATUS" });
    expect(status).toEqual(
      expect.objectContaining({ hasToken: true, expiresAt, vaultUnlocked: true })
    );
  });

  it("clears expired state during hydration", async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chromeMock = installChromeMock();

    sessionStorageMocks.loadSession.mockResolvedValueOnce({
      token: "old-tok",
      expiresAt: Date.now() - 1000,
      userId: "u-1",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) }))
    );

    await loadBackground();

    expect(sessionStorageMocks.clearSession).toHaveBeenCalled();

    const status = await sendMessage({ type: "GET_STATUS" });
    expect(status).toEqual(
      expect.objectContaining({ hasToken: false })
    );
  });

  it("waits for hydration before responding to GET_STATUS", async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chromeMock = installChromeMock();

    const expiresAt = Date.now() + 600_000;
    let resolveLoad!: (value: SessionState | null) => void;
    const delayedLoad = new Promise<SessionState | null>((resolve) => {
      resolveLoad = resolve;
    });
    sessionStorageMocks.loadSession.mockReturnValueOnce(delayedLoad);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );

    await loadBackground();

    const statusPromise = sendMessage({ type: "GET_STATUS" });
    resolveLoad({
      token: "hydrated-tok",
      expiresAt,
      userId: "u-1",
      vaultSecretKey: "010203",
    });
    const status = await statusPromise;

    expect(status).toEqual(
      expect.objectContaining({ hasToken: true, expiresAt, vaultUnlocked: true }),
    );
  });
});

describe("token refresh alarm", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chromeMock = installChromeMock();
  });

  it("refreshes token on REFRESH_ALARM and updates state", async () => {
    const newExpiresAt = new Date(Date.now() + 900_000).toISOString();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes(EXT_API_PATH.EXTENSION_TOKEN_REFRESH)) {
          return {
            ok: true,
            json: async () => ({
              token: "refreshed-tok",
              expiresAt: newExpiresAt,
              scope: ["passwords:read"],
            }),
          };
        }
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_DATA)) {
          return {
            ok: true,
            json: async () => ({
              userId: "user-1",
              accountSalt: "00",
              encryptedSecretKey: "aa",
              secretKeyIv: "bb",
              secretKeyAuthTag: "cc",
              verificationArtifact: { ciphertext: "11", iv: "22", authTag: "33" },
            }),
          };
        }
        return { ok: false, json: async () => ({}) };
      })
    );

    await loadBackground();

    // Set token and unlock vault
    await sendMessage({
      type: "SET_TOKEN",
      token: "original-tok",
      expiresAt: Date.now() + 600_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    // Trigger refresh alarm
    const handler = alarmHandlers[0];
    handler({ name: ALARM_TOKEN_REFRESH });

    // Wait for async refresh to complete
    await new Promise((r) => setTimeout(r, 50));

    // Verify persistSession was called with the new token
    expect(sessionStorageMocks.persistSession).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "refreshed-tok",
        userId: "user-1",
      }),
    );
  });

  it("clears token when server rejects refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes(EXT_API_PATH.EXTENSION_TOKEN_REFRESH)) {
          return {
            ok: false,
            status: 401,
            json: async () => ({ error: "UNAUTHORIZED" }),
          };
        }
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_DATA)) {
          return {
            ok: true,
            json: async () => ({
              userId: "user-1",
              accountSalt: "00",
              encryptedSecretKey: "aa",
              secretKeyIv: "bb",
              secretKeyAuthTag: "cc",
              verificationArtifact: { ciphertext: "11", iv: "22", authTag: "33" },
            }),
          };
        }
        return { ok: false, json: async () => ({}) };
      })
    );

    await loadBackground();

    await sendMessage({
      type: "SET_TOKEN",
      token: "tok",
      expiresAt: Date.now() + 600_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    // Trigger refresh alarm
    const handler = alarmHandlers[0];
    handler({ name: ALARM_TOKEN_REFRESH });

    await new Promise((r) => setTimeout(r, 50));

    // Token should be cleared
    const status = await sendMessage({ type: "GET_STATUS" });
    expect(status).toEqual(
      expect.objectContaining({ hasToken: false })
    );
  });

  it("retries on transient server error (500) instead of clearing token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes(EXT_API_PATH.EXTENSION_TOKEN_REFRESH)) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: "INTERNAL_SERVER_ERROR" }),
          };
        }
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_DATA)) {
          return {
            ok: true,
            json: async () => ({
              userId: "user-1",
              accountSalt: "00",
              encryptedSecretKey: "aa",
              secretKeyIv: "bb",
              secretKeyAuthTag: "cc",
              verificationArtifact: { ciphertext: "11", iv: "22", authTag: "33" },
            }),
          };
        }
        return { ok: false, json: async () => ({}) };
      })
    );

    await loadBackground();

    await sendMessage({
      type: "SET_TOKEN",
      token: "tok",
      expiresAt: Date.now() + 600_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    chromeMock?.alarms.create.mockClear();

    const handler = alarmHandlers[0];
    handler({ name: ALARM_TOKEN_REFRESH });

    await new Promise((r) => setTimeout(r, 50));

    // Token should still be valid (not cleared on transient error)
    const status = await sendMessage({ type: "GET_STATUS" });
    expect(status).toEqual(
      expect.objectContaining({ hasToken: true })
    );

    // Should schedule a retry
    expect(chromeMock?.alarms.create).toHaveBeenCalledWith(
      ALARM_TOKEN_REFRESH,
      expect.objectContaining({ delayInMinutes: 1 })
    );
  });

  it("retries on rate limit (429) instead of clearing token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes(EXT_API_PATH.EXTENSION_TOKEN_REFRESH)) {
          return {
            ok: false,
            status: 429,
            json: async () => ({ error: "TOO_MANY_REQUESTS" }),
          };
        }
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_DATA)) {
          return {
            ok: true,
            json: async () => ({
              userId: "user-1",
              accountSalt: "00",
              encryptedSecretKey: "aa",
              secretKeyIv: "bb",
              secretKeyAuthTag: "cc",
              verificationArtifact: { ciphertext: "11", iv: "22", authTag: "33" },
            }),
          };
        }
        return { ok: false, json: async () => ({}) };
      })
    );

    await loadBackground();

    await sendMessage({
      type: "SET_TOKEN",
      token: "tok",
      expiresAt: Date.now() + 600_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    chromeMock?.alarms.create.mockClear();

    const handler = alarmHandlers[0];
    handler({ name: ALARM_TOKEN_REFRESH });

    await new Promise((r) => setTimeout(r, 50));

    const status = await sendMessage({ type: "GET_STATUS" });
    expect(status).toEqual(expect.objectContaining({ hasToken: true }));

    expect(chromeMock?.alarms.create).toHaveBeenCalledWith(
      ALARM_TOKEN_REFRESH,
      expect.objectContaining({ delayInMinutes: 1 })
    );
  });

  it("retries on network error if TTL remains", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes(EXT_API_PATH.EXTENSION_TOKEN_REFRESH)) {
          throw new Error("Failed to fetch");
        }
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_DATA)) {
          return {
            ok: true,
            json: async () => ({
              userId: "user-1",
              accountSalt: "00",
              encryptedSecretKey: "aa",
              secretKeyIv: "bb",
              secretKeyAuthTag: "cc",
              verificationArtifact: { ciphertext: "11", iv: "22", authTag: "33" },
            }),
          };
        }
        return { ok: false, json: async () => ({}) };
      })
    );

    await loadBackground();

    await sendMessage({
      type: "SET_TOKEN",
      token: "tok",
      expiresAt: Date.now() + 600_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    // Clear create calls from SET_TOKEN so we can check the retry
    chromeMock?.alarms.create.mockClear();

    const handler = alarmHandlers[0];
    handler({ name: ALARM_TOKEN_REFRESH });

    await new Promise((r) => setTimeout(r, 50));

    // Token should still be valid
    const status = await sendMessage({ type: "GET_STATUS" });
    expect(status).toEqual(
      expect.objectContaining({ hasToken: true })
    );

    // Should schedule a retry alarm
    expect(chromeMock?.alarms.create).toHaveBeenCalledWith(
      ALARM_TOKEN_REFRESH,
      expect.objectContaining({ delayInMinutes: 1 })
    );
  });
});

describe("hydration edge cases", () => {
  it("restores vault auto-lock alarm during hydration when vault key is present", async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chromeMock = installChromeMock();

    const expiresAt = Date.now() + 600_000;
    sessionStorageMocks.loadSession.mockResolvedValueOnce({
      token: "hydrated-tok",
      expiresAt,
      userId: "u-1",
      vaultSecretKey: "010203",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );

    await loadBackground();
    // Wait for hydration to complete
    await sendMessage({ type: "GET_STATUS" });

    expect(chromeMock.alarms.create).toHaveBeenCalledWith(
      ALARM_VAULT_LOCK,
      expect.objectContaining({ delayInMinutes: 15 }),
    );
  });

  it("does not hang when storage.session.get rejects", async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chromeMock = installChromeMock();

    chromeMock.storage.session.get.mockRejectedValue(new Error("storage unavailable"));

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );

    await loadBackground();

    const status = await sendMessage({ type: "GET_STATUS" });
    expect(status).toEqual(
      expect.objectContaining({ hasToken: false, vaultUnlocked: false }),
    );
  });
});

describe("failsafe responses", () => {
  it("returns type-safe failsafe when handleMessage throws for GET_STATUS", async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chromeMock = installChromeMock();

    // Make hydration promise reject to trigger the failsafe catch
    chromeMock.storage.session.get.mockImplementation(async () => {
      throw new Error("fatal");
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );

    await loadBackground();

    // Patch handleMessage to throw after hydration by making
    // the hydration itself fail — the failsafe catch should fire.
    // Since hydrationPromise.catch(() => {}) swallows the error,
    // hydration resolves normally but with empty state.
    // To truly trigger the failsafe, we need handleMessage itself to throw.
    // We can achieve this by corrupting the message handler's dependencies.
    const handler = messageHandlers[0];

    // Send a message with a type that will cause a runtime error inside handleMessage
    // by temporarily breaking a dependency after hydration
    const originalCreateAlarm = chromeMock.alarms.create;
    chromeMock.alarms.create = vi.fn(() => {
      throw new Error("simulated crash");
    });

    const res = await new Promise((resolve) => {
      handler(
        { type: "SET_TOKEN", token: "t", expiresAt: Date.now() + 60_000 },
        {},
        (resp) => resolve(resp),
      );
    });

    // The failsafe should return a generic error for SET_TOKEN (default branch)
    expect(res).toEqual(
      expect.objectContaining({ ok: false, error: "INTERNAL_ERROR" }),
    );

    chromeMock.alarms.create = originalCreateAlarm;
  });

  it("returns type-safe failsafe for FETCH_PASSWORDS on unexpected error", async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chromeMock = installChromeMock();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_DATA)) {
          return {
            ok: true,
            json: async () => ({
              userId: "user-1",
              accountSalt: "00",
              encryptedSecretKey: "aa",
              secretKeyIv: "bb",
              secretKeyAuthTag: "cc",
              verificationArtifact: { ciphertext: "11", iv: "22", authTag: "33" },
            }),
          };
        }
        if (url.includes(EXT_API_PATH.PASSWORDS)) {
          return {
            ok: true,
            // json() throws to simulate an unexpected error inside handleMessage
            json: async () => { throw new Error("simulated JSON crash"); },
          };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );

    await loadBackground();

    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const res = await sendMessage({ type: "FETCH_PASSWORDS" });
    // Promise.allSettled gracefully handles partial failures — returns empty entries
    expect(res).toEqual(
      expect.objectContaining({
        type: "FETCH_PASSWORDS",
        entries: [],
      }),
    );
  });

  it("returns PASSKEY_GET_MATCHES failsafe response when vault is locked", async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chromeMock = installChromeMock();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );

    await loadBackground();
    // Vault is locked (no SET_TOKEN / UNLOCK_VAULT) — handler returns the locked-state response.
    // senderUrl must match rpId for the auth check to pass and reach the vault-locked path.
    const res = await sendMessageWithSender(
      { type: "PASSKEY_GET_MATCHES", rpId: "example.com" },
      { tab: { url: "https://example.com/login" } },
    );

    expect(res).toEqual({ type: "PASSKEY_GET_MATCHES", entries: [], vaultLocked: true });
  });

  it("returns PASSKEY_SIGN_ASSERTION failsafe response when vault is locked", async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chromeMock = installChromeMock();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );

    await loadBackground();
    // Vault is locked — VAULT_LOCKED is the expected locked-state error
    const res = await sendMessage({
      type: "PASSKEY_SIGN_ASSERTION",
      entryId: "entry-1",
      clientDataJSON: JSON.stringify({ type: "webauthn.get", challenge: "abc" }),
    });

    expect(res).toEqual({ type: "PASSKEY_SIGN_ASSERTION", ok: false, error: "VAULT_LOCKED" });
  });

  it("returns PASSKEY_CREATE_CREDENTIAL failsafe response when vault is locked", async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chromeMock = installChromeMock();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );

    await loadBackground();
    // Vault is locked — VAULT_LOCKED is the expected locked-state error
    const res = await sendMessage({
      type: "PASSKEY_CREATE_CREDENTIAL",
      rpId: "example.com",
      rpName: "Example",
      userId: "user-handle",
      userName: "alice",
      userDisplayName: "Alice",
      excludeCredentialIds: [],
      clientDataJSON: JSON.stringify({ type: "webauthn.create", challenge: "xyz" }),
    });

    expect(res).toEqual({ type: "PASSKEY_CREATE_CREDENTIAL", ok: false, error: "VAULT_LOCKED" });
  });

  it("returns PASSKEY_GET_MATCHES vault-locked when no encryption key", async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chromeMock = installChromeMock();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );

    await loadBackground();

    const handler = messageHandlers[0];

    // senderUrl must match rpId for the auth check to pass and reach the vault-locked path
    const res = await new Promise((resolve) => {
      handler(
        { type: "PASSKEY_GET_MATCHES", rpId: "example.com" },
        { tab: { url: "https://example.com/login" } },
        (resp) => resolve(resp),
      );
    });

    expect(res).toEqual({ type: "PASSKEY_GET_MATCHES", entries: [], vaultLocked: true });
  });

  it("returns PASSKEY_SIGN_ASSERTION vault-locked when no encryption key", async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chromeMock = installChromeMock();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );

    await loadBackground();

    const handler = messageHandlers[0];

    const res = await new Promise((resolve) => {
      handler(
        {
          type: "PASSKEY_SIGN_ASSERTION",
          entryId: "entry-1",
          clientDataJSON: JSON.stringify({ type: "webauthn.get", challenge: "abc" }),
        },
        {},
        (resp) => resolve(resp),
      );
    });

    expect(res).toMatchObject({ type: "PASSKEY_SIGN_ASSERTION", ok: false });
    expect(typeof (res as { error?: string }).error).toBe("string");
  });

  it("returns PASSKEY_CREATE_CREDENTIAL vault-locked when no encryption key", async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chromeMock = installChromeMock();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );

    await loadBackground();

    const handler = messageHandlers[0];

    const res = await new Promise((resolve) => {
      handler(
        {
          type: "PASSKEY_CREATE_CREDENTIAL",
          rpId: "example.com",
          rpName: "Example",
          userId: "user-handle",
          userName: "alice",
          userDisplayName: "Alice",
          excludeCredentialIds: [],
          clientDataJSON: JSON.stringify({ type: "webauthn.create", challenge: "xyz" }),
        },
        {},
        (resp) => resolve(resp),
      );
    });

    expect(res).toMatchObject({ type: "PASSKEY_CREATE_CREDENTIAL", ok: false });
    expect(typeof (res as { error?: string }).error).toBe("string");
  });
});

describe("CHECK_PENDING_SAVE host validation", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chromeMock = installChromeMock();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes(EXT_API_PATH.EXTENSION_TOKEN_REFRESH)) {
          return {
            ok: true,
            json: async () => ({
              token: "refreshed-tok",
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
              scope: ["passwords:read", "vault:unlock-data"],
            }),
          };
        }
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_DATA)) {
          return {
            ok: true,
            json: async () => ({
              userId: "user-1",
              accountSalt: "00",
              encryptedSecretKey: "aa",
              secretKeyIv: "bb",
              secretKeyAuthTag: "cc",
              verificationArtifact: { ciphertext: "11", iv: "22", authTag: "33" },
            }),
          };
        }
        if (url.includes(EXT_API_PATH.PASSWORDS)) {
          return {
            ok: true,
            json: async () => [
              {
                id: "pw-1",
                encryptedOverview: { ciphertext: "11", iv: "22", authTag: "33" },
                entryType: EXT_ENTRY_TYPE.LOGIN,
                aadVersion: 1,
              },
            ],
          };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );

    await loadBackground();

    // Unlock vault
    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });
  });

  async function createPendingSave(tabId: number, host: string): Promise<void> {
    // Send LOGIN_DETECTED from a URL that won't match cached entries
    // (cached entries have urlHost: "example.com" from decryptData mock).
    // Use a unique host so handleLoginDetected returns action: "save".
    const sender = { tab: { id: tabId, url: `https://${host}/login` } };
    await sendMessageWithSender(
      { type: "LOGIN_DETECTED", url: `https://${host}/login`, username: "alice", password: "pw" },
      sender,
    );
  }

  it("returns pending data when sender host matches", async () => {
    await createPendingSave(42, "nomatch.test");

    const res = await sendMessageWithSender(
      { type: "CHECK_PENDING_SAVE" },
      { tab: { id: 42, url: "https://nomatch.test/dashboard" } },
    );

    expect(res).toEqual(
      expect.objectContaining({
        type: "CHECK_PENDING_SAVE",
        action: "save",
        host: "nomatch.test",
        username: "alice",
        password: "pw",
      }),
    );
  });

  it("returns 'none' when sender host does not match", async () => {
    await createPendingSave(42, "nomatch.test");

    const res = await sendMessageWithSender(
      { type: "CHECK_PENDING_SAVE" },
      { tab: { id: 42, url: "https://evil.com/phishing" } },
    );

    expect(res).toEqual(
      expect.objectContaining({
        type: "CHECK_PENDING_SAVE",
        action: "none",
      }),
    );
  });

  it("returns 'none' when sender has no tab URL", async () => {
    await createPendingSave(42, "nomatch.test");

    const res = await sendMessageWithSender(
      { type: "CHECK_PENDING_SAVE" },
      { tab: { id: 42 } },
    );

    expect(res).toEqual(
      expect.objectContaining({
        type: "CHECK_PENDING_SAVE",
        action: "none",
      }),
    );
  });

  it("returns 'none' when sender has no tab", async () => {
    await createPendingSave(42, "nomatch.test");

    const res = await sendMessageWithSender(
      { type: "CHECK_PENDING_SAVE" },
      {},
    );

    expect(res).toEqual(
      expect.objectContaining({
        type: "CHECK_PENDING_SAVE",
        action: "none",
      }),
    );
  });
});

describe("LOGIN_DETECTED suppresses on own app", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chromeMock = installChromeMock();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes(EXT_API_PATH.EXTENSION_TOKEN_REFRESH)) {
          return {
            ok: true,
            json: async () => ({
              token: "refreshed-tok",
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
              scope: ["passwords:read", "vault:unlock-data"],
            }),
          };
        }
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_DATA)) {
          return {
            ok: true,
            json: async () => ({
              userId: "user-1",
              accountSalt: "00",
              encryptedSecretKey: "aa",
              secretKeyIv: "bb",
              secretKeyAuthTag: "cc",
              verificationArtifact: { ciphertext: "11", iv: "22", authTag: "33" },
            }),
          };
        }
        if (url.includes(EXT_API_PATH.PASSWORDS)) {
          return {
            ok: true,
            json: async () => [
              {
                id: "pw-1",
                encryptedOverview: { ciphertext: "11", iv: "22", authTag: "33" },
                entryType: EXT_ENTRY_TYPE.LOGIN,
                aadVersion: 1,
              },
            ],
          };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );

    await loadBackground();

    // Unlock vault
    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });
  });

  it("returns action 'none' when login is detected on own app pages", async () => {
    const res = await sendMessageWithSender(
      { type: "LOGIN_DETECTED", url: "https://localhost:3000/ja/auth/signin", username: "user", password: "pass" },
      { tab: { id: 99, url: "https://localhost:3000/ja/auth/signin" } },
    );

    expect(res).toEqual(
      expect.objectContaining({
        type: "LOGIN_DETECTED",
        action: "none",
      }),
    );
  });

  it("does not suppress login on non-app URLs", async () => {
    const res = await sendMessageWithSender(
      { type: "LOGIN_DETECTED", url: "https://external-site.com/login", username: "user", password: "pass" },
      { tab: { id: 100, url: "https://external-site.com/login" } },
    );

    expect(res).toEqual(
      expect.objectContaining({
        type: "LOGIN_DETECTED",
        action: "save",
      }),
    );
  });

  it("rejects SAVE_LOGIN from own app pages", async () => {
    const res = await sendMessageWithSender(
      { type: "SAVE_LOGIN", username: "user", password: "pass" },
      { tab: { id: 101, url: "https://localhost:3000/ja/auth/signin" } },
    );

    expect(res).toEqual(
      expect.objectContaining({
        type: "SAVE_LOGIN",
        ok: false,
        error: "OWN_APP",
      }),
    );
  });

  it("rejects UPDATE_LOGIN from own app pages", async () => {
    const res = await sendMessageWithSender(
      { type: "UPDATE_LOGIN", entryId: "pw-1", password: "new-pass" },
      { tab: { id: 102, url: "https://localhost:3000/ja/dashboard" } },
    );

    expect(res).toEqual(
      expect.objectContaining({
        type: "UPDATE_LOGIN",
        ok: false,
        error: "OWN_APP",
      }),
    );
  });
});

describe("PASSKEY handlers suppress on own app", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chromeMock = installChromeMock();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes(EXT_API_PATH.EXTENSION_TOKEN_REFRESH)) {
          return {
            ok: true,
            json: async () => ({
              token: "refreshed-tok",
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
              scope: ["passwords:read", "vault:unlock-data"],
            }),
          };
        }
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_DATA)) {
          return {
            ok: true,
            json: async () => ({
              userId: "user-1",
              accountSalt: "00",
              encryptedSecretKey: "aa",
              secretKeyIv: "bb",
              secretKeyAuthTag: "cc",
              verificationArtifact: { ciphertext: "11", iv: "22", authTag: "33" },
            }),
          };
        }
        if (url.includes(EXT_API_PATH.PASSWORDS)) {
          return {
            ok: true,
            json: async () => [
              {
                id: "pw-1",
                encryptedOverview: { ciphertext: "11", iv: "22", authTag: "33" },
                entryType: EXT_ENTRY_TYPE.LOGIN,
                aadVersion: 1,
              },
            ],
          };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );

    await loadBackground();

    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });
  });

  it("returns suppressed for PASSKEY_GET_MATCHES on own app", async () => {
    const res = await sendMessageWithSender(
      { type: "PASSKEY_GET_MATCHES", rpId: "localhost" },
      { tab: { id: 200, url: "https://localhost:3000/ja/dashboard/settings/security/passkey" } },
    );
    expect(res).toEqual(
      expect.objectContaining({
        type: "PASSKEY_GET_MATCHES",
        entries: [],
        suppressed: true,
      }),
    );
  });

  it("returns suppressed for PASSKEY_CHECK_DUPLICATE on own app", async () => {
    const res = await sendMessageWithSender(
      { type: "PASSKEY_CHECK_DUPLICATE", rpId: "localhost", userName: "user@example.com" },
      { tab: { id: 201, url: "https://localhost:3000/ja/dashboard/settings/security/passkey" } },
    );
    expect(res).toEqual(
      expect.objectContaining({
        type: "PASSKEY_CHECK_DUPLICATE",
        exists: false,
        suppressed: true,
      }),
    );
  });

  it("does not suppress PASSKEY_GET_MATCHES on external URLs", async () => {
    const res = await sendMessageWithSender(
      { type: "PASSKEY_GET_MATCHES", rpId: "external.com" },
      { tab: { id: 202, url: "https://external.com/login" } },
    );
    expect(res).not.toHaveProperty("suppressed", true);
  });
});

describe("tab event badge updates", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    // Restore crypto mocks cleared by vi.clearAllMocks()
    cryptoMocks.deriveWrappingKey.mockResolvedValue("wrap-key");
    cryptoMocks.unwrapSecretKey.mockResolvedValue(new Uint8Array([1, 2, 3]));
    cryptoMocks.deriveEncryptionKey.mockResolvedValue("enc-key");
    cryptoMocks.verifyKey.mockResolvedValue(true);
    cryptoMocks.decryptData.mockResolvedValue(
      JSON.stringify({ title: "Example", username: "alice", urlHost: "example.com" }),
    );
    cryptoMocks.buildPersonalEntryAAD.mockReturnValue(new Uint8Array([1, 2]));
    cryptoMocks.hexDecode.mockReturnValue(new Uint8Array([0, 1]));
    chromeMock = installChromeMock();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes(EXT_API_PATH.EXTENSION_TOKEN_REFRESH)) {
          return {
            ok: true,
            json: async () => ({
              token: "refreshed-tok",
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
              scope: ["passwords:read", "vault:unlock-data"],
            }),
          };
        }
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_DATA)) {
          return {
            ok: true,
            json: async () => ({
              userId: "user-1",
              accountSalt: "00",
              encryptedSecretKey: "aa",
              secretKeyIv: "bb",
              secretKeyAuthTag: "cc",
              verificationArtifact: { ciphertext: "11", iv: "22", authTag: "33" },
            }),
          };
        }
        if (url.includes(EXT_API_PATH.PASSWORDS)) {
          return {
            ok: true,
            json: async () => [
              {
                id: "pw-1",
                encryptedOverview: { ciphertext: "11", iv: "22", authTag: "33" },
                entryType: EXT_ENTRY_TYPE.LOGIN,
                aadVersion: 1,
              },
            ],
          };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );

    await loadBackground();

    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    // Populate cache by fetching entries
    await sendMessage({ type: "FETCH_PASSWORDS" });
    // Wait for fire-and-forget badge update triggered by FETCH_PASSWORDS to settle,
    // then clear mock call history so tests start with a clean slate.
    await new Promise((r) => setTimeout(r, 50));
    chromeMock?.action.setBadgeText.mockClear();
    chromeMock?.action.setBadgeBackgroundColor.mockClear();
  });

  it("updates badge on tab activation", async () => {
    // tabs.get returns the tab info for the activated tab
    chromeMock!.tabs.get.mockResolvedValueOnce({ id: 42, url: "https://github.com" });

    const handler = tabActivatedHandlers[0];
    handler({ tabId: 42, windowId: 1 });

    await vi.waitFor(() => {
      expect(chromeMock?.action.setBadgeText).toHaveBeenCalledWith({ text: "", tabId: 42 });
    });
  });

  it("clears badge on tab navigation loading", async () => {
    const handler = tabUpdatedHandlers[0];
    handler(55, { status: "loading" }, { id: 55, url: "https://new-site.com" });

    await vi.waitFor(() => {
      expect(chromeMock?.action.setBadgeText).toHaveBeenCalledWith({ text: "", tabId: 55 });
    });
  });

  it("shows match count and blue badge for matching tab", async () => {
    // Cached entries have urlHost "example.com" — navigate to matching site
    const handler = tabUpdatedHandlers[0];
    handler(55, { status: "complete" }, { id: 55, url: "https://example.com/login" });

    await vi.waitFor(() => {
      expect(chromeMock?.action.setBadgeText).toHaveBeenCalledWith({ text: "1", tabId: 55 });
      expect(chromeMock?.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: "#3B82F6", tabId: 55 });
    });
  });

  it("shows empty badge for non-matching tab", async () => {
    const handler = tabUpdatedHandlers[0];
    handler(55, { status: "complete" }, { id: 55, url: "https://no-match-site.com" });

    await vi.waitFor(() => {
      expect(chromeMock?.action.setBadgeText).toHaveBeenCalledWith({ text: "", tabId: 55 });
    });
  });
});
