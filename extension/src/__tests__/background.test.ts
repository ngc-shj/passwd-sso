import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ALARM_VAULT_LOCK,
  ALARM_TOKEN_REFRESH,
  ALARM_TOKEN_TTL,
  CMD_TRIGGER_AUTOFILL,
  EXT_ENTRY_TYPE,
  DISCONNECT_REASON_KEY,
} from "../lib/constants";
import { DISCONNECT_REASON } from "../lib/disconnect-reason";
import { EXT_API_PATH, extApiPath } from "../lib/api-paths";
import type { SessionState } from "../lib/session-storage";

const PASSWORD_BY_ID_PREFIX = extApiPath.passwordById("");

// Static 43-char base64url JKT used across all DPoP-related tests
const STATIC_TEST_JKT = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

const sessionStorageMocks = vi.hoisted(() => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
  loadSession: vi.fn().mockResolvedValue(null),
  clearSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/session-storage", () => sessionStorageMocks);

const dpopKeyMocks = vi.hoisted(() => ({
  getDpopThumbprint: vi.fn().mockResolvedValue("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"),
  signDpopProof: vi.fn().mockResolvedValue("fake.dpop.proof"),
  getOrGenerateDpopKeyPair: vi.fn().mockResolvedValue({
    publicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    sign: vi.fn().mockResolvedValue(new ArrayBuffer(64)),
  }),
  resetInMemoryKeyCache: vi.fn(),
}));

vi.mock("../lib/dpop-key", () => dpopKeyMocks);

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
  VAULT_TYPE: { BLOB: "blob", OVERVIEW: "overview" },
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
      session: (() => {
        // Store-backed so disconnect-reason record/read round-trips work
        // (the session-storage module itself is mocked separately above).
        const store: Record<string, unknown> = {};
        return {
          get: vi.fn(async (key: string) => ({ [key]: store[key] })),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            Object.assign(store, obj);
          }),
          remove: vi.fn(async (key: string) => {
            delete store[key];
          }),
          setAccessLevel: vi.fn().mockResolvedValue(undefined),
        };
      })(),
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

let bgModule: typeof import("../background/index") | null = null;
async function loadBackground() {
  bgModule = await import("../background/index");
}
function applyToken(token: string, expiresAt: number, cnfJkt: string): void {
  if (!bgModule) throw new Error("loadBackground() must be called before applyToken()");
  bgModule.applyToken(token, expiresAt, cnfJkt);
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
    applyToken("t", Date.now() + 60_000, "");

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

  it("GET_STATUS responds even when session hydration hangs (bounded wait — popup never strands)", async () => {
    // Reload the SW with a hydrate that never settles (e.g. a wedged IndexedDB
    // read). Without the bounded wait, handleMessage would await forever and
    // GET_STATUS never returns — the popup spins on its loading state.
    vi.resetModules();
    chromeMock = installChromeMock();
    sessionStorageMocks.loadSession.mockReturnValue(new Promise(() => {}));
    vi.useFakeTimers();
    try {
      await loadBackground();

      const respPromise = sendMessage({ type: "GET_STATUS" });
      // Drive past HYDRATION_TIMEOUT_MS so the bounded wait releases.
      await vi.advanceTimersByTimeAsync(5_000);
      const status = await respPromise;

      expect(status).toEqual(
        expect.objectContaining({
          type: "GET_STATUS",
          hasToken: false,
          vaultUnlocked: false,
          expiresAt: null,
        }),
      );
    } finally {
      vi.useRealTimers();
      sessionStorageMocks.loadSession.mockResolvedValue(null);
    }
  });

  it("does not resurrect the vault key when LOCK_VAULT runs during a slow hydration (S1 race)", async () => {
    // Startup hydration restores a vault that WOULD derive encryptionKey, but
    // it is slow (parked at deriveEncryptionKey). The bounded message wait lets
    // LOCK_VAULT proceed and clear the vault; the late-completing hydration must
    // NOT re-derive the key the user just locked.
    vi.resetModules();
    chromeMock = installChromeMock();
    sessionStorageMocks.loadSession.mockResolvedValue({
      token: "hydrated-tok",
      expiresAt: 9_999_999_999_999,
      userId: "user-1",
      vaultSecretKey: "00",
      tokenCnfJkt: STATIC_TEST_JKT,
      tenantAutoLockMinutes: null,
      personalKeyVersion: 1,
    } as unknown as SessionState);
    let releaseDerive!: (k: unknown) => void;
    cryptoMocks.deriveEncryptionKey.mockReturnValue(
      new Promise((r) => {
        releaseDerive = r;
      }),
    );
    vi.useFakeTimers();
    try {
      await loadBackground();
      await vi.advanceTimersByTimeAsync(0); // park hydration at deriveEncryptionKey

      // LOCK_VAULT proceeds after the 5s bounded wait, clearing the vault.
      const lockResp = sendMessage({ type: "LOCK_VAULT" });
      await vi.advanceTimersByTimeAsync(5_000);
      await lockResp;

      // Hydration's deriveEncryptionKey now resolves — the guard must bail.
      releaseDerive("enc-key");
      await vi.advanceTimersByTimeAsync(0);

      const status = await sendMessage({ type: "GET_STATUS" });
      expect(status).toEqual(
        expect.objectContaining({ type: "GET_STATUS", vaultUnlocked: false }),
      );
    } finally {
      vi.useRealTimers();
      sessionStorageMocks.loadSession.mockResolvedValue(null);
      cryptoMocks.deriveEncryptionKey.mockResolvedValue("enc-key");
    }
  });

  it("sends stop-keepalive on LOCK_VAULT", async () => {
    applyToken("t", Date.now() + 60_000, "");
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
    applyToken("t-1", Date.now() + 60_000, "");
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const before = await sendMessage({ type: "GET_STATUS" });
    expect(before).toEqual(
      expect.objectContaining({ type: "GET_STATUS", hasToken: true, vaultUnlocked: true }),
    );

    applyToken("t-2", Date.now() + 60_000, "");

    const after = await sendMessage({ type: "GET_STATUS" });
    expect(after).toEqual(
      expect.objectContaining({ type: "GET_STATUS", hasToken: true, vaultUnlocked: false }),
    );
    expect(chromeMock?.alarms.clear).toHaveBeenCalledWith(ALARM_VAULT_LOCK);
  });

  it("returns error on invalid passphrase", async () => {
    cryptoMocks.unwrapSecretKey.mockRejectedValueOnce(new Error("bad passphrase"));
    applyToken("t", Date.now() + 60_000, "");

    const res = await sendMessage({ type: "UNLOCK_VAULT", passphrase: "bad" });
    expect(res).toEqual(
      expect.objectContaining({ type: "UNLOCK_VAULT", ok: false })
    );
  });

  it("removes persisted vault secret on LOCK_VAULT", async () => {
    applyToken("t", Date.now() + 60_000, STATIC_TEST_JKT);
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
    applyToken("t", Date.now() + 60_000, "");
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });
    expect(chromeMock?.alarms.create).not.toHaveBeenCalledWith(
      ALARM_VAULT_LOCK,
      expect.anything()
    );
  });

  it("updates auto-lock timer when settings change", async () => {
    applyToken("t", Date.now() + 60_000, "");
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
    applyToken("t", Date.now() + 60_000, "");
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
    applyToken("t", Date.now() + 60_000, "");
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });
    await vi.waitFor(() => {
      expect(chromeMock?.action.setBadgeText).toHaveBeenCalledWith({ text: "" });
      // Per-tab overrides removed (null) so global badge becomes visible
      expect(chromeMock?.action.setBadgeText).toHaveBeenCalledWith({ text: null, tabId: 1 });
    });
  });

  it("clears all tab badges on vault lock", async () => {
    applyToken("t", Date.now() + 60_000, "");
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
    applyToken("t", Date.now() + 60_000, "");
    chromeMock?.action.setBadgeText.mockClear();

    await sendMessage({ type: "CLEAR_TOKEN" });

    await vi.waitFor(() => {
      expect(chromeMock?.action.setBadgeText).toHaveBeenCalledWith({ text: "×" });
      expect(chromeMock?.action.setBadgeText).toHaveBeenCalledWith({ text: null, tabId: 1 });
    });
  });

  it("handles trigger-autofill command by requesting inline suggestions", async () => {
    applyToken("t", Date.now() + 60_000, "");
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

    applyToken("t", Date.now() + 60_000, "");
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
    applyToken("t", Date.now() + 60_000, "");
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
      "pw-1",
      "overview"
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
    applyToken("t", Date.now() + 60_000, "");
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

    applyToken("t", Date.now() + 60_000, "");
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

    applyToken("t", Date.now() + 60_000, "");
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

    applyToken("t", Date.now() + 60_000, "");
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

    applyToken("t", Date.now() + 60_000, "");
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

    applyToken("t", Date.now() + 60_000, "");
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
    applyToken("t", Date.now() + 60_000, "");
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
    applyToken("t", Date.now() + 60_000, "");
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
    applyToken("t", Date.now() + 60_000, "");
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

    applyToken("t", Date.now() + 60_000, "");
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

    applyToken("t", Date.now() + 60_000, "");
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

    applyToken("t", Date.now() + 60_000, "");
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const res = await sendMessage({ type: "AUTOFILL", entryId: "pw-1", tabId: 1 });
    // executeScript fails but sendMessage reaches the listener bundled in form-detector.ts
    expect(res).toEqual({ type: "AUTOFILL", ok: true });
  });

  it("retries direct inject without hint when args are unserializable", async () => {
    cryptoMocks.decryptData
      .mockResolvedValueOnce(JSON.stringify({ password: "secret" }))
      .mockResolvedValueOnce(JSON.stringify({ username: "alice", urlHost: "example.com" }));

    // Message-based autofill must fail so direct fallback runs.
    chromeMock?.tabs.sendMessage.mockRejectedValueOnce(
      new Error("Could not establish connection"),
    );
    // 1st call: direct fallback with hint -> unserializable, 2nd: retry with null hint
    chromeMock?.scripting.executeScript
      .mockRejectedValueOnce(new Error("Value is unserializable"))
      .mockResolvedValueOnce([]);

    applyToken("t", Date.now() + 60_000, "");
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const res = await new Promise((resolve) => {
      const handler = messageHandlers[0];
      handler(
        { type: "AUTOFILL_FROM_CONTENT", entryId: "pw-1", targetHint: { id: "user" } },
        { tab: { id: 1, url: "https://example.com/login" }, url: "https://example.com/login" },
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

  // ── T4: IDENTITY autofill forwards postalCode + structured fields ──

  it("forwards postalCode and structured identity fields on AUTOFILL_FROM_CONTENT", async () => {
    // Personal fetch-by-id returns an IDENTITY entry.
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
              id: "id-1",
              encryptedBlob: { ciphertext: "aa", iv: "bb", authTag: "cc" },
              encryptedOverview: { ciphertext: "11", iv: "22", authTag: "33" },
              entryType: EXT_ENTRY_TYPE.IDENTITY,
              aadVersion: 1,
            }),
          };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );

    cryptoMocks.decryptData
      .mockResolvedValueOnce(
        JSON.stringify({
          givenName: "Jane",
          familyName: "Doe",
          addressLine1: "123 Main St",
          city: "Springfield",
          state: "CA",
          postalCode: "90210",
          country: "US",
        }),
      )
      .mockResolvedValueOnce(JSON.stringify({ username: "Jane Doe" }));

    applyToken("t", Date.now() + 60_000, "");
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const res = await new Promise((resolve) => {
      const handler = messageHandlers[0];
      handler(
        { type: "AUTOFILL_FROM_CONTENT", entryId: "id-1" },
        { tab: { id: 1, url: "https://any-site.example/checkout" }, url: "https://any-site.example/checkout" },
        (resp) => resolve(resp),
      );
    });
    expect(res).toEqual({ type: "AUTOFILL_FROM_CONTENT", ok: true, error: undefined });

    const fillCall = chromeMock?.tabs.sendMessage.mock.calls.find(
      (c: unknown[]) =>
        (c[1] as { type?: string })?.type === "AUTOFILL_IDENTITY_FILL",
    );
    expect(fillCall).toBeDefined();
    const fillPayload = fillCall![1] as Record<string, string>;
    expect(fillPayload.postalCode).toBe("90210");
    expect(fillPayload.givenName).toBe("Jane");
    expect(fillPayload.familyName).toBe("Doe");
    expect(fillPayload.address).toBe("123 Main St");
    expect(fillPayload.city).toBe("Springfield");
    expect(fillPayload.state).toBe("CA");
    expect(fillPayload.country).toBe("US");
  });

  // ── S4: origin re-binding for content-driven LOGIN fills ──

  const stubLoginFetch = (
    overview: Record<string, unknown> = { username: "alice", urlHost: "example.com" },
  ) => {
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
              entryType: EXT_ENTRY_TYPE.LOGIN,
              aadVersion: 1,
            }),
          };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    // Reset the once-queue: vi.clearAllMocks() (beforeEach) does not clear
    // mockResolvedValueOnce values, and the sender-host fail-closed tests
    // reject before consuming their two decrypts, leaving stale queue entries.
    cryptoMocks.decryptData.mockReset();
    cryptoMocks.decryptData
      .mockResolvedValueOnce(JSON.stringify({ password: "secret", username: "alice" }))
      .mockResolvedValueOnce(JSON.stringify(overview));
  };

  it("rejects a content-driven LOGIN fill when the sender host does not match the entry host", async () => {
    stubLoginFetch({ username: "alice", urlHost: "example.com" });
    applyToken("t", Date.now() + 60_000, "");
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const res = await new Promise((resolve) => {
      const handler = messageHandlers[0];
      handler(
        { type: "AUTOFILL_FROM_CONTENT", entryId: "pw-1" },
        { tab: { id: 1, url: "https://attacker.example/phish" }, url: "https://attacker.example/phish" },
        (resp) => resolve(resp),
      );
    });
    expect(res).toEqual({
      type: "AUTOFILL_FROM_CONTENT",
      ok: false,
      error: "ORIGIN_MISMATCH",
    });
    // Password must never be sent to the content script on a host mismatch.
    const fillCall = chromeMock?.tabs.sendMessage.mock.calls.find(
      (c: unknown[]) => (c[1] as { type?: string })?.type === "AUTOFILL_FILL",
    );
    expect(fillCall).toBeUndefined();
  });

  it("rejects a content-driven fill when the sender frame has no resolvable URL", async () => {
    stubLoginFetch({ username: "alice", urlHost: "example.com" });
    applyToken("t", Date.now() + 60_000, "");
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const res = await new Promise((resolve) => {
      const handler = messageHandlers[0];
      handler(
        { type: "AUTOFILL_FROM_CONTENT", entryId: "pw-1" },
        { tab: { id: 1, url: "https://example.com/login" } },
        (resp) => resolve(resp),
      );
    });
    // No `_sender.url` (frame origin) → fail closed even though the top tab URL
    // matches: the fill is gated on the originating frame, not the top page.
    expect(res).toEqual({
      type: "AUTOFILL_FROM_CONTENT",
      ok: false,
      error: "ORIGIN_MISMATCH",
    });
  });

  it("re-binds to the sender FRAME origin, not the top-tab host", async () => {
    // Cross-origin subframe (attacker.example) embedded in a top page whose
    // host matches the entry (example.com). Binding to the frame origin must
    // reject even though the top-tab URL would match.
    stubLoginFetch({ username: "alice", urlHost: "example.com" });
    applyToken("t", Date.now() + 60_000, "");
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const res = await new Promise((resolve) => {
      const handler = messageHandlers[0];
      handler(
        { type: "AUTOFILL_FROM_CONTENT", entryId: "pw-1" },
        {
          tab: { id: 1, url: "https://example.com/login" },
          url: "https://attacker.example/iframe",
          frameId: 9,
        },
        (resp) => resolve(resp),
      );
    });
    expect(res).toEqual({
      type: "AUTOFILL_FROM_CONTENT",
      ok: false,
      error: "ORIGIN_MISMATCH",
    });
    const fillCall = chromeMock?.tabs.sendMessage.mock.calls.find(
      (c: unknown[]) => (c[1] as { type?: string })?.type === "AUTOFILL_FILL",
    );
    expect(fillCall).toBeUndefined();
  });

  it("rejects a LOGIN fill when the entry overview has no host at all (fail closed)", async () => {
    stubLoginFetch({ username: "alice" });
    applyToken("t", Date.now() + 60_000, "");
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const res = await new Promise((resolve) => {
      const handler = messageHandlers[0];
      handler(
        { type: "AUTOFILL_FROM_CONTENT", entryId: "pw-1" },
        {
          tab: { id: 1, url: "https://example.com/login" },
          url: "https://example.com/login",
        },
        (resp) => resolve(resp),
      );
    });
    expect(res).toEqual({
      type: "AUTOFILL_FROM_CONTENT",
      ok: false,
      error: "ORIGIN_MISMATCH",
    });
  });

  it("accepts a content-driven LOGIN fill matched via additionalUrlHosts", async () => {
    stubLoginFetch({
      username: "alice",
      urlHost: "primary.example",
      additionalUrlHosts: ["example.com"],
    });
    applyToken("t", Date.now() + 60_000, "");
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const res = await new Promise((resolve) => {
      const handler = messageHandlers[0];
      handler(
        { type: "AUTOFILL_FROM_CONTENT", entryId: "pw-1" },
        {
          tab: { id: 1, url: "https://example.com/login" },
          url: "https://example.com/login",
        },
        (resp) => resolve(resp),
      );
    });
    expect(res).toEqual({ type: "AUTOFILL_FROM_CONTENT", ok: true, error: undefined });
  });

  it("delivers a content-driven LOGIN fill only to the originating frame (not tab-wide)", async () => {
    stubLoginFetch({ username: "alice", urlHost: "example.com" });
    applyToken("t", Date.now() + 60_000, "");
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const res = await new Promise((resolve) => {
      const handler = messageHandlers[0];
      handler(
        { type: "AUTOFILL_FROM_CONTENT", entryId: "pw-1" },
        {
          tab: { id: 1, url: "https://example.com/login" },
          url: "https://example.com/login",
          frameId: 7,
        },
        (resp) => resolve(resp),
      );
    });
    expect(res).toEqual({ type: "AUTOFILL_FROM_CONTENT", ok: true, error: undefined });

    // The password must be delivered frame-scoped ({ frameId }), never broadcast
    // tab-wide, so a cross-origin subframe cannot capture it.
    const fillCall = chromeMock?.tabs.sendMessage.mock.calls.find(
      (c: unknown[]) => (c[1] as { type?: string })?.type === "AUTOFILL_FILL",
    );
    expect(fillCall).toBeDefined();
    expect(fillCall?.[2]).toEqual({ frameId: 7 });
    // The entry's hosts ride along so the receiving frame can self-verify origin.
    expect((fillCall?.[1] as { allowedHosts?: string[] }).allowedHosts).toEqual([
      "example.com",
    ]);
  });

  it("direct-injection fallback is frame-scoped for a content-driven fill", async () => {
    stubLoginFetch({ username: "alice", urlHost: "example.com" });
    applyToken("t", Date.now() + 60_000, "");
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    // Force the message path to fail so the executeScript fallback runs.
    chromeMock?.tabs.sendMessage.mockRejectedValueOnce(new Error("no connection"));

    const res = await new Promise((resolve) => {
      const handler = messageHandlers[0];
      handler(
        { type: "AUTOFILL_FROM_CONTENT", entryId: "pw-1" },
        {
          tab: { id: 1, url: "https://example.com/login" },
          url: "https://example.com/login",
          frameId: 7,
        },
        (resp) => resolve(resp),
      );
    });
    expect(res).toEqual({ type: "AUTOFILL_FROM_CONTENT", ok: true, error: undefined });

    // Fallback injection must target ONLY the originating frame, never all frames.
    const injectCall = chromeMock?.scripting.executeScript.mock.calls.find(
      (c: unknown[]) => "args" in (c[0] as object),
    );
    expect(injectCall?.[0]?.target).toEqual({ tabId: 1, frameIds: [7] });
  });

  it("popup AUTOFILL direct-injection fallback stays top-frame-only (no frameId, fail-safe)", async () => {
    stubLoginFetch({ username: "alice", urlHost: "example.com" });
    applyToken("t", Date.now() + 60_000, "");
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    chromeMock?.tabs.sendMessage.mockRejectedValueOnce(new Error("no connection"));

    // The real popup/context-menu path: EXT_MSG.AUTOFILL carries an explicit
    // tabId and no originating frameId (the popup is not a tab frame).
    const res = await sendMessage({ type: "AUTOFILL", entryId: "pw-1", tabId: 1 });
    expect(res).toEqual({ type: "AUTOFILL", ok: true });

    // With no known frame, the decrypted credential must NOT be injected into
    // every frame ({ allFrames: true }) — that would deliver it to a
    // cross-origin third-party iframe. Fail safe to the top frame only.
    const injectCall = chromeMock?.scripting.executeScript.mock.calls.find(
      (c: unknown[]) => "args" in (c[0] as object),
    );
    expect(injectCall?.[0]?.target).toEqual({ tabId: 1 });
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

  it("persists state to session storage after a token is set", async () => {
    const expiresAt = Date.now() + 600_000;
    applyToken("tok-1", expiresAt, STATIC_TEST_JKT);
    // userId is not set yet at token-set time, so persistState requires all 3 fields.
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
    applyToken("tok-1", Date.now() + 600_000, STATIC_TEST_JKT);
    await sendMessage({ type: "CLEAR_TOKEN" });

    expect(sessionStorageMocks.clearSession).toHaveBeenCalled();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    // swFetchAuthenticated uses Headers object; check URL and method
    const fetchCalls = fetchMock.mock.calls as [string, RequestInit][];
    const deleteCall = fetchCalls.find(
      ([url, init]) => url.includes("/api/extension/token") && init?.method === "DELETE",
    );
    expect(deleteCall).toBeDefined();
    const [, deleteInit] = deleteCall!;
    const authHeader = (deleteInit.headers as Headers).get("Authorization");
    expect(authHeader).toBe("Bearer tok-1");
  });

  it("clears refresh alarm on CLEAR_TOKEN", async () => {
    applyToken("tok-1", Date.now() + 600_000, "");
    await sendMessage({ type: "CLEAR_TOKEN" });

    expect(chromeMock?.alarms.clear).toHaveBeenCalledWith(ALARM_TOKEN_REFRESH);
  });

  it("still clears local state when revoke API fails on CLEAR_TOKEN", async () => {
    applyToken("tok-1", Date.now() + 600_000, "");
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

  it("schedules refresh alarm when a token is set", async () => {
    const expiresAt = Date.now() + 600_000;
    applyToken("tok-1", expiresAt, "");

    expect(chromeMock?.alarms.create).toHaveBeenCalledWith(
      ALARM_TOKEN_REFRESH,
      expect.objectContaining({ when: expect.any(Number) })
    );
  });

  it("records MANUAL disconnect reason on CLEAR_TOKEN", async () => {
    applyToken("tok-1", Date.now() + 600_000, STATIC_TEST_JKT);
    await sendMessage({ type: "CLEAR_TOKEN" });

    expect(chromeMock?.storage.session.set).toHaveBeenCalledWith({
      [DISCONNECT_REASON_KEY]: DISCONNECT_REASON.MANUAL,
    });
  });

  it("records EXPIRED reason when the TTL alarm fires", async () => {
    applyToken("tok-1", Date.now() + 600_000, STATIC_TEST_JKT);
    const handler = alarmHandlers[0];
    handler({ name: ALARM_TOKEN_TTL });
    await new Promise((r) => setTimeout(r, 50));

    expect(chromeMock?.storage.session.set).toHaveBeenCalledWith({
      [DISCONNECT_REASON_KEY]: DISCONNECT_REASON.EXPIRED,
    });
  });

  it("surfaces the recorded reason in GET_STATUS once disconnected", async () => {
    applyToken("tok-1", Date.now() + 600_000, STATIC_TEST_JKT);
    await sendMessage({ type: "CLEAR_TOKEN" });

    const status = await sendMessage({ type: "GET_STATUS" });
    expect(status).toEqual(
      expect.objectContaining({
        type: "GET_STATUS",
        hasToken: false,
        disconnectReason: DISCONNECT_REASON.MANUAL,
      }),
    );
  });

  it("returns EXPIRED in GET_STATUS on lazy expiry even if the reason write has not flushed", async () => {
    // Regression: the lazy-expiry branch clears the token and records the reason
    // via a fire-and-forget storage write, then reads it back in the same turn.
    // If GET_STATUS depended on that write completing, the read could race and
    // return null. Make the storage write hang forever and confirm the response
    // still carries EXPIRED (determined locally, not via storage round-trip).
    const store: Record<string, unknown> = {};
    chromeMock!.storage.session.get = vi.fn(async (key: string) => ({ [key]: store[key] }));
    chromeMock!.storage.session.set = vi.fn(() => new Promise<void>(() => {})); // never resolves

    const expiresAt = Date.now() + 60_000;
    applyToken("tok-1", expiresAt, STATIC_TEST_JKT);

    // Advance real wall-clock past expiry so the GET_STATUS lazy check fires.
    vi.useFakeTimers();
    vi.setSystemTime(expiresAt + 1_000);
    try {
      const status = await sendMessage({ type: "GET_STATUS" });
      expect(status).toEqual(
        expect.objectContaining({
          type: "GET_STATUS",
          hasToken: false,
          disconnectReason: DISCONNECT_REASON.EXPIRED,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the disconnect reason after a fresh successful connect", async () => {
    applyToken("tok-1", Date.now() + 600_000, STATIC_TEST_JKT);
    await sendMessage({ type: "CLEAR_TOKEN" });
    // Reconnect.
    applyToken("tok-2", Date.now() + 600_000, STATIC_TEST_JKT);
    await new Promise((r) => setTimeout(r, 0));

    expect(chromeMock?.storage.session.remove).toHaveBeenCalledWith(
      DISCONNECT_REASON_KEY,
    );
  });

  it("clamps refresh buffer to half-TTL for short-lived tokens (prevents refresh loop)", async () => {
    // 1-minute TTL — below the default 2-min refresh buffer.
    // Without the adaptive buffer, the alarm would fire immediately and
    // storm the refresh endpoint; with the clamp it should fire at ~30s.
    const now = Date.now();
    const expiresAt = now + 60_000; // 1 minute
    applyToken("tok-short", expiresAt, "");

    const alarmCalls = (chromeMock?.alarms.create as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([name]) => name === ALARM_TOKEN_REFRESH,
    );
    expect(alarmCalls.length).toBeGreaterThanOrEqual(1);
    const lastCall = alarmCalls[alarmCalls.length - 1];
    const when = lastCall[1].when as number;
    // Should schedule ~half-TTL before expiry (≈ 30s from now), not before `now + 5s` (the minimum-delay floor)
    // and not after `expiresAt` (the absolute deadline).
    expect(when).toBeGreaterThanOrEqual(now + 5_000);
    expect(when).toBeLessThanOrEqual(expiresAt);
    // Specifically: at or after now + 25s (half-TTL - 5s slack)
    expect(when).toBeGreaterThanOrEqual(now + 25_000);
  });

  it("uses the 2-min buffer for long-lived tokens (existing behavior)", async () => {
    const now = Date.now();
    const expiresAt = now + 10 * 60_000; // 10 minutes
    applyToken("tok-long", expiresAt, "");

    const alarmCalls = (chromeMock?.alarms.create as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([name]) => name === ALARM_TOKEN_REFRESH,
    );
    const lastCall = alarmCalls[alarmCalls.length - 1];
    const when = lastCall[1].when as number;
    // Expected ≈ expiresAt - 2min = now + 8min
    expect(when).toBeGreaterThanOrEqual(now + 8 * 60_000 - 5_000);
    expect(when).toBeLessThanOrEqual(now + 8 * 60_000 + 5_000);
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
      tokenCnfJkt: STATIC_TEST_JKT,
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

  it("restores tenantAutoLockMinutes from session storage so options UI disables the local setting", async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chromeMock = installChromeMock();

    const expiresAt = Date.now() + 600_000;
    sessionStorageMocks.loadSession.mockResolvedValueOnce({
      token: "hydrated-tok",
      expiresAt,
      userId: "u-1",
      vaultSecretKey: "010203",
      tenantAutoLockMinutes: 30,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) }))
    );

    await loadBackground();

    const status = await sendMessage({ type: "GET_STATUS" });
    expect(status).toEqual(
      expect.objectContaining({ tenantAutoLockMinutes: 30 })
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
      tokenCnfJkt: STATIC_TEST_JKT,
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
              cnfJkt: STATIC_TEST_JKT,
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
    applyToken("original-tok", Date.now() + 600_000, STATIC_TEST_JKT);
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

    applyToken("tok", Date.now() + 600_000, "");
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

    applyToken("tok", Date.now() + 600_000, "");
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

    // Should schedule a retry alarm with an absolute `when` time
    expect(chromeMock?.alarms.create).toHaveBeenCalledWith(
      ALARM_TOKEN_REFRESH,
      expect.objectContaining({ when: expect.any(Number) })
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

    applyToken("tok", Date.now() + 600_000, "");
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    chromeMock?.alarms.create.mockClear();

    const handler = alarmHandlers[0];
    handler({ name: ALARM_TOKEN_REFRESH });

    await new Promise((r) => setTimeout(r, 50));

    const status = await sendMessage({ type: "GET_STATUS" });
    expect(status).toEqual(expect.objectContaining({ hasToken: true }));

    expect(chromeMock?.alarms.create).toHaveBeenCalledWith(
      ALARM_TOKEN_REFRESH,
      expect.objectContaining({ when: expect.any(Number) })
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

    applyToken("tok", Date.now() + 600_000, "");
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    // Clear create calls from the token-set step so we can check the retry
    chromeMock?.alarms.create.mockClear();

    const handler = alarmHandlers[0];
    handler({ name: ALARM_TOKEN_REFRESH });

    await new Promise((r) => setTimeout(r, 50));

    // Token should still be valid
    const status = await sendMessage({ type: "GET_STATUS" });
    expect(status).toEqual(
      expect.objectContaining({ hasToken: true })
    );

    // Should schedule a retry alarm with an absolute `when` time
    expect(chromeMock?.alarms.create).toHaveBeenCalledWith(
      ALARM_TOKEN_REFRESH,
      expect.objectContaining({ when: expect.any(Number) })
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
      tokenCnfJkt: STATIC_TEST_JKT,
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

    applyToken("t", Date.now() + 60_000, "");
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
    // Vault is locked (no token, no UNLOCK_VAULT) — handler returns the locked-state response.
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
    applyToken("t", Date.now() + 60_000, "");
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });
  });

  async function createPendingSave(tabId: number, host: string): Promise<void> {
    // Send LOGIN_DETECTED from a URL that won't match cached entries
    // (cached entries have urlHost: "example.com" from decryptData mock).
    // Use a unique host so handleLoginDetected returns action: "save".
    // _sender.url (frame origin) drives the frameHost binding.
    const sender = {
      tab: { id: tabId, url: `https://${host}/login` },
      url: `https://${host}/login`,
    };
    await sendMessageWithSender(
      { type: "LOGIN_DETECTED", url: `https://${host}/login`, username: "alice", password: "pw" },
      sender,
    );
  }

  it("returns pending data when sender frame origin matches", async () => {
    await createPendingSave(42, "nomatch.test");

    const res = await sendMessageWithSender(
      { type: "CHECK_PENDING_SAVE" },
      { tab: { id: 42, url: "https://nomatch.test/dashboard" }, url: "https://nomatch.test/dashboard" },
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

  it("returns 'none' when sender frame origin does not match", async () => {
    await createPendingSave(42, "nomatch.test");

    const res = await sendMessageWithSender(
      { type: "CHECK_PENDING_SAVE" },
      { tab: { id: 42, url: "https://evil.com/phishing" }, url: "https://evil.com/phishing" },
    );

    expect(res).toEqual(
      expect.objectContaining({
        type: "CHECK_PENDING_SAVE",
        action: "none",
      }),
    );
  });

  it("does NOT release the pending credential to a cross-origin subframe of the same tab", async () => {
    // Top frame (nomatch.test) submitted the login; a malicious subframe
    // (attacker.example) in the same tab polls. The top-tab URL would match,
    // but the frame origin must not — and the legit pending must survive so the
    // real top frame can still pull it.
    await createPendingSave(42, "nomatch.test");

    const subframeRes = await sendMessageWithSender(
      { type: "CHECK_PENDING_SAVE" },
      { tab: { id: 42, url: "https://nomatch.test/dashboard" }, url: "https://attacker.example/iframe" },
    );
    expect(subframeRes).toEqual(
      expect.objectContaining({ type: "CHECK_PENDING_SAVE", action: "none" }),
    );

    // The legit top frame can still retrieve it (subframe poll did not consume it).
    const topRes = await sendMessageWithSender(
      { type: "CHECK_PENDING_SAVE" },
      { tab: { id: 42, url: "https://nomatch.test/dashboard" }, url: "https://nomatch.test/dashboard" },
    );
    expect(topRes).toEqual(
      expect.objectContaining({
        type: "CHECK_PENDING_SAVE",
        action: "save",
        password: "pw",
      }),
    );
  });

  it("returns 'none' when sender frame has no URL", async () => {
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
    applyToken("t", Date.now() + 60_000, "");
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
      { tab: { id: 100, url: "https://external-site.com/login" }, url: "https://external-site.com/login" },
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

    applyToken("t", Date.now() + 60_000, "");
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });
  });

  it("returns suppressed for PASSKEY_GET_MATCHES on own app", async () => {
    const res = await sendMessageWithSender(
      { type: "PASSKEY_GET_MATCHES", rpId: "localhost" },
      { tab: { id: 200, url: "https://localhost:3000/ja/dashboard/settings/auth/passkey" } },
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
      { tab: { id: 201, url: "https://localhost:3000/ja/dashboard/settings/auth/passkey" } },
    );
    expect(res).toEqual(
      expect.objectContaining({
        type: "PASSKEY_CHECK_DUPLICATE",
        entries: [],
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

  it("returns suppressed for PASSKEY_CREATE_CREDENTIAL on own app", async () => {
    const res = await sendMessageWithSender(
      {
        type: "PASSKEY_CREATE_CREDENTIAL",
        rpId: "localhost",
        rpName: "passwd-sso",
        userId: "dXNlci0x",
        userName: "user@example.com",
        userDisplayName: "User",
        excludeCredentialIds: [],
        clientDataJSON: "{}",
      },
      { tab: { id: 203, url: "https://localhost:3000/ja/dashboard/settings/auth/passkey" } },
    );
    expect(res).toEqual(
      expect.objectContaining({
        type: "PASSKEY_CREATE_CREDENTIAL",
        ok: false,
        suppressed: true,
      }),
    );
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

    applyToken("t", Date.now() + 60_000, "");
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

