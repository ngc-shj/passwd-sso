import { describe, it, expect, vi, beforeEach } from "vitest";
import { EXT_ENTRY_TYPE, EXT_MSG } from "../../lib/constants";
import { EXT_API_PATH, extApiPath } from "../../lib/api-paths";

const PASSWORD_BY_ID_PREFIX = extApiPath.passwordById("");

// ── Module mocks (mirror background.test.ts) ──

const sessionStorageMocks = vi.hoisted(() => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
  loadSession: vi.fn().mockResolvedValue(null),
  clearSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../lib/session-storage", () => sessionStorageMocks);

const dpopKeyMocks = vi.hoisted(() => ({
  getDpopThumbprint: vi.fn().mockResolvedValue("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"),
  signDpopProof: vi.fn().mockResolvedValue("fake.dpop.proof"),
  getOrGenerateDpopKeyPair: vi.fn().mockResolvedValue({
    publicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    sign: vi.fn().mockResolvedValue(new ArrayBuffer(64)),
  }),
  resetInMemoryKeyCache: vi.fn(),
}));
vi.mock("../../lib/dpop-key", () => dpopKeyMocks);

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
  VAULT_TYPE: { BLOB: "blob", OVERVIEW: "overview" },
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
      onMessage: { addListener: (fn: MessageHandler) => messageHandlers.push(fn) },
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
      onAlarm: { addListener: vi.fn() },
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
      get: vi.fn().mockResolvedValue({ id: 1, url: "https://example.com" }),
      query: vi.fn().mockResolvedValue([{ id: 1, url: "https://example.com" }]),
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
    permissions: { contains: vi.fn().mockResolvedValue(true) },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({ serverUrl: "https://localhost:3000", autoLockMinutes: 15 }),
      },
      session: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: { addListener: vi.fn() },
    },
    commands: { onCommand: { addListener: vi.fn() } },
  };
  vi.stubGlobal("chrome", chromeMock);
  return chromeMock;
}

let bgModule: typeof import("../../background/index") | null = null;
async function loadBackground() {
  bgModule = await import("../../background/index");
}
function applyToken(token: string, expiresAt: number, cnfJkt: string): void {
  if (!bgModule) throw new Error("loadBackground() must run first");
  bgModule.applyToken(token, expiresAt, cnfJkt);
}
function sendMessage(message: unknown, sender: unknown = {}): Promise<unknown> {
  return new Promise((resolve) => {
    messageHandlers[0](message, sender, (resp) => resolve(resp));
  });
}

/** Build the PASSWORDS list fetch + per-entry overview decryption. */
function mockEntries(
  entries: Array<{ id: string; entryType: string }>,
  overviews: Array<Record<string, unknown>>,
): void {
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
          json: async () =>
            entries.map((e) => ({
              id: e.id,
              encryptedOverview: { ciphertext: "11", iv: "22", authTag: "33" },
              entryType: e.entryType,
              aadVersion: 1,
            })),
        };
      }
      return { ok: false, json: async () => ({}) };
    }),
  );
  // decryptOverviews decrypts each entry's overview in list order.
  cryptoMocks.decryptData.mockReset();
  for (const ov of overviews) {
    cryptoMocks.decryptData.mockResolvedValueOnce(JSON.stringify(ov));
  }
}

describe("resolveInlineMatches (LOGIN / CC / IDENTITY)", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chromeMock = installChromeMock();
    mockEntries([], []);
    await loadBackground();
  });

  async function unlock() {
    applyToken("t", Date.now() + 60_000, "");
    await sendMessage({ type: EXT_MSG.UNLOCK_VAULT, passphrase: "pw" });
  }

  // ── T1: LOGIN host-filter regression lock ──

  it("LOGIN returns an entry whose urlHost matches the page host", async () => {
    mockEntries(
      [{ id: "login-1", entryType: EXT_ENTRY_TYPE.LOGIN }],
      [{ title: "GitHub", username: "alice", urlHost: "github.com" }],
    );
    await unlock();

    const res = (await sendMessage({
      type: EXT_MSG.GET_MATCHES_FOR_URL,
      url: "https://github.com/login",
    })) as { entries: Array<{ id: string }> };

    expect(res.entries.map((e) => e.id)).toEqual(["login-1"]);
  });

  it("LOGIN returns no entry when urlHost does not match the page host", async () => {
    mockEntries(
      [{ id: "login-1", entryType: EXT_ENTRY_TYPE.LOGIN }],
      [{ title: "GitHub", username: "alice", urlHost: "github.com" }],
    );
    await unlock();

    const res = (await sendMessage({
      type: EXT_MSG.GET_MATCHES_FOR_URL,
      url: "https://gitlab.com/login",
    })) as { entries: unknown[] };

    expect(res.entries).toEqual([]);
  });

  // ── T2: non-vacuous CC host test (urlHost deliberately ≠ page host) ──

  it("CC returns the card even though its urlHost differs from the page host", async () => {
    mockEntries(
      [{ id: "cc-1", entryType: EXT_ENTRY_TYPE.CREDIT_CARD }],
      // urlHost deliberately set to a value that does NOT match the page —
      // proves CC is not host-filtered (would be empty under a host filter).
      [{ title: "Orico Mastercard", cardholderName: "Alice", urlHost: "elsewhere.example" }],
    );
    await unlock();

    const res = (await sendMessage({
      type: EXT_MSG.GET_CC_MATCHES_FOR_URL,
      url: "https://store.apple.com/checkout",
    })) as { type: string; entries: Array<{ id: string; username: string }> };

    expect(res.type).toBe(EXT_MSG.GET_CC_MATCHES_FOR_URL);
    expect(res.entries.map((e) => e.id)).toEqual(["cc-1"]);
    // T6: cardholderName surfaces as username for the dropdown label.
    expect(res.entries[0].username).toBe("Alice");
  });

  it("IDENTITY returns the identity regardless of host, mapping fullName → username", async () => {
    mockEntries(
      [{ id: "id-1", entryType: EXT_ENTRY_TYPE.IDENTITY }],
      [{ title: "Home", fullName: "Alice Smith", urlHost: "elsewhere.example" }],
    );
    await unlock();

    const res = (await sendMessage({
      type: EXT_MSG.GET_IDENTITY_MATCHES_FOR_URL,
      url: "https://shop.example/address",
    })) as { entries: Array<{ id: string; username: string }> };

    expect(res.entries.map((e) => e.id)).toEqual(["id-1"]);
    expect(res.entries[0].username).toBe("Alice Smith");
  });

  it("CC does not return LOGIN entries (filters strictly by entry type)", async () => {
    mockEntries(
      [
        { id: "login-1", entryType: EXT_ENTRY_TYPE.LOGIN },
        { id: "cc-1", entryType: EXT_ENTRY_TYPE.CREDIT_CARD },
      ],
      [
        { title: "GitHub", username: "alice", urlHost: "github.com" },
        { title: "Card", cardholderName: "Alice", urlHost: "x.example" },
      ],
    );
    await unlock();

    const res = (await sendMessage({
      type: EXT_MSG.GET_CC_MATCHES_FOR_URL,
      url: "https://github.com/anything",
    })) as { entries: Array<{ id: string }> };

    expect(res.entries.map((e) => e.id)).toEqual(["cc-1"]);
  });

  // ── F4: hostless (file://) page still returns CC entries ──

  it("CC returns entries on a hostless (file://) page", async () => {
    mockEntries(
      [{ id: "cc-1", entryType: EXT_ENTRY_TYPE.CREDIT_CARD }],
      [{ title: "Card", cardholderName: "Alice", urlHost: "" }],
    );
    await unlock();

    const res = (await sendMessage({
      type: EXT_MSG.GET_CC_MATCHES_FOR_URL,
      url: "file:///home/user/form.html",
    })) as { entries: Array<{ id: string }> };

    expect(res.entries.map((e) => e.id)).toEqual(["cc-1"]);
  });

  it("LOGIN returns empty on a hostless (file://) page", async () => {
    mockEntries(
      [{ id: "login-1", entryType: EXT_ENTRY_TYPE.LOGIN }],
      [{ title: "GitHub", username: "alice", urlHost: "github.com" }],
    );
    await unlock();

    const res = (await sendMessage({
      type: EXT_MSG.GET_MATCHES_FOR_URL,
      url: "file:///home/user/form.html",
    })) as { entries: unknown[] };

    expect(res.entries).toEqual([]);
  });

  // ── Gates apply uniformly across all three kinds ──

  it("CC reports disconnected when there is no token", async () => {
    // No unlock() → no token.
    const res = (await sendMessage({
      type: EXT_MSG.GET_CC_MATCHES_FOR_URL,
      url: "https://store.apple.com/checkout",
    })) as { disconnected?: boolean; entries: unknown[] };

    expect(res.disconnected).toBe(true);
    expect(res.entries).toEqual([]);
  });

  it("CC reports vaultLocked when connected but locked", async () => {
    applyToken("t", Date.now() + 60_000, "");
    // token applied but vault never unlocked → encryptionKey null
    const res = (await sendMessage({
      type: EXT_MSG.GET_CC_MATCHES_FOR_URL,
      url: "https://store.apple.com/checkout",
    })) as { vaultLocked: boolean; entries: unknown[] };

    expect(res.vaultLocked).toBe(true);
    expect(res.entries).toEqual([]);
  });

  it("CC suppresses inline on the passwd-sso own-app origin", async () => {
    await unlock();
    const res = (await sendMessage({
      type: EXT_MSG.GET_CC_MATCHES_FOR_URL,
      url: "https://localhost:3000/ja/passwords/new",
    })) as { suppressInline: boolean; entries: unknown[] };

    expect(res.suppressInline).toBe(true);
    expect(res.entries).toEqual([]);
  });
});

// ── C8 (frame-targeted fill) + C9 (id validation) via AUTOFILL_FROM_CONTENT ──

/** Stub fetch so a personal CC entry decrypts to a fillable card blob. */
function mockCcFillFetch(): void {
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
      // passwordById prefix must be checked before the PASSWORDS list path.
      if (url.includes(PASSWORD_BY_ID_PREFIX) && !url.endsWith(EXT_API_PATH.PASSWORDS)) {
        return {
          ok: true,
          json: async () => ({
            id: "cc-1",
            encryptedBlob: { ciphertext: "aa", iv: "bb", authTag: "cc" },
            encryptedOverview: { ciphertext: "11", iv: "22", authTag: "33" },
            entryType: EXT_ENTRY_TYPE.CREDIT_CARD,
            aadVersion: 1,
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    }),
  );
  // blob (with cardNumber) then overview, per performAutofillForEntry.
  cryptoMocks.decryptData.mockReset();
  cryptoMocks.decryptData
    .mockResolvedValueOnce(
      JSON.stringify({ cardNumber: "4111111111111111", cardholderName: "Alice" }),
    )
    .mockResolvedValueOnce(JSON.stringify({ username: "Alice" }));
}

describe("AUTOFILL_FROM_CONTENT frame targeting + id validation", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chromeMock = installChromeMock();
    await loadBackground();
  });

  async function unlock() {
    mockCcFillFetch();
    applyToken("t", Date.now() + 60_000, "");
    await sendMessage({ type: EXT_MSG.UNLOCK_VAULT, passphrase: "pw" });
    mockCcFillFetch();
  }

  it("C8: inline fill targets the originating frame (sendMessage + executeScript)", async () => {
    await unlock();

    const res = (await sendMessage(
      { type: EXT_MSG.AUTOFILL_FROM_CONTENT, entryId: "cc-1" },
      { tab: { id: 7 }, frameId: 42 },
    )) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(chromeMock?.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7, frameIds: [42] } }),
    );
    expect(chromeMock?.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: EXT_MSG.AUTOFILL_CC_FILL }),
      { frameId: 42 },
    );
  });

  it("C8: popup fill (no frameId) stays tab-wide — no frameIds / no frameId option", async () => {
    await unlock();

    // Popup/context-menu sender has a tab but no frameId.
    const res = (await sendMessage(
      { type: EXT_MSG.AUTOFILL_FROM_CONTENT, entryId: "cc-1" },
      { tab: { id: 7 } },
    )) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(chromeMock?.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7 } }),
    );
    // Two-arg form (no options) — must NOT narrow to frame 0.
    expect(chromeMock?.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: EXT_MSG.AUTOFILL_CC_FILL }),
    );
  });

  it("C9: rejects an oversized entryId before any fetch", async () => {
    await unlock();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockClear();

    const res = (await sendMessage(
      { type: EXT_MSG.AUTOFILL_FROM_CONTENT, entryId: "a".repeat(65) },
      { tab: { id: 7 }, frameId: 1 },
    )) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("INVALID_ID");
    expect(globalThis.fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("C9: rejects an entryId with illegal characters", async () => {
    await unlock();
    const res = (await sendMessage(
      { type: EXT_MSG.AUTOFILL_FROM_CONTENT, entryId: "../../etc/passwd" },
      { tab: { id: 7 }, frameId: 1 },
    )) as { ok: boolean; error?: string };

    expect(res.error).toBe("INVALID_ID");
  });

  it("C9: rejects a malformed teamId even when entryId is valid", async () => {
    await unlock();
    const res = (await sendMessage(
      { type: EXT_MSG.AUTOFILL_FROM_CONTENT, entryId: "cc-1", teamId: "bad/id" },
      { tab: { id: 7 }, frameId: 1 },
    )) as { ok: boolean; error?: string };

    expect(res.error).toBe("INVALID_ID");
  });

  it("C9: accepts a CUID-shaped id (not over-strict UUIDv4)", async () => {
    await unlock();
    // Override the by-id fetch to recognize the CUID-shaped entryId.
    cryptoMocks.decryptData.mockReset();
    cryptoMocks.decryptData
      .mockResolvedValueOnce(
        JSON.stringify({ cardNumber: "4111111111111111", cardholderName: "Alice" }),
      )
      .mockResolvedValueOnce(JSON.stringify({ username: "Alice" }));

    const cuid = "cjld2cjxh0000qzrmn831i7rn"; // CUID v1 shape
    const res = (await sendMessage(
      { type: EXT_MSG.AUTOFILL_FROM_CONTENT, entryId: cuid },
      { tab: { id: 7 }, frameId: 1 },
    )) as { ok: boolean; error?: string };

    // Not rejected by the id guard (would be INVALID_ID otherwise).
    expect(res.error).not.toBe("INVALID_ID");
    expect(res.ok).toBe(true);
  });
});
