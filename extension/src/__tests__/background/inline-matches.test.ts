import { describe, it, expect, vi, beforeEach } from "vitest";
import { EXT_ENTRY_TYPE, EXT_MSG } from "../../lib/constants";
import { EXT_API_PATH, extApiPath } from "../../lib/api-paths";
import { createExecuteScriptMock, documentIdFor } from "../helpers/execute-script-mock";
import {
  BUNDLE_RESEND_ATTEMPTS,
  BUNDLE_RESEND_INTERVAL_MS,
} from "../../background/content-bundle";

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
  deriveAuthKeyBytes: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
  computeAuthHash: vi.fn().mockResolvedValue("fake-auth-hash"),
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

// Content-bundle loader paths as CRXJS emits them (dist/manifest.json for
// production; `<id>-loader.js` for the dev server).
const PROD_LOADER = "assets/form-detector.ts-loader-D6NUAxWB.js";
const DEV_LOADER = "src/content/form-detector.ts-loader.js";
function manifestWithContentScripts(js: string[]) {
  return {
    manifest_version: 3,
    name: "__MSG_extName__",
    version: "0.0.0",
    content_scripts: [
      {
        js,
        matches: ["https://*/*", "http://localhost/*"],
        run_at: "document_idle",
        all_frames: true,
      },
    ],
  };
}
const NO_RECEIVER = "Could not establish connection. Receiving end does not exist.";
// URL the content-bundle probe reports for each targeted document.
let probeUrl = "https://shop.example/checkout";

function installChromeMock() {
  messageHandlers = [];
  const chromeMock = {
    runtime: {
      onMessage: { addListener: (fn: MessageHandler) => messageHandlers.push(fn) },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      sendMessage: vi.fn().mockResolvedValue({ ok: true }),
      getContexts: vi.fn().mockResolvedValue([]),
      getURL: vi.fn((path: string) => `chrome-extension://test-extension-id/${path}`),
      getManifest: vi.fn(() => manifestWithContentScripts([PROD_LOADER])),
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
      executeScript: createExecuteScriptMock(() => probeUrl),
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
      create: vi.fn((_props: unknown, cb?: () => void) => cb?.()),
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
  // Settle the module-load registration so it cannot land on the next test's chrome mock.
  await bgModule.tokenBridgeRegistration;
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

  it("IDENTITY with composed fullName (givenName+familyName at write time) surfaces in username", async () => {
    // Simulates an entry that had no fullName but givenName="Taro" + familyName="Yamada"
    // written to the overview blob as fullName="Taro Yamada" by composeIdentityNameLabel.
    mockEntries(
      [{ id: "id-2", entryType: EXT_ENTRY_TYPE.IDENTITY }],
      [{ title: "My Card", fullName: "Taro Yamada", email: "taro@example.com", urlHost: "" }],
    );
    await unlock();

    const res = (await sendMessage({
      type: EXT_MSG.GET_IDENTITY_MATCHES_FOR_URL,
      url: "https://form.example/register",
    })) as { entries: Array<{ id: string; username: string }> };

    expect(res.entries.map((e) => e.id)).toEqual(["id-2"]);
    expect(res.entries[0].username).toBe("Taro Yamada");
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
    probeUrl = "https://shop.example/checkout";
    chromeMock = installChromeMock();
    await loadBackground();
  });

  async function unlock() {
    mockCcFillFetch();
    applyToken("t", Date.now() + 60_000, "");
    await sendMessage({ type: EXT_MSG.UNLOCK_VAULT, passphrase: "pw" });
    mockCcFillFetch();
  }

  it("C8: inline fill targets the originating frame via sendMessage; no executeScript on the happy path", async () => {
    await unlock();

    const res = (await sendMessage(
      { type: EXT_MSG.AUTOFILL_FROM_CONTENT, entryId: "cc-1" },
      {
        tab: { id: 7, url: "https://shop.example/checkout" },
        url: "https://shop.example/checkout",
        frameId: 42,
      },
    )) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(chromeMock?.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: EXT_MSG.AUTOFILL_CC_FILL }),
      { frameId: 42 },
    );
    // autofill-cc-lib.ts is bundled via form-detector.ts content_scripts, so the
    // listener is already present — no fallback injection needed.
    expect(chromeMock?.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("C8: popup CC fill (no frameId) scopes to the TOP FRAME, never tab-wide", async () => {
    await unlock();

    // Sender has a tab but no frameId (popup / context-menu). CC entries are
    // hostless, so a tab-wide broadcast would leak card data into a cross-origin
    // iframe. The SW must scope to frame 0 (top frame) only.
    const res = (await sendMessage(
      { type: EXT_MSG.AUTOFILL_FROM_CONTENT, entryId: "cc-1" },
      {
        tab: { id: 7, url: "https://shop.example/checkout" },
        url: "https://shop.example/checkout",
      },
    )) as { ok: boolean };

    expect(res.ok).toBe(true);
    // Must target the top frame explicitly — NOT the two-arg tab-wide form.
    expect(chromeMock?.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: EXT_MSG.AUTOFILL_CC_FILL }),
      { frameId: 0 },
    );
    expect(chromeMock?.scripting.executeScript).not.toHaveBeenCalled();
  });

  // Identity uses the identical sendSensitiveFillMessage path as CC (frameId ?? 0),
  // so the top-frame-scope boundary is covered by the CC test above; a separate
  // Identity fixture would only re-exercise the same delivery function.

  it("C8: fallback injects the bundled content script frame-scoped, never tab-wide", async () => {
    await unlock();

    // Simulate the manifest content script not yet attached: the first
    // sendMessage rejects, the fallback executeScript runs, then the retry
    // sendMessage succeeds. The fallback MUST target the originating frame only
    // (executeTarget = { tabId, frameIds: [42] }) so card data never sprays into
    // a cross-origin subframe.
    chromeMock!.tabs.sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("Could not establish connection"))
      .mockResolvedValueOnce({});

    const res = (await sendMessage(
      { type: EXT_MSG.AUTOFILL_FROM_CONTENT, entryId: "cc-1" },
      {
        tab: { id: 7, url: "https://shop.example/checkout" },
        url: "https://shop.example/checkout",
        frameId: 42,
      },
    )) as { ok: boolean };

    expect(res.ok).toBe(true);
    // The probe targets frame 42 only; the bundle goes to the document found there.
    expect(chromeMock?.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, frameIds: [42] },
      func: expect.any(Function),
    });
    expect(chromeMock?.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, documentIds: [documentIdFor(42)] },
      files: [PROD_LOADER],
    });
    // The retry after injection is pinned to that document.
    expect(chromeMock?.tabs.sendMessage).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({ type: EXT_MSG.AUTOFILL_CC_FILL }),
      { documentId: documentIdFor(42) },
    );
  });

  // ── C5: bundle path from the manifest + bounded resend ──

  const ccFillFromFrame42 = () =>
    sendMessage(
      { type: EXT_MSG.AUTOFILL_FROM_CONTENT, entryId: "cc-1" },
      {
        tab: { id: 7, url: "https://shop.example/checkout" },
        url: "https://shop.example/checkout",
        frameId: 42,
      },
    ) as Promise<{ ok: boolean; error?: string }>;

  /** sendMessage mock that rejects with each queued error in turn, then resolves; returns call times. */
  function queueCcSendResults(errors: string[]): number[] {
    const times: number[] = [];
    const queue = [...errors];
    chromeMock!.tabs.sendMessage = vi.fn(async () => {
      times.push(performance.now());
      const next = queue.shift();
      if (next !== undefined) throw new Error(next);
      return {};
    });
    return times;
  }

  it("C5: injects the dev-server loader path when the manifest has the dev shape", async () => {
    chromeMock!.runtime.getManifest.mockReturnValue(manifestWithContentScripts([DEV_LOADER]));
    await unlock();
    queueCcSendResults([NO_RECEIVER]);

    const res = await ccFillFromFrame42();

    expect(res.ok).toBe(true);
    expect(chromeMock?.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, documentIds: [documentIdFor(42)] },
      files: [DEV_LOADER],
    });
  });

  it("C5: fails closed with AUTOFILL_INJECT_FAILED when no manifest entry is the form-detector loader", async () => {
    chromeMock!.runtime.getManifest.mockReturnValue(
      manifestWithContentScripts([
        // The pre-C5 literal (not a loader) and a loader of another bundle.
        "src/content/form-detector.js",
        "assets/token-bridge.ts-loader-Ab12_-.js",
      ]),
    );
    await unlock();
    queueCcSendResults([NO_RECEIVER]);

    const res = await ccFillFromFrame42();

    expect(res).toMatchObject({ ok: false, error: "AUTOFILL_INJECT_FAILED" });
    expect(chromeMock?.scripting.executeScript).not.toHaveBeenCalled();
    expect(chromeMock?.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("C5: resends after the backoff while the injected bundle has no receiver yet", async () => {
    await unlock();
    // Initial send, then the first post-inject resend: no receiver. Second resend lands.
    const times = queueCcSendResults([NO_RECEIVER, NO_RECEIVER]);

    const res = await ccFillFromFrame42();

    expect(res.ok).toBe(true);
    expect(chromeMock?.tabs.sendMessage).toHaveBeenCalledTimes(3);
    // The post-inject resends are spaced by the backoff, not fired back to back
    // (10 ms of slack for real-timer jitter).
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(BUNDLE_RESEND_INTERVAL_MS - 10);
    // The first send targets the originating frame; every resend is pinned to
    // the document the bundle went into.
    const [first, ...resends] = chromeMock!.tabs.sendMessage.mock.calls;
    expect(first[2]).toEqual({ frameId: 42 });
    for (const call of resends) {
      expect(call[2]).toEqual({ documentId: documentIdFor(42) });
    }
  });

  it("C5: fails closed with AUTOFILL_INJECT_FAILED once the post-inject attempts run out", async () => {
    await unlock();
    queueCcSendResults(Array.from({ length: 50 }, () => NO_RECEIVER));

    const res = await ccFillFromFrame42();

    expect(res).toMatchObject({ ok: false, error: "AUTOFILL_INJECT_FAILED" });
    // 1 initial send + the post-inject attempts, then no more.
    expect(chromeMock?.tabs.sendMessage).toHaveBeenCalledTimes(1 + BUNDLE_RESEND_ATTEMPTS);
    // One probe and one bundle injection.
    expect(chromeMock?.scripting.executeScript).toHaveBeenCalledTimes(2);
  });

  // The bundle only goes where the manifest's own content_scripts.matches reach;
  // activeTab would otherwise let it into pages the manifest deliberately skips.
  it.each([
    { url: "https://shop.example/checkout", injected: true },
    { url: "http://localhost:3000/checkout", injected: true },
    { url: "http://shop.example/checkout", injected: false },
    { url: "about:blank", injected: false },
  ])("C5: injects the bundle into $url: $injected", async ({ url, injected }) => {
    probeUrl = url;
    await unlock();
    queueCcSendResults([NO_RECEIVER]);

    const res = await ccFillFromFrame42();

    const bundleCalls = chromeMock!.scripting.executeScript.mock.calls.filter(
      (c: unknown[]) => "files" in (c[0] as object),
    );
    expect(bundleCalls).toHaveLength(injected ? 1 : 0);
    expect(res).toMatchObject(injected ? { ok: true } : { ok: false, error: "AUTOFILL_INJECT_FAILED" });
    expect(chromeMock?.tabs.sendMessage).toHaveBeenCalledTimes(injected ? 2 : 1);
  });

  it.each([
    { name: "two documents", probe: [{ frameId: 42, documentId: "a", result: "https://shop.example/" }, { frameId: 42, documentId: "b", result: "https://shop.example/" }] },
    { name: "no documentId", probe: [{ frameId: 42, documentId: "", result: "https://shop.example/" }] },
    { name: "no document", probe: [] },
  ])("C5: fails closed without injecting when the frame's document cannot be pinned ($name)", async ({ probe }) => {
    await unlock();
    queueCcSendResults([NO_RECEIVER]);
    chromeMock!.scripting.executeScript.mockResolvedValueOnce(probe);

    const res = await ccFillFromFrame42();

    expect(res).toMatchObject({ ok: false, error: "AUTOFILL_INJECT_FAILED" });
    expect(chromeMock?.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(chromeMock?.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("C5: does not resend on a post-inject rejection other than 'Receiving end does not exist'", async () => {
    await unlock();
    queueCcSendResults([NO_RECEIVER, "The message port closed before a response was received."]);

    const res = await ccFillFromFrame42();

    expect(res).toMatchObject({ ok: false, error: "AUTOFILL_INJECT_FAILED" });
    expect(chromeMock?.tabs.sendMessage).toHaveBeenCalledTimes(2);
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
    // No entry data is fetched. (The token refresh a verified unlock triggers
    // may land after the mockClear above; it is not part of this request.)
    const dataCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => !String(url).includes(EXT_API_PATH.EXTENSION_TOKEN_REFRESH),
    );
    expect(dataCalls).toHaveLength(0);
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
      {
        tab: { id: 7, url: "https://shop.example/checkout" },
        url: "https://shop.example/checkout",
        frameId: 1,
      },
    )) as { ok: boolean; error?: string };

    // Not rejected by the id guard (would be INVALID_ID otherwise).
    expect(res.error).not.toBe("INVALID_ID");
    expect(res.ok).toBe(true);
  });
});

// ── M3: disabled-inline gate for CC and IDENTITY ──────────────────────────────

describe("M3: resolveInlineMatches suppresses inline when enableInlineSuggestions=false", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const mock = installChromeMock();
    // Override storage to return enableInlineSuggestions=false.
    mock.storage.local.get.mockResolvedValue({
      serverUrl: "https://localhost:3000",
      autoLockMinutes: 15,
      enableInlineSuggestions: false,
    });
    mockEntries([], []);
    await loadBackground();
    // Flush the getSettings().then(...) microtask so cachedEnableInlineSuggestions
    // is set before any message arrives.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // Unlock the vault so the gate is reached with a valid token+key.
    applyToken("t", Date.now() + 60_000, "");
    await sendMessage({ type: EXT_MSG.UNLOCK_VAULT, passphrase: "pw" });
  });

  it("GET_CC_MATCHES_FOR_URL returns suppressInline=true and empty entries", async () => {
    const res = (await sendMessage({
      type: EXT_MSG.GET_CC_MATCHES_FOR_URL,
      url: "https://store.example.com/checkout",
    })) as { suppressInline: boolean; entries: unknown[] };

    expect(res.suppressInline).toBe(true);
    expect(res.entries).toEqual([]);
  });

  it("GET_IDENTITY_MATCHES_FOR_URL returns suppressInline=true and empty entries", async () => {
    const res = (await sendMessage({
      type: EXT_MSG.GET_IDENTITY_MATCHES_FOR_URL,
      url: "https://shop.example.com/address",
    })) as { suppressInline: boolean; entries: unknown[] };

    expect(res.suppressInline).toBe(true);
    expect(res.entries).toEqual([]);
  });
});
