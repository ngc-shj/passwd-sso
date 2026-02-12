import { describe, it, expect, vi, beforeEach } from "vitest";

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
        if (url.includes("/api/vault/unlock/data")) {
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
        if (url.includes("/api/passwords/")) {
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
        if (url.includes("/api/passwords")) {
          return {
            ok: true,
            json: async () => [
              {
                id: "pw-1",
                encryptedOverview: { ciphertext: "11", iv: "22", authTag: "33" },
                entryType: "LOGIN",
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
      "vault-auto-lock",
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
      "vault-auto-lock",
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
    expect(chromeMock?.alarms.clear).toHaveBeenCalledWith("vault-auto-lock");
    expect(chromeMock?.alarms.create).toHaveBeenCalledWith(
      "vault-auto-lock",
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
    expect(chromeMock?.alarms.clear).toHaveBeenCalledWith("vault-auto-lock");
  });

  it("ignores auto-lock changes while vault is locked", async () => {
    const handler = storageChangeHandlers[0];
    handler({ autoLockMinutes: { newValue: 5 } }, "local");
    expect(chromeMock?.alarms.create).not.toHaveBeenCalledWith(
      "vault-auto-lock",
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
    await handler("trigger-autofill");
    expect(chromeMock?.scripting.executeScript).toHaveBeenCalled();
  });

  it("does nothing when command has no active tab url", async () => {
    chromeMock?.tabs.query.mockResolvedValueOnce([{ id: 1, url: undefined }]);
    const handler = commandHandlers[0];
    await handler("trigger-autofill");
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
          entryType: "LOGIN",
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
      if (url.includes("/api/vault/unlock/data")) {
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

  it("returns error when AUTOFILL fetch fails", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/vault/unlock/data")) {
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
    chromeMock?.scripting.executeScript.mockRejectedValueOnce(new Error("CSP"));
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
