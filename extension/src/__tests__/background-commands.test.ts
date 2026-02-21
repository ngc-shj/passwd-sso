import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ALARM_VAULT_LOCK,
  ALARM_TOKEN_REFRESH,
  ALARM_CLEAR_CLIPBOARD,
  CMD_TRIGGER_AUTOFILL,
  CMD_COPY_PASSWORD,
  CMD_COPY_USERNAME,
  CMD_LOCK_VAULT,
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
  decryptData: vi.fn(),
  buildPersonalEntryAAD: vi.fn().mockReturnValue(new Uint8Array([1, 2])),
  hexDecode: vi.fn().mockReturnValue(new Uint8Array([0, 1])),
}));

vi.mock("../lib/crypto", () => cryptoMocks);

type MessageHandler = (
  message: unknown,
  sender: unknown,
  sendResponse: (resp: unknown) => void,
) => boolean | void;

let messageHandlers: MessageHandler[] = [];
let alarmHandlers: Array<(alarm: { name: string }) => void> = [];
let storageChangeHandlers: Array<
  (
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
    areaName: string,
  ) => void
> = [];
let commandHandlers: Array<(command: string) => void | Promise<void>> = [];

function installChromeMock() {
  messageHandlers = [];
  alarmHandlers = [];
  storageChangeHandlers = [];
  commandHandlers = [];

  const mock = {
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
        addListener: (fn: (alarm: { name: string }) => void) => {
          alarmHandlers.push(fn);
        },
      },
      create: vi.fn(),
      clear: vi.fn().mockResolvedValue(true),
    },
    scripting: {
      executeScript: vi.fn().mockResolvedValue([]),
      registerContentScripts: vi.fn().mockResolvedValue(undefined),
      unregisterContentScripts: vi.fn().mockResolvedValue(undefined),
    },
    tabs: {
      sendMessage: vi.fn().mockResolvedValue({}),
      query: vi
        .fn()
        .mockResolvedValue([{ id: 1, url: "https://example.com" }]),
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
        get: vi.fn().mockResolvedValue({
          serverUrl: "https://localhost:3000",
          autoLockMinutes: 15,
        }),
      },
      session: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: {
        addListener: (
          fn: (
            changes: Record<
              string,
              { oldValue?: unknown; newValue?: unknown }
            >,
            areaName: string,
          ) => void,
        ) => {
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

  vi.stubGlobal("chrome", mock);
  return mock;
}

function sendMessage(message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const handler = messageHandlers[0];
    handler(message, {}, (resp) => resolve(resp));
  });
}

async function unlockVault(chromeMock: ReturnType<typeof installChromeMock>) {
  await sendMessage({
    type: "SET_TOKEN",
    token: "t",
    expiresAt: Date.now() + 60_000,
  });
  await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });
}

describe("X-4 keyboard shortcut commands", () => {
  let chromeMock: ReturnType<typeof installChromeMock>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chromeMock = installChromeMock();

    // Default decryptData mock: returns overview for list, full blob for individual
    let decryptCallCount = 0;
    cryptoMocks.decryptData.mockImplementation(async () => {
      decryptCallCount++;
      // First calls are for overview decryption (getCachedEntries)
      // Later calls are for full blob
      if (decryptCallCount <= 1) {
        return JSON.stringify({
          title: "Example",
          username: "alice",
          urlHost: "example.com",
        });
      }
      return JSON.stringify({
        title: "Example",
        username: "alice",
        password: "s3cret",
        url: "https://example.com",
      });
    });

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
        if (url.includes(PASSWORD_BY_ID_PREFIX)) {
          return {
            ok: true,
            json: async () => ({
              id: "pw-1",
              encryptedBlob: { ciphertext: "aa", iv: "bb", authTag: "cc" },
              encryptedOverview: {
                ciphertext: "11",
                iv: "22",
                authTag: "33",
              },
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
                encryptedOverview: {
                  ciphertext: "11",
                  iv: "22",
                  authTag: "33",
                },
                entryType: EXT_ENTRY_TYPE.LOGIN,
                aadVersion: 1,
              },
            ],
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
              verificationArtifact: {
                ciphertext: "11",
                iv: "22",
                authTag: "33",
              },
            }),
          };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );

    await import("../background/index");
  });

  it("copy-password copies password to clipboard via executeScript", async () => {
    await unlockVault(chromeMock);

    const handler = commandHandlers[0];
    await handler(CMD_COPY_PASSWORD);

    expect(chromeMock.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 1 },
        world: "ISOLATED",
        args: ["s3cret"],
      }),
    );
  });

  it("copy-username copies username to clipboard via executeScript", async () => {
    await unlockVault(chromeMock);

    const handler = commandHandlers[0];
    await handler(CMD_COPY_USERNAME);

    expect(chromeMock.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 1 },
        world: "ISOLATED",
        args: ["alice"],
      }),
    );
  });

  it("lock-vault clears vault state", async () => {
    await unlockVault(chromeMock);

    const statusBefore = await sendMessage({ type: "GET_STATUS" });
    expect(statusBefore).toEqual(
      expect.objectContaining({ vaultUnlocked: true }),
    );

    const handler = commandHandlers[0];
    await handler(CMD_LOCK_VAULT);

    const statusAfter = await sendMessage({ type: "GET_STATUS" });
    expect(statusAfter).toEqual(
      expect.objectContaining({ vaultUnlocked: false }),
    );
  });

  it("copy-password schedules clipboard clear alarm", async () => {
    await unlockVault(chromeMock);

    const handler = commandHandlers[0];
    await handler(CMD_COPY_PASSWORD);

    expect(chromeMock.alarms.create).toHaveBeenCalledWith(
      ALARM_CLEAR_CLIPBOARD,
      { delayInMinutes: 1 },
    );
  });

  it("copy-password does nothing when vault is locked", async () => {
    // Don't unlock — vault is locked
    await sendMessage({
      type: "SET_TOKEN",
      token: "t",
      expiresAt: Date.now() + 60_000,
    });

    const handler = commandHandlers[0];
    await handler(CMD_COPY_PASSWORD);

    // executeScript should not be called for clipboard copy
    // (it may be called for other purposes like content script injection)
    const clipboardCalls = chromeMock.scripting.executeScript.mock.calls.filter(
      (call: unknown[]) => {
        const opts = call[0] as { world?: string };
        return opts.world === "ISOLATED";
      },
    );
    expect(clipboardCalls).toHaveLength(0);
  });

  it("copy-password does nothing when no matching entry", async () => {
    await unlockVault(chromeMock);

    // Change tab URL to non-matching host
    chromeMock.tabs.query.mockResolvedValue([
      { id: 1, url: "https://nomatch.com" },
    ]);

    const handler = commandHandlers[0];
    await handler(CMD_COPY_PASSWORD);

    const clipboardCalls = chromeMock.scripting.executeScript.mock.calls.filter(
      (call: unknown[]) => {
        const opts = call[0] as { world?: string };
        return opts.world === "ISOLATED";
      },
    );
    expect(clipboardCalls).toHaveLength(0);
  });

  it("clipboard clear alarm handler clears clipboard after delay", async () => {
    await unlockVault(chromeMock);

    // Simulate copy
    const handler = commandHandlers[0];
    await handler(CMD_COPY_PASSWORD);

    // Record executeScript calls before alarm
    const callsBefore = chromeMock.scripting.executeScript.mock.calls.length;

    // Advance time past 30s
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 31_000);

    // Fire the alarm
    const alarmHandler = alarmHandlers[0];
    alarmHandler({ name: ALARM_CLEAR_CLIPBOARD });

    // Wait for async chain (tabs.query + executeScript are async)
    await vi.waitFor(() => {
      const clearCalls = chromeMock.scripting.executeScript.mock.calls
        .slice(callsBefore)
        .filter((call: unknown[]) => {
          const opts = call[0] as { world?: string; args?: unknown[] };
          return opts.world === "ISOLATED" && opts.args?.length === 0;
        });
      expect(clearCalls).toHaveLength(1);
    });

    vi.restoreAllMocks();
  });
});
