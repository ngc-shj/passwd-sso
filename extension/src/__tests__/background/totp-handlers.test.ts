import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  EXT_ENTRY_TYPE,
} from "../../lib/constants";
import { EXT_API_PATH, extApiPath } from "../../lib/api-paths";

const PASSWORD_BY_ID_PREFIX = extApiPath.passwordById("");

const totpMock = vi.hoisted(() => ({
  generateTOTPCode: vi.fn().mockReturnValue("123456"),
}));

vi.mock("../../lib/totp", () => totpMock);

const cryptoMocks = vi.hoisted(() => ({
  deriveWrappingKey: vi.fn().mockResolvedValue("wrap-key"),
  unwrapSecretKey: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  deriveEncryptionKey: vi.fn().mockResolvedValue("enc-key"),
  verifyKey: vi.fn().mockResolvedValue(true),
  decryptData: vi.fn().mockResolvedValue(
    JSON.stringify({ title: "Example", username: "alice", urlHost: "example.com" }),
  ),
  buildPersonalEntryAAD: vi.fn().mockReturnValue(new Uint8Array([1, 2])),
  hexDecode: vi.fn().mockReturnValue(new Uint8Array([0, 1])),
}));

vi.mock("../../lib/crypto", () => cryptoMocks);

type MessageHandler = (
  message: unknown,
  sender: unknown,
  sendResponse: (resp: unknown) => void,
) => boolean | void;

let messageHandlers: MessageHandler[] = [];
let chromeMock: ReturnType<typeof installChromeMock> | null = null;

function installChromeMock() {
  messageHandlers = [];

  const chromeMock = {
    runtime: {
      onMessage: {
        addListener: (fn: MessageHandler) => {
          messageHandlers.push(fn);
        },
      },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
    },
    alarms: {
      onAlarm: {
        addListener: vi.fn(),
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
      onActivated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
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
        addListener: vi.fn(),
      },
    },
    commands: {
      onCommand: {
        addListener: vi.fn(),
      },
    },
  };

  vi.stubGlobal("chrome", chromeMock);
  return chromeMock;
}

async function loadBackground() {
  await import("../../background/index");
}

function sendMsg(message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const handler = messageHandlers[0];
    handler(message, { tab: { id: 1 } }, (resp) => resolve(resp));
  });
}

async function unlockVault() {
  await sendMsg({
    type: "SET_TOKEN",
    token: "t",
    expiresAt: Date.now() + 60_000,
  });
  await sendMsg({ type: "UNLOCK_VAULT", passphrase: "pw" });
}

describe("COPY_TOTP handler", () => {
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
      }),
    );

    await loadBackground();
  });

  it("returns VAULT_LOCKED when vault is not unlocked", async () => {
    const res = await sendMsg({ type: "COPY_TOTP", entryId: "pw-1" });
    expect(res).toEqual({
      type: "COPY_TOTP",
      code: null,
      error: "VAULT_LOCKED",
    });
  });

  it("returns TOTP code when blob contains totp data", async () => {
    vi.spyOn(Date, "now").mockReturnValue(59_000);
    cryptoMocks.decryptData.mockResolvedValueOnce(
      JSON.stringify({ totp: { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 } }),
    );
    await unlockVault();

    const res = await sendMsg({ type: "COPY_TOTP", entryId: "pw-1" });
    expect(res).toEqual({
      type: "COPY_TOTP",
      code: "123456",
    });
    expect(totpMock.generateTOTPCode).toHaveBeenCalledWith({
      secret: "JBSWY3DPEHPK3PXP",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    });
  });

  it("returns NO_TOTP when blob has no totp data", async () => {
    cryptoMocks.decryptData.mockResolvedValueOnce(
      JSON.stringify({ password: "secret" }),
    );
    await unlockVault();

    const res = await sendMsg({ type: "COPY_TOTP", entryId: "pw-1" });
    expect(res).toEqual({
      type: "COPY_TOTP",
      code: null,
      error: "NO_TOTP",
    });
  });

  it("returns INVALID_TOTP when generateTOTPCode throws", async () => {
    cryptoMocks.decryptData.mockResolvedValueOnce(
      JSON.stringify({ totp: { secret: "JBSWY3DPEHPK3PXP", digits: 99 } }),
    );
    totpMock.generateTOTPCode.mockImplementationOnce(() => {
      throw new Error("INVALID_TOTP");
    });
    await unlockVault();

    const res = await sendMsg({ type: "COPY_TOTP", entryId: "pw-1" });
    expect(res).toEqual({
      type: "COPY_TOTP",
      code: null,
      error: "INVALID_TOTP",
    });
  });
});

describe("AUTOFILL with TOTP", () => {
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
      }),
    );

    await loadBackground();
  });

  it("includes totpCode in content-script message when totp exists", async () => {
    cryptoMocks.decryptData
      .mockResolvedValueOnce(
        JSON.stringify({
          password: "secret",
          totp: { secret: "JBSWY3DPEHPK3PXP" },
        }),
      )
      .mockResolvedValueOnce(JSON.stringify({ username: "alice" }));
    totpMock.generateTOTPCode.mockReturnValue("654321");

    await unlockVault();

    const res = await sendMsg({ type: "AUTOFILL", entryId: "pw-1", tabId: 1 });
    expect(res).toEqual({ type: "AUTOFILL", ok: true });
    expect(chromeMock?.tabs.sendMessage).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        type: "AUTOFILL_FILL",
        username: "alice",
        password: "secret",
        totpCode: "654321",
      }),
    );
  });

  it("does not include totpCode when totp is absent", async () => {
    cryptoMocks.decryptData
      .mockResolvedValueOnce(JSON.stringify({ password: "secret" }))
      .mockResolvedValueOnce(JSON.stringify({ username: "alice" }));

    await unlockVault();

    const res = await sendMsg({ type: "AUTOFILL", entryId: "pw-1", tabId: 1 });
    expect(res).toEqual({ type: "AUTOFILL", ok: true });
    const msgCall = chromeMock?.tabs.sendMessage.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "AUTOFILL_FILL",
    );
    expect(msgCall?.[1]).not.toHaveProperty("totpCode");
  });

  it("continues autofill without totpCode when generateTOTPCode throws", async () => {
    cryptoMocks.decryptData
      .mockResolvedValueOnce(
        JSON.stringify({
          password: "secret",
          totp: { secret: "JBSWY3DPEHPK3PXP", digits: 99 },
        }),
      )
      .mockResolvedValueOnce(JSON.stringify({ username: "alice" }));
    totpMock.generateTOTPCode.mockImplementationOnce(() => {
      throw new Error("INVALID_TOTP");
    });

    await unlockVault();

    const res = await sendMsg({ type: "AUTOFILL", entryId: "pw-1", tabId: 1 });
    expect(res).toEqual({ type: "AUTOFILL", ok: true });
    expect(chromeMock?.tabs.sendMessage).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        type: "AUTOFILL_FILL",
        username: "alice",
        password: "secret",
      }),
    );
    const msgCall = chromeMock?.tabs.sendMessage.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "AUTOFILL_FILL",
    );
    expect(msgCall?.[1]).not.toHaveProperty("totpCode");
  });
});
