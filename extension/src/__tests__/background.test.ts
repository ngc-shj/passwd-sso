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

function installChromeMock() {
  messageHandlers = [];
  alarmHandlers = [];

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
    permissions: {
      contains: vi.fn().mockResolvedValue(true),
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({ serverUrl: "https://localhost:3000" }),
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
    installChromeMock();

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
});
