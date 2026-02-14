import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ALARM_VAULT_LOCK,
  ALARM_TOKEN_REFRESH,
  CMD_TRIGGER_AUTOFILL,
  EXT_ENTRY_TYPE,
  SESSION_KEY,
} from "../lib/constants";
import { EXT_API_PATH, extApiPath } from "../lib/api-paths";

const PASSWORD_BY_ID_PREFIX = extApiPath.passwordById("");

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

function installChromeMock() {
  messageHandlers = [];
  alarmHandlers = [];
  storageChangeHandlers = [];
  commandHandlers = [];

  const chromeMock = {
    runtime: {
      onMessage: {
        addListener: (fn: MessageHandler) => {
          messageHandlers.push(fn);
        },
      },
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
      query: vi.fn().mockResolvedValue([{ id: 1, url: "https://github.com" }]),
    },
    action: {
      setBadgeText: vi.fn().mockResolvedValue(undefined),
      setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
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

    expect(chromeMock?.storage.session.set).toHaveBeenCalledWith({
      authState: expect.objectContaining({
        token: "t",
        expiresAt: expect.any(Number),
      }),
    });
    const calls = (chromeMock?.storage.session.set as ReturnType<typeof vi.fn>).mock.calls;
    const lastState = calls[calls.length - 1]?.[0]?.authState as {
      userId?: string;
      vaultSecretKey?: string;
    };
    expect(lastState.userId).toBeUndefined();
    expect(lastState.vaultSecretKey).toBeUndefined();
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
    expect(chromeMock?.scripting.registerContentScripts).not.toHaveBeenCalled();
  });

  it("updates badge when token is set and vault unlocked", async () => {
    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });
    expect(chromeMock?.action.setBadgeText).toHaveBeenCalledWith({ text: "" });
  });

  it("handles trigger-autofill command with url match", async () => {
    cryptoMocks.decryptData
      .mockResolvedValueOnce(JSON.stringify({ title: "GitHub", username: "alice", urlHost: "github.com" }))
      .mockResolvedValueOnce(JSON.stringify({ password: "secret" }))
      .mockResolvedValueOnce(JSON.stringify({ username: "alice" }));

    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });
    await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });

    const handler = commandHandlers[0];
    await handler(CMD_TRIGGER_AUTOFILL);
    expect(chromeMock?.scripting.executeScript).toHaveBeenCalled();
  });

  it("does nothing when command has no active tab url", async () => {
    chromeMock?.tabs.query.mockResolvedValueOnce([{ id: 1, url: undefined }]);
    const handler = commandHandlers[0];
    await handler(CMD_TRIGGER_AUTOFILL);
    expect(chromeMock?.scripting.executeScript).not.toHaveBeenCalled();
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
    expect(chromeMock?.scripting.executeScript).toHaveBeenCalled();
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

  it("includes AWS fields from custom fields when available", async () => {
    cryptoMocks.decryptData
      .mockResolvedValueOnce(
        JSON.stringify({
          password: "secret",
          customFields: [
            { label: "AWS Account ID / Alias", value: "123456789012" },
            { label: "IAM username", value: "alice-iam" },
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
    expect(chromeMock?.tabs.sendMessage).toHaveBeenCalledWith(1, {
      type: "AUTOFILL_FILL",
      username: "alice",
      password: "secret",
      awsAccountIdOrAlias: "123456789012",
      awsIamUsername: "alice-iam",
    });
  });

  it("suppresses inline matches on passwd-sso app pages", async () => {
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
      url: "https://localhost:3000/ja/dashboard",
    });

    expect(res).toEqual({
      type: "GET_MATCHES_FOR_URL",
      entries: [],
      vaultLocked: false,
      suppressInline: true,
    });
  });

  it("does not suppress inline matches when origin differs from serverUrl", async () => {
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

  it("returns error when AUTOFILL script injection fails", async () => {
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
    expect(res).toEqual({ type: "AUTOFILL", ok: false, error: "CSP" });
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

    expect(chromeMock?.storage.session.set).toHaveBeenCalledWith({
      authState: expect.objectContaining({
        token: "tok-1",
        userId: "user-1",
      }),
    });
  });

  it("clears session storage on CLEAR_TOKEN", async () => {
    await sendMessage({
      type: "SET_TOKEN",
      token: "tok-1",
      expiresAt: Date.now() + 600_000,
    });
    await sendMessage({ type: "CLEAR_TOKEN" });

    expect(chromeMock?.storage.session.remove).toHaveBeenCalledWith(SESSION_KEY);
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
    chromeMock.storage.session.get.mockResolvedValue({
      authState: {
        token: "hydrated-tok",
        expiresAt,
        userId: "u-1",
        vaultSecretKey: "010203",
      },
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

    chromeMock.storage.session.get.mockResolvedValue({
      authState: { token: "old-tok", expiresAt: Date.now() - 1000, userId: "u-1" },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) }))
    );

    await loadBackground();

    expect(chromeMock.storage.session.remove).toHaveBeenCalledWith(SESSION_KEY);

    const status = await sendMessage({ type: "GET_STATUS" });
    expect(status).toEqual(
      expect.objectContaining({ hasToken: false })
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

    // Verify session storage was updated with new token
    expect(chromeMock?.storage.session.set).toHaveBeenCalledWith({
      authState: expect.objectContaining({
        token: "refreshed-tok",
        userId: "user-1",
      }),
    });
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

  it("retries on network error if TTL remains", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes(EXT_API_PATH.EXTENSION_TOKEN_REFRESH)) {
          throw new Error("NetworkError");
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
