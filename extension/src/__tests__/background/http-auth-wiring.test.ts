import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ALARM_VAULT_LOCK, EXT_ENTRY_TYPE } from "../../lib/constants";
import { EXT_API_PATH, extApiPath } from "../../lib/api-paths";
import { HTTP_AUTH_BINDINGS_KEY, HTTP_AUTH_PENDING_INTENT_KEY } from "../../lib/http-auth-bindings";
import { createKeyedDecryptMock } from "../helpers/keyed-decrypt-mock";

// HTTP auth (#905) as background/index.ts wires it: C6 registration at SW
// start, the HTTP_AUTH_* message handlers, the activity exclusion, and one
// challenge answered end to end through the real prompt module.

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
vi.mock("../../lib/crypto", () => cryptoMocks);

const teamCryptoMocks = vi.hoisted(() => ({
  deriveEcdhWrappingKey: vi.fn().mockResolvedValue("ecdh-wrap-key"),
  unwrapEcdhPrivateKey: vi.fn().mockResolvedValue(new Uint8Array([10, 20, 30])),
  importEcdhPrivateKey: vi.fn().mockResolvedValue("ecdh-private-key"),
  unwrapTeamKey: vi.fn().mockResolvedValue(new Uint8Array([40, 50, 60])),
  deriveTeamEncryptionKey: vi.fn().mockResolvedValue("team-enc-key"),
  unwrapItemKey: vi.fn().mockResolvedValue(new Uint8Array([70, 80, 90])),
  deriveItemEncryptionKey: vi.fn().mockResolvedValue("item-enc-key"),
  buildTeamEntryAAD: vi.fn().mockReturnValue(new Uint8Array([3, 4])),
  buildItemKeyWrapAAD: vi.fn().mockReturnValue(new Uint8Array([5, 6])),
}));
vi.mock("../../lib/crypto-team", () => teamCryptoMocks);

const ORIGIN = "http://router.example:8080";
const OVERVIEW = JSON.stringify({ title: "Router", username: "admin", urlHost: "router.example" });
const keyedDecrypt = createKeyedDecryptMock(cryptoMocks.decryptData);

type MessageHandler = (message: unknown, sender: unknown, sendResponse: (resp: unknown) => void) => boolean | void;
type Listener = (...args: never[]) => unknown;

function chromeEvent() {
  const listeners = new Set<Listener>();
  return {
    listeners,
    addListener: vi.fn((l: Listener) => {
      listeners.add(l);
    }),
    removeListener: vi.fn((l: Listener) => {
      listeners.delete(l);
    }),
    hasListener: vi.fn((l: Listener) => listeners.has(l)),
  };
}

let messageHandlers: MessageHandler[];
let serverUrl: string;
let local: Record<string, unknown>;
let session: Record<string, unknown>;
let chromeMock: ReturnType<typeof installChromeMock>;

function installChromeMock({ webRequest = true }: { webRequest?: boolean } = {}) {
  messageHandlers = [];
  local = {};
  session = {};
  const mock = {
    runtime: {
      onMessage: { addListener: (fn: MessageHandler) => messageHandlers.push(fn) },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      sendMessage: vi.fn().mockResolvedValue({ ok: true }),
      getContexts: vi.fn().mockResolvedValue([]),
      getURL: vi.fn((path: string) => `chrome-extension://test-extension-id/${path}`),
    },
    offscreen: { createDocument: vi.fn().mockResolvedValue(undefined), Reason: { CLIPBOARD: "CLIPBOARD" } },
    alarms: { onAlarm: { addListener: vi.fn() }, create: vi.fn(), clear: vi.fn() },
    scripting: {
      executeScript: vi.fn().mockResolvedValue([]),
      registerContentScripts: vi.fn().mockResolvedValue(undefined),
      unregisterContentScripts: vi.fn().mockResolvedValue(undefined),
    },
    tabs: {
      sendMessage: vi.fn().mockResolvedValue({ filled: 1 }),
      query: vi.fn().mockResolvedValue([{ id: 1, url: undefined }]),
      get: vi.fn(async (id: number) => ({ id, windowId: 3, incognito: false })),
      onActivated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      onRemoved: chromeEvent(),
    },
    windows: {
      get: vi.fn(async () => ({ id: 3, left: 0, top: 0, width: 1000 })),
      create: vi.fn(async (_params: chrome.windows.CreateData) => ({ id: 77 })),
      remove: vi.fn(async () => {}),
      onRemoved: chromeEvent(),
    },
    action: {
      setBadgeText: vi.fn().mockResolvedValue(undefined),
      setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
    },
    contextMenus: {
      create: vi.fn((_p: unknown, cb?: () => void) => cb?.()),
      removeAll: vi.fn((cb?: () => void) => cb?.()),
      onClicked: { addListener: vi.fn() },
    },
    permissions: {
      contains: vi.fn(async () => true),
      remove: vi.fn(async () => true),
      onAdded: chromeEvent(),
      onRemoved: chromeEvent(),
    },
    storage: {
      local: {
        get: vi.fn(async (keys: unknown) =>
          typeof keys === "string"
            ? { [keys]: keys === "serverUrl" ? serverUrl : local[keys] }
            : { serverUrl, autoLockMinutes: 15 },
        ),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(local, items);
        }),
      },
      session: {
        get: vi.fn(async (key: string) => (typeof key === "string" ? { [key]: session[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(session, items);
        }),
        remove: vi.fn(async (key: string) => {
          delete session[key];
        }),
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: { addListener: vi.fn() },
    },
    commands: { onCommand: { addListener: vi.fn() } },
    webRequest: webRequest
      ? { onAuthRequired: chromeEvent(), onErrorOccurred: chromeEvent(), onBeforeRedirect: chromeEvent() }
      : undefined,
  };
  vi.stubGlobal("chrome", mock);
  return mock;
}

let bgModule: typeof import("../../background/index") | null = null;
async function loadBackground(): Promise<void> {
  bgModule = await import("../../background/index");
  await bgModule.tokenBridgeRegistration;
}

const extensionPage = () => ({ url: "chrome-extension://test-extension-id/popup/index.html" });
function send(message: unknown, sender: unknown = extensionPage()): Promise<unknown> {
  return new Promise((resolve) => {
    messageHandlers[0](message, sender, resolve);
  });
}

let byIdBlob: Record<string, unknown>;
// When set, the account has one team ("team-1") holding a LOGIN with the same
// id as the personal entry ("pw-r"), so a teamId mix-up would show.
let withTeam: boolean;

function stubFetch(): void {
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
            ...(withTeam
              ? { encryptedEcdhPrivateKey: "dd", ecdhPrivateKeyIv: "ee", ecdhPrivateKeyAuthTag: "ff" }
              : {}),
          }),
        };
      }
      if (withTeam && url.includes("/member-key")) {
        return {
          ok: true,
          json: async () => ({
            encryptedTeamKey: "tk-cipher",
            teamKeyIv: "tk-iv",
            teamKeyAuthTag: "tk-tag",
            ephemeralPublicKey: '{"kty":"EC","crv":"P-256","x":"x","y":"y"}',
            hkdfSalt: "aabb",
            keyVersion: 1,
            wrapVersion: 0,
          }),
        };
      }
      if (withTeam && url.endsWith(extApiPath.teamPasswords("team-1"))) {
        return {
          ok: true,
          json: async () => [
            {
              id: "pw-r",
              entryType: EXT_ENTRY_TYPE.LOGIN,
              encryptedOverview: "team-ov",
              overviewIv: "ov-iv",
              overviewAuthTag: "ov-tag",
              teamKeyVersion: 1,
              deletedAt: null,
              isArchived: false,
            },
          ],
        };
      }
      if (url.endsWith(EXT_API_PATH.TEAMS)) {
        return { ok: true, json: async () => (withTeam ? [{ id: "team-1", name: "Ops" }] : []) };
      }
      if (url.includes(extApiPath.passwordById(""))) {
        return {
          ok: true,
          json: async () => ({
            id: "pw-r",
            encryptedBlob: { ciphertext: "blob-r", iv: "bb", authTag: "cc" },
            encryptedOverview: { ciphertext: "11", iv: "22", authTag: "33" },
            entryType: EXT_ENTRY_TYPE.LOGIN,
            aadVersion: 1,
          }),
        };
      }
      if (url.includes(EXT_API_PATH.PASSWORDS)) {
        return {
          ok: true,
          json: async () => [
            { id: "pw-r", encryptedOverview: { ciphertext: "11", iv: "22", authTag: "33" }, entryType: EXT_ENTRY_TYPE.LOGIN, aadVersion: 1 },
          ],
        };
      }
      return { ok: false, json: async () => ({}) };
    }),
  );
}

async function unlock(): Promise<void> {
  bgModule!.applyToken("t", Date.now() + 3_600_000, "");
  expect(await send({ type: "UNLOCK_VAULT", passphrase: "pw" })).toEqual({ type: "UNLOCK_VAULT", ok: true });
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  serverUrl = "https://localhost:3000";
  byIdBlob = { url: `${ORIGIN}/admin`, username: "admin", password: "r0uter" };
  withTeam = false;
  keyedDecrypt.install({
    "11": OVERVIEW,
    "team-ov": JSON.stringify({ title: "Team Router", username: "ops", urlHost: "router.example" }),
  });
  keyedDecrypt.set("blob-r", JSON.stringify(byIdBlob));
  chromeMock = installChromeMock();
  stubFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("C6: registration at SW start", () => {
  it("registers the asyncBlocking challenge listener at module load, before any message", async () => {
    await loadBackground();
    expect(chromeMock.webRequest!.onAuthRequired.addListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.webRequest!.onAuthRequired.addListener).toHaveBeenCalledWith(
      expect.any(Function),
      { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
      ["asyncBlocking"],
    );
    expect(chromeMock.permissions.onAdded.addListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.permissions.onRemoved.addListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.windows.onRemoved.addListener).toHaveBeenCalledTimes(1);
  });

  it("control: without chrome.webRequest the SW starts and answers messages", async () => {
    chromeMock = installChromeMock({ webRequest: false });
    await loadBackground();
    expect(messageHandlers).toHaveLength(1);
    expect(await send({ type: "GET_STATUS" })).toEqual(expect.objectContaining({ type: "GET_STATUS" }));
  });

  it("a throwing addListener does not abort SW start", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    chromeMock.webRequest!.onAuthRequired.addListener.mockImplementation(() => {
      throw new Error("boom");
    });
    chromeMock.permissions.onAdded.addListener.mockImplementation(() => {
      throw new Error("boom");
    });
    await loadBackground();
    expect(messageHandlers).toHaveLength(1);
    expect(await send({ type: "GET_STATUS" })).toEqual(expect.objectContaining({ type: "GET_STATUS" }));
  });
});

describe("activity: the confirmation window's messages never extend the vault", () => {
  const vaultLockAlarms = () =>
    chromeMock.alarms.create.mock.calls.filter(([name]) => name === ALARM_VAULT_LOCK).length;
  // Past the activity debounce, so each message below could re-arm the alarm.
  const pastDebounce = () => vi.setSystemTime(Date.now() + 31_000);
  const settle = () => new Promise((r) => setTimeout(r, 10));

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await loadBackground();
    await unlock();
    await settle();
  });

  it.each([
    ["HTTP_AUTH_PROMPT_GET", { type: "HTTP_AUTH_PROMPT_GET", promptId: "x" }],
    ["HTTP_AUTH_PROMPT_DECIDE", { type: "HTTP_AUTH_PROMPT_DECIDE", promptId: "x", decision: "cancel" }],
  ])("%s does not re-arm the vault-lock alarm", async (_name, message) => {
    pastDebounce();
    chromeMock.alarms.create.mockClear();
    await send(message);
    await settle();
    expect(vaultLockAlarms()).toBe(0);
    // Control, at the same time: an ordinary popup message does.
    await send({ type: "GET_STATUS" });
    await settle();
    expect(vaultLockAlarms()).toBe(1);
  });
});

describe("HTTP_AUTH_REGISTER", () => {
  const register = (over: Record<string, unknown> = {}, sender?: unknown) =>
    send({ type: "HTTP_AUTH_REGISTER", origin: ORIGIN, entryId: "pw-r", nonce: "n1", ...over }, sender);

  beforeEach(async () => {
    await loadBackground();
  });

  it("stores the binding for a matching LOGIN and clears the popup's intent", async () => {
    await unlock();
    session[HTTP_AUTH_PENDING_INTENT_KEY] = { nonce: "n1", origin: ORIGIN, entryId: "pw-r", expiresAt: Date.now() + 60_000 };
    expect(await register()).toEqual({ type: "HTTP_AUTH_REGISTER", ok: true });
    expect(local[HTTP_AUTH_BINDINGS_KEY]).toEqual([{ origin: ORIGIN, entryId: "pw-r", userId: "user-1" }]);
    expect(session[HTTP_AUTH_PENDING_INTENT_KEY]).toBeUndefined();
  });

  it("is refused from a content script", async () => {
    await unlock();
    const res = await register({}, { tab: { id: 1, url: "https://evil.example/" }, url: "https://evil.example/", frameId: 0 });
    expect(res).toEqual({ type: "HTTP_AUTH_REGISTER", ok: false, error: "INTERNAL_ERROR" });
    expect(local[HTTP_AUTH_BINDINGS_KEY]).toBeUndefined();
  });

  it("answers VAULT_LOCKED while locked and rolls the permissions back", async () => {
    expect(await register()).toEqual({ type: "HTTP_AUTH_REGISTER", ok: false, error: "VAULT_LOCKED" });
    expect(chromeMock.permissions.remove).toHaveBeenCalledWith({ origins: [`${ORIGIN}/*`] });
  });

  it("answers HTTP_AUTH_ENTRY_MISMATCH for an entry saved for another origin", async () => {
    byIdBlob = { url: "https://router.example/", username: "admin", password: "r0uter" };
    keyedDecrypt.set("blob-r", JSON.stringify(byIdBlob));
    await unlock();
    expect(await register()).toEqual({ type: "HTTP_AUTH_REGISTER", ok: false, error: "HTTP_AUTH_ENTRY_MISMATCH" });
    expect(chromeMock.permissions.remove).toHaveBeenCalledWith({ origins: [`${ORIGIN}/*`] });
    expect(local[HTTP_AUTH_BINDINGS_KEY]).toBeUndefined();
  });

  it("permissions.onAdded completes a pending intent when the popup closed", async () => {
    await unlock();
    session[HTTP_AUTH_PENDING_INTENT_KEY] = { nonce: "n2", origin: ORIGIN, entryId: "pw-r", expiresAt: Date.now() + 60_000 };
    const [onAdded] = [...chromeMock.permissions.onAdded.listeners] as Array<(p: chrome.permissions.Permissions) => void>;
    onAdded({ permissions: ["webRequest", "webRequestAuthProvider"], origins: [`${ORIGIN}/*`] });
    await vi.waitFor(() => expect(local[HTTP_AUTH_BINDINGS_KEY]).toEqual([{ origin: ORIGIN, entryId: "pw-r", userId: "user-1" }]));
    expect(session[HTTP_AUTH_PENDING_INTENT_KEY]).toBeUndefined();
  });
});

describe("a challenge answered end to end", () => {
  const challenge = {
    requestId: "req-e2e",
    url: `${ORIGIN}/admin`,
    tabId: 4,
    type: "main_frame",
    frameType: "outermost_frame",
    documentLifecycle: "active",
    isProxy: false,
    scheme: "basic",
    challenger: { host: "router.example", port: 8080 },
  };

  beforeEach(async () => {
    local[HTTP_AUTH_BINDINGS_KEY] = [{ origin: ORIGIN, entryId: "pw-r", userId: "user-1" }];
    await loadBackground();
    await unlock();
  });

  async function raise(): Promise<{ callback: ReturnType<typeof vi.fn>; promptId: string }> {
    const [listener] = [...chromeMock.webRequest!.onAuthRequired.listeners] as Array<
      (d: unknown, cb: (a: unknown) => void) => void
    >;
    const callback = vi.fn();
    listener(challenge, callback);
    await vi.waitFor(() => expect(chromeMock.windows.create).toHaveBeenCalledTimes(1));
    const { url } = chromeMock.windows.create.mock.calls[0][0] as { url: string };
    return { callback, promptId: new URL(url).searchParams.get("id") ?? "" };
  }

  it("the window reads its view, Send releases the login once", async () => {
    const { callback, promptId } = await raise();
    expect(await send({ type: "HTTP_AUTH_PROMPT_GET", promptId })).toEqual({
      type: "HTTP_AUTH_PROMPT_GET",
      prompt: {
        url: `${ORIGIN}/admin`,
        origin: ORIGIN,
        initiator: null,
        redirectedFrom: null,
        scheme: "basic",
        entryTitle: "Router",
        entryUsername: "admin",
        insecure: true,
      },
    });
    expect(callback).not.toHaveBeenCalled();
    expect(await send({ type: "HTTP_AUTH_PROMPT_DECIDE", promptId, decision: "send" })).toEqual({
      type: "HTTP_AUTH_PROMPT_DECIDE",
      ok: true,
    });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    expect(callback).toHaveBeenCalledWith({ authCredentials: { username: "admin", password: "r0uter" } });
  });

  it("a lock settles the open prompt as cancel, closes its window and stops serving its view", async () => {
    const { callback, promptId } = await raise();
    await send({ type: "LOCK_VAULT" });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({}));
    expect(callback).toHaveBeenCalledTimes(1);
    expect(chromeMock.windows.remove).toHaveBeenCalledWith(77);
    expect(await send({ type: "HTTP_AUTH_PROMPT_GET", promptId })).toEqual({ type: "HTTP_AUTH_PROMPT_GET", prompt: null });
  });

  it("control: without a lock the prompt stays open and keeps its view", async () => {
    const { callback, promptId } = await raise();
    await send({ type: "GET_STATUS" });
    await new Promise((r) => setTimeout(r, 10));
    expect(callback).not.toHaveBeenCalled();
    expect(chromeMock.windows.remove).not.toHaveBeenCalled();
    expect(await send({ type: "HTTP_AUTH_PROMPT_GET", promptId })).toEqual(
      expect.objectContaining({ prompt: expect.objectContaining({ origin: ORIGIN }) }),
    );
  });

  it("webRequest.onErrorOccurred for the request reaches the prompt: {} and the window closes", async () => {
    const { callback, promptId } = await raise();
    const [onError] = [...chromeMock.webRequest!.onErrorOccurred.listeners] as Array<(d: unknown) => void>;
    onError({ requestId: "req-e2e", error: "net::ERR_ABORTED" });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({}));
    expect(chromeMock.windows.remove).toHaveBeenCalledWith(77);
    expect(await send({ type: "HTTP_AUTH_PROMPT_GET", promptId })).toEqual({ type: "HTTP_AUTH_PROMPT_GET", prompt: null });
  });

  it("control: another request's error leaves the prompt open", async () => {
    const { callback, promptId } = await raise();
    const [onError] = [...chromeMock.webRequest!.onErrorOccurred.listeners] as Array<(d: unknown) => void>;
    onError({ requestId: "req-other", error: "net::ERR_ABORTED" });
    await new Promise((r) => setTimeout(r, 10));
    expect(callback).not.toHaveBeenCalled();
    expect(await send({ type: "HTTP_AUTH_PROMPT_GET", promptId })).toEqual(
      expect.objectContaining({ prompt: expect.objectContaining({ origin: ORIGIN }) }),
    );
  });

  it("Cancel gives {} and a stale DECIDE is ignored", async () => {
    const { callback, promptId } = await raise();
    await send({ type: "HTTP_AUTH_PROMPT_DECIDE", promptId, decision: "cancel" });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({}));
    expect(await send({ type: "HTTP_AUTH_PROMPT_DECIDE", promptId, decision: "send" })).toEqual({
      type: "HTTP_AUTH_PROMPT_DECIDE",
      ok: false,
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

// The server-URL rule (https, or http only on localhost / 127.0.0.1) holds
// for the SW's own server traffic now that http://*/* is grantable.
describe("server URL rule in the service worker", () => {
  const serverFetches = (origin: string) =>
    (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => String(url).startsWith(origin)).length;

  it("refuses a plain-http non-loopback server: no fetch, no permission check, no token bridge", async () => {
    serverUrl = "http://server.example";
    await loadBackground();
    bgModule!.applyToken("t", Date.now() + 3_600_000, "");
    const res = (await send({ type: "UNLOCK_VAULT", passphrase: "pw" })) as { ok: boolean };
    expect(res.ok).toBe(false);
    expect(serverFetches("http://server.example")).toBe(0);
    expect(chromeMock.permissions.contains).not.toHaveBeenCalledWith({ origins: ["http://server.example/*"] });
    expect(chromeMock.scripting.registerContentScripts).not.toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "token-bridge" })]),
    );
  });

  it.each(["http://localhost:3000", "https://server.example"])("control: %s is used", async (url) => {
    serverUrl = url;
    await loadBackground();
    bgModule!.applyToken("t", Date.now() + 3_600_000, "");
    expect(await send({ type: "UNLOCK_VAULT", passphrase: "pw" })).toEqual({ type: "UNLOCK_VAULT", ok: true });
    expect(serverFetches(url)).toBeGreaterThan(0);
    expect(chromeMock.scripting.registerContentScripts).toHaveBeenCalledWith([
      expect.objectContaining({ id: "token-bridge", matches: [`${new URL(url).origin}/*`] }),
    ]);
  });
});

describe("a team binding answered end to end", () => {
  const challenge = (requestId: string) => ({
    requestId,
    url: `${ORIGIN}/admin`,
    tabId: 4,
    type: "main_frame",
    frameType: "outermost_frame",
    documentLifecycle: "active",
    isProxy: false,
    scheme: "basic",
    challenger: { host: "router.example", port: 8080 },
  });

  beforeEach(async () => {
    withTeam = true;
    await loadBackground();
    await unlock();
  });

  function raise(requestId: string): ReturnType<typeof vi.fn> {
    const [listener] = [...chromeMock.webRequest!.onAuthRequired.listeners] as Array<
      (d: unknown, cb: (a: unknown) => void) => void
    >;
    const callback = vi.fn();
    listener(challenge(requestId), callback);
    return callback;
  }

  it("a {teamId} binding opens the window with the team entry's title", async () => {
    local[HTTP_AUTH_BINDINGS_KEY] = [{ origin: ORIGIN, entryId: "pw-r", teamId: "team-1", userId: "user-1" }];
    raise("req-team");
    await vi.waitFor(() => expect(chromeMock.windows.create).toHaveBeenCalledTimes(1));
    const { url } = chromeMock.windows.create.mock.calls[0][0] as { url: string };
    const promptId = new URL(url).searchParams.get("id") ?? "";
    expect(await send({ type: "HTTP_AUTH_PROMPT_GET", promptId })).toEqual(
      expect.objectContaining({ prompt: expect.objectContaining({ entryTitle: "Team Router", entryUsername: "ops" }) }),
    );
  });

  it("control: a personal binding with the same entry id shows the personal entry, not the team one", async () => {
    local[HTTP_AUTH_BINDINGS_KEY] = [{ origin: ORIGIN, entryId: "pw-r", userId: "user-1" }];
    raise("req-personal");
    await vi.waitFor(() => expect(chromeMock.windows.create).toHaveBeenCalledTimes(1));
    const { url } = chromeMock.windows.create.mock.calls[0][0] as { url: string };
    const promptId = new URL(url).searchParams.get("id") ?? "";
    expect(await send({ type: "HTTP_AUTH_PROMPT_GET", promptId })).toEqual(
      expect.objectContaining({ prompt: expect.objectContaining({ entryTitle: "Router", entryUsername: "admin" }) }),
    );
  });

  it("control: a binding to a team entry id that does not exist opens no window", async () => {
    local[HTTP_AUTH_BINDINGS_KEY] = [{ origin: ORIGIN, entryId: "pw-r", teamId: "team-9", userId: "user-1" }];
    const callback = raise("req-missing");
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({}));
    expect(chromeMock.windows.create).not.toHaveBeenCalled();
  });
});

describe("HTTP_AUTH_REGISTER when a step throws", () => {
  it("rolls the permissions back, answers a mapped code and still clears the popup's intent", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await loadBackground();
    await unlock();
    const base = (fetch as unknown as ReturnType<typeof vi.fn>).getMockImplementation() as (url: string) => Promise<unknown>;
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.includes(extApiPath.passwordById("pw-r"))) throw new TypeError("Failed to fetch");
      return base(url);
    });
    session[HTTP_AUTH_PENDING_INTENT_KEY] = { nonce: "n9", origin: ORIGIN, entryId: "pw-r", expiresAt: Date.now() + 60_000 };
    expect(
      await send({ type: "HTTP_AUTH_REGISTER", origin: ORIGIN, entryId: "pw-r", nonce: "n9" }),
    ).toEqual({ type: "HTTP_AUTH_REGISTER", ok: false, error: "NETWORK_ERROR" });
    expect(chromeMock.permissions.remove).toHaveBeenCalledWith({ origins: [`${ORIGIN}/*`] });
    expect(session[HTTP_AUTH_PENDING_INTENT_KEY]).toBeUndefined();
    expect(local[HTTP_AUTH_BINDINGS_KEY]).toBeUndefined();
  });
});

describe("own-app detection uses the server URL rule", () => {
  // Inline suggestions are suppressed on the app's own pages (isOwnAppPage).
  const matchesOn = (url: string) =>
    send({ type: "GET_MATCHES_FOR_URL" }, { tab: { id: 9, url }, url, frameId: 0, documentId: "doc-0" });

  it("a plain-http non-loopback server URL is no server: its pages are not the app", async () => {
    serverUrl = "http://server.example";
    await loadBackground();
    expect(await matchesOn("http://server.example/login")).toEqual(
      expect.objectContaining({ suppressInline: false, disconnected: true }),
    );
  });

  it.each(["https://server.example", "http://localhost:3000"])("control: %s pages are the app", async (url) => {
    serverUrl = url;
    await loadBackground();
    expect(await matchesOn(`${url}/login`)).toEqual(expect.objectContaining({ suppressInline: true }));
  });
});
