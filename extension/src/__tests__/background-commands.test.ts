import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ALARM_CLEAR_CLIPBOARD,
  CMD_COPY_PASSWORD,
  CMD_COPY_USERNAME,
  CMD_LOCK_VAULT,
  EXT_ENTRY_TYPE,
} from "../lib/constants";
import { EXT_API_PATH, extApiPath } from "../lib/api-paths";
import { holdNextCall } from "./helpers/deferred";
import { createKeyedDecryptMock } from "./helpers/keyed-decrypt-mock";

const PASSWORD_BY_ID_PREFIX = extApiPath.passwordById("");

const cryptoMocks = vi.hoisted(() => ({
  deriveWrappingKey: vi.fn().mockResolvedValue("wrap-key"),
  unwrapSecretKey: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  deriveEncryptionKey: vi.fn().mockResolvedValue("enc-key"),
  deriveAuthKeyBytes: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
  computeAuthHash: vi.fn().mockResolvedValue("fake-auth-hash"),
  verifyKey: vi.fn().mockResolvedValue(true),
  decryptData: vi.fn(),
  buildPersonalEntryAAD: vi.fn().mockReturnValue(new Uint8Array([1, 2])),
  hexDecode: vi.fn().mockReturnValue(new Uint8Array([0, 1])),
  VAULT_TYPE: { BLOB: "blob", OVERVIEW: "overview" },
}));

vi.mock("../lib/crypto", () => cryptoMocks);

const keyedDecrypt = createKeyedDecryptMock(cryptoMocks.decryptData);
const OVERVIEW_PLAINTEXT = JSON.stringify({ title: "Example", username: "alice", urlHost: "example.com" });

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
      sendMessage: vi.fn().mockResolvedValue({ ok: true }),
      getContexts: vi.fn().mockResolvedValue([]),
      getURL: vi.fn((path: string) => `chrome-extension://test-extension-id/${path}`),
    },
    offscreen: {
      createDocument: vi.fn().mockResolvedValue(undefined),
      Reason: { CLIPBOARD: "CLIPBOARD" },
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
      create: vi.fn((_props: unknown, cb?: () => void) => cb?.()),
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

// Every message this file drives through handleMessage is extension-page-only
// (UNLOCK_VAULT, LOCK_VAULT, GET_STATUS, ...), so the default sender is an
// extension page — otherwise C5's sender gate refuses it before it does
// anything.
function sendMessage(message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const handler = messageHandlers[0];
    handler(message, { url: chrome.runtime.getURL("popup/index.html") }, (resp) => resolve(resp));
  });
}

let bgModule: typeof import("../background/index") | null = null;
function applyToken(token: string, expiresAt: number, cnfJkt: string): void {
  if (!bgModule) throw new Error("background module must be loaded before applyToken()");
  bgModule.applyToken(token, expiresAt, cnfJkt);
}

async function unlockVault(chromeMock: ReturnType<typeof installChromeMock>) {
  applyToken("t", Date.now() + 60_000, "");
  await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" });
}

describe("X-4 keyboard shortcut commands", () => {
  let chromeMock: ReturnType<typeof installChromeMock>;

  // `vi.clearAllMocks()` in beforeEach clears call history but leaves a spy
  // installed, so a console spy from one test would silence console for every
  // later test in the file. Same reasoning as the two autofill test files.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chromeMock = installChromeMock();

    // Keyed on the ciphertext (#784): the unlock's fire-and-forget context-menu
    // rebuild also decrypts the overview, so a call-order queue let it take the
    // overview's slot under load and hand the command the blob instead.
    keyedDecrypt.install({
      "11": OVERVIEW_PLAINTEXT,
      aa: JSON.stringify({
        title: "Example",
        username: "alice",
        password: "s3cret",
        url: "https://example.com",
      }),
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
        if (url.includes(EXT_API_PATH.VAULT_UNLOCK_VERIFY)) {
          return { ok: true, status: 200, json: async () => ({ verified: true }) };
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

    bgModule = await import("../background/index");
  });

  it("copy-password copies password to clipboard via offscreen document", async () => {
    await unlockVault(chromeMock);

    const handler = commandHandlers[0];
    await handler(CMD_COPY_PASSWORD);

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      target: "offscreen",
      type: "clipboard-write",
      text: "s3cret",
    });
  });

  // V8 embeds a window of the INPUT in a JSON.parse SyntaxError, and the input on
  // this path is decrypted vault plaintext. Before the parse was narrowed, the error
  // fell through to `console.warn("[psso] copy command failed:", err)` and printed a
  // prefix of the password into the service-worker console.
  it("does not print decrypted plaintext when the blob is not valid JSON", async () => {
    await unlockVault(chromeMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Corrupt the individual blob ("aa"); the list overview ("11") stays valid.
    keyedDecrypt.set("aa", '{"username":"bob","password":S3cr3t-Passw0rd-VeryLong}');

    const handler = commandHandlers[0];
    await handler(CMD_COPY_PASSWORD);

    expect(chromeMock.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ target: "offscreen", type: "clipboard-write" }),
    );
    // The command still reports why it failed — warnBackground takes two closed
    // unions, so it has no slot the plaintext could occupy.
    // The exact pin is what carries the red-proof; a `not.toContain("S3cr3t")`
    // alongside it can never fail independently.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(" ")).toBe(
      "[passwd-sso] copy-command-failed: syntax-error",
    );
  });

  it("copy-username copies username to clipboard via offscreen document", async () => {
    await unlockVault(chromeMock);

    const handler = commandHandlers[0];
    await handler(CMD_COPY_USERNAME);

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      target: "offscreen",
      type: "clipboard-write",
      text: "alice",
    });
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
    applyToken("t", Date.now() + 60_000, "");

    const handler = commandHandlers[0];
    await handler(CMD_COPY_PASSWORD);

    const clipboardCalls = chromeMock.runtime.sendMessage.mock.calls.filter(
      (call: unknown[]) => {
        const msg = call[0] as { target?: string };
        return msg.target === "offscreen";
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

    const clipboardCalls = chromeMock.runtime.sendMessage.mock.calls.filter(
      (call: unknown[]) => {
        const msg = call[0] as { target?: string; type?: string };
        return msg.target === "offscreen" && msg.type === "clipboard-write";
      },
    );
    expect(clipboardCalls).toHaveLength(0);
  });

  it("copy-password does nothing when entry is not LOGIN type", async () => {
    await unlockVault(chromeMock);

    // Override fetch to return a non-LOGIN entry
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes(EXT_API_PATH.PASSWORDS)) {
          return {
            ok: true,
            json: async () => [
              {
                id: "note-1",
                encryptedOverview: {
                  ciphertext: "11",
                  iv: "22",
                  authTag: "33",
                },
                entryType: "SECURE_NOTE",
                aadVersion: 1,
              },
            ],
          };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );

    // Force cache refresh by querying status (triggers re-fetch on next command)
    await sendMessage({ type: "GET_STATUS" });

    const handler = commandHandlers[0];
    await handler(CMD_COPY_PASSWORD);

    const clipboardCalls = chromeMock.runtime.sendMessage.mock.calls.filter(
      (call: unknown[]) => {
        const msg = call[0] as { target?: string; type?: string };
        return msg.target === "offscreen" && msg.type === "clipboard-write";
      },
    );
    expect(clipboardCalls).toHaveLength(0);
  });

  it("clipboard clear alarm handler clears clipboard after delay", async () => {
    await unlockVault(chromeMock);

    // Simulate copy
    const handler = commandHandlers[0];
    await handler(CMD_COPY_PASSWORD);

    // Record sendMessage calls before alarm
    const callsBefore = chromeMock.runtime.sendMessage.mock.calls.length;

    // Advance time past 30s
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 31_000);

    // Fire the alarm
    const alarmHandler = alarmHandlers[0];
    alarmHandler({ name: ALARM_CLEAR_CLIPBOARD });

    // Wait for async chain (offscreen createDocument + sendMessage)
    await vi.waitFor(() => {
      const clearCalls = chromeMock.runtime.sendMessage.mock.calls
        .slice(callsBefore)
        .filter((call: unknown[]) => {
          const msg = call[0] as { target?: string; text?: string };
          return msg.target === "offscreen" && msg.text === "";
        });
      expect(clearCalls).toHaveLength(1);
    });

    vi.restoreAllMocks();
  });
  // #885 A9: the copy commands assert the vault epoch inside copyToClipboard,
  // after the offscreen document is ready — the last await before the write.
  describe("copy commands across a lock (#885 A9)", () => {
    // Keyed on the ciphertext, not the call order: whichever of the command
    // and the unlock's context-menu rebuild decrypts first, the overview ("11")
    // and the blob ("aa") each get their own plaintext — no settling needed.
    beforeEach(() => {
      cryptoMocks.decryptData.mockImplementation(async ({ ciphertext }: { ciphertext: string }) =>
        JSON.stringify(
          ciphertext === "aa"
            ? { title: "Example", username: "alice", password: "s3cret", url: "https://example.com" }
            : { title: "Example", username: "alice", urlHost: "example.com" },
        ),
      );
    });

    // copyToClipboard's offscreen check is the only getContexts caller; the
    // match names its query so no other call could take the hold.
    const holdOffscreenCheck = () =>
      holdNextCall(chromeMock.runtime.getContexts, (query: { contextTypes?: string[] }) =>
        query?.contextTypes?.includes("OFFSCREEN_DOCUMENT") === true);
    const writesOf = (text: string) =>
      (chromeMock.runtime.sendMessage.mock.calls as unknown[][]).filter(
        ([msg]) => (msg as { type?: string; text?: string }).type === "clipboard-write" &&
          (msg as { text?: string }).text === text,
      );

    // A lock, or a lock and a fresh unlock: only the second tells the epoch
    // check from an "is the vault unlocked now?" check.
    const INTERRUPTIONS: Array<[string, () => Promise<void>]> = [
      ["a lock", async () => {
        await sendMessage({ type: "LOCK_VAULT" });
      }],
      ["a lock and re-unlock", async () => {
        await sendMessage({ type: "LOCK_VAULT" });
        expect(await sendMessage({ type: "UNLOCK_VAULT", passphrase: "pw" })).toEqual({
          type: "UNLOCK_VAULT",
          ok: true,
        });
      }],
    ];

    describe.each([
      [CMD_COPY_PASSWORD, "s3cret"],
      [CMD_COPY_USERNAME, "alice"],
    ])("%s", (command, text) => {
      it.each(INTERRUPTIONS)("%s while the offscreen document is readied writes nothing", async (_name, interrupt) => {
        await unlockVault(chromeMock);
        const hold = holdOffscreenCheck();
        const pending = commandHandlers[0](command);
        await hold.reached;
        await interrupt();
        hold.release();
        await pending;

        expect(writesOf(text)).toEqual([]);
      });

      it("positive control: released without a lock it writes the value", async () => {
        await unlockVault(chromeMock);
        const hold = holdOffscreenCheck();
        const pending = commandHandlers[0](command);
        await hold.reached;
        hold.release();
        await pending;

        expect(writesOf(text)).toHaveLength(1);
      });
    });
  });
});
