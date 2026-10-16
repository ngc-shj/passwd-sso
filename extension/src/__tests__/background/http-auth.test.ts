import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deferred } from "../helpers/deferred";
import {
  ANSWERED_REQUEST_LIMIT,
  DECRYPT_DEADLINE_MS,
  completePendingIntent,
  clearPendingIntent,
  credentialsForOrigin,
  handleAuthRequired,
  initHttpAuth,
  installHttpAuthLifecycle,
  registerHttpAuthBinding,
  registerHttpAuthListeners,
  type AuthAnswer,
  type AuthChallenge,
  type EntryAccess,
  type HttpAuthDeps,
} from "../../background/http-auth";
import {
  HTTP_AUTH_BINDINGS_KEY,
  HTTP_AUTH_PENDING_INTENT_KEY,
} from "../../lib/http-auth-bindings";

// ── chrome mock ──────────────────────────────────────────────────

type ChromeEvent = {
  listeners: Set<unknown>;
  addListener: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  hasListener: ReturnType<typeof vi.fn>;
};

function chromeEvent(): ChromeEvent {
  const listeners = new Set<unknown>();
  return {
    listeners,
    addListener: vi.fn((l: unknown) => {
      listeners.add(l);
    }),
    removeListener: vi.fn((l: unknown) => {
      listeners.delete(l);
    }),
    hasListener: vi.fn((l: unknown) => listeners.has(l)),
  };
}

let local: Record<string, unknown>;
let session: Record<string, unknown>;
let chromeMock: ReturnType<typeof installChrome>;

function installChrome({ webRequest = true }: { webRequest?: boolean } = {}) {
  local = {};
  session = {};
  const mock = {
    storage: {
      local: {
        get: vi.fn(async (keys: unknown) =>
          typeof keys === "string"
            ? { [keys]: local[keys] }
            : { ...(keys as object), serverUrl: "https://server.example" },
        ),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(local, items);
        }),
      },
      session: {
        get: vi.fn(async (key: string) => ({ [key]: session[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(session, items);
        }),
        remove: vi.fn(async (key: string) => {
          delete session[key];
        }),
      },
    },
    permissions: {
      contains: vi.fn(async (_req: { origins?: string[]; permissions?: string[] }) => true),
      remove: vi.fn(async (_req: chrome.permissions.Permissions) => true),
      onAdded: chromeEvent(),
      onRemoved: chromeEvent(),
    },
    tabs: {
      get: vi.fn(async (id: number) => ({ id, windowId: 1, incognito: false })),
    },
    webRequest: webRequest
      ? { onAuthRequired: chromeEvent(), onErrorOccurred: chromeEvent() }
      : undefined,
  };
  vi.stubGlobal("chrome", mock);
  return mock;
}

// ── seam fakes ───────────────────────────────────────────────────

const ORIGIN = "https://intranet.example";
const USER = "user-1";
const LOGIN_ACCESS: EntryAccess = {
  ok: true,
  blob: { url: "https://intranet.example/login", password: "s3cret" },
  overview: { username: "alice" },
  entryType: "LOGIN",
};
const SENT: AuthAnswer = { authCredentials: { username: "alice", password: "s3cret" } };

let unlocked: boolean;
let currentUser: string;
let epoch: number;
let deps: {
  [K in keyof HttpAuthDeps]: ReturnType<typeof vi.fn> & HttpAuthDeps[K];
};

function installDeps(): void {
  unlocked = true;
  currentUser = USER;
  epoch = 1;
  deps = {
    isVaultUnlocked: vi.fn(() => unlocked),
    currentUserId: vi.fn(() => (unlocked ? currentUser : null)),
    awaitHydrationBounded: vi.fn(async () => {}),
    currentVaultEpoch: vi.fn(() => epoch),
    isVaultEpochCurrent: vi.fn((e: number) => e === epoch),
    fetchAndDecryptEntry: vi.fn(async () => LOGIN_ACCESS),
    getEntryOverview: vi.fn(async () => ({ title: "Intranet", username: "alice", entryType: "LOGIN" })),
    openPrompt: vi.fn(async () => "send" as const),
  } as typeof deps;
  initHttpAuth(deps);
}

let requestSeq = 0;
function challenge(over: Partial<AuthChallenge> = {}): AuthChallenge {
  requestSeq += 1;
  return {
    requestId: `req-${requestSeq}`,
    url: `${ORIGIN}/admin`,
    tabId: 7,
    type: "main_frame",
    frameType: "outermost_frame",
    documentLifecycle: "active",
    isProxy: false,
    scheme: "basic",
    challenger: { host: "intranet.example", port: 443 },
    ...over,
  };
}

function bind(origin = ORIGIN, entryId = "e1", teamId?: string, userId: string | null = USER): void {
  const existing = (local[HTTP_AUTH_BINDINGS_KEY] as unknown[] | undefined) ?? [];
  local[HTTP_AUTH_BINDINGS_KEY] = [
    ...existing,
    { origin, entryId, ...(teamId ? { teamId } : {}), ...(userId !== null ? { userId } : {}) },
  ];
}

/** Await the handler's own promise, then assert the callback fired exactly once. */
async function answer(details: AuthChallenge): Promise<AuthAnswer> {
  const callback = vi.fn();
  await handleAuthRequired(details, callback);
  expect(callback).toHaveBeenCalledTimes(1);
  return callback.mock.calls[0][0] as AuthAnswer;
}

beforeEach(() => {
  chromeMock = installChrome();
  installDeps();
  bind();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── C4: every rule a deny with a one-axis allow control ──────────

describe("handleAuthRequired (C4)", () => {
  it("control: answers a bound https Basic challenge with the entry's login after Send", async () => {
    expect(await answer(challenge())).toEqual(SENT);
  });

  it("rule 1: a proxy challenge gets {}", async () => {
    expect(await answer(challenge({ isProxy: true }))).toEqual({});
    expect(deps.openPrompt).not.toHaveBeenCalled();
  });

  describe("rule 2: scheme", () => {
    it.each(["ntlm", "negotiate", ""])("%j gets {}", async (scheme) => {
      expect(await answer(challenge({ scheme }))).toEqual({});
    });
    it.each(["Basic", "digest", "Digest"])("control: %j is answered", async (scheme) => {
      expect(await answer(challenge({ scheme }))).toEqual(SENT);
    });
  });

  describe("rule 3: a top-level navigation in an active document", () => {
    it.each<[string, Partial<AuthChallenge>]>([
      ["a sub_frame", { type: "sub_frame", frameType: "sub_frame" }],
      ["a fenced_frame", { frameType: "fenced_frame" }],
      ["a prerender", { documentLifecycle: "prerender" }],
      ["a back/forward-cached document", { documentLifecycle: "cached" }],
      ["a request outside any tab", { tabId: -1 }],
      ["a subresource of the top frame (image)", { type: "image" }],
      ["a fetch of the top frame (xmlhttprequest)", { type: "xmlhttprequest" }],
    ])("%s gets {}", async (_name, over) => {
      expect(await answer(challenge(over))).toEqual({});
      expect(deps.openPrompt).not.toHaveBeenCalled();
    });

    it("control: an undefined documentLifecycle is answered", async () => {
      expect(await answer(challenge({ documentLifecycle: undefined }))).toEqual(SENT);
    });

    it("an incognito tab gets {}", async () => {
      chromeMock.tabs.get.mockResolvedValueOnce({ id: 7, windowId: 1, incognito: true });
      expect(await answer(challenge())).toEqual({});
    });

    it("a tab that cannot be read gets {}", async () => {
      chromeMock.tabs.get.mockRejectedValueOnce(new Error("No tab with id: 7"));
      expect(await answer(challenge())).toEqual({});
    });
  });

  describe("rule 4: binding, challenger and permission", () => {
    it("control: https with challenger port 443 (default) is answered", async () => {
      expect(await answer(challenge({ challenger: { host: "intranet.example", port: 443 } }))).toEqual(SENT);
    });

    it("control: http with challenger port 80 (default) is answered for an http-saved entry", async () => {
      bind("http://router.example");
      deps.fetchAndDecryptEntry.mockResolvedValue({
        ...LOGIN_ACCESS,
        blob: { url: "http://router.example/", password: "s3cret" },
      } as EntryAccess);
      expect(
        await answer(challenge({ url: "http://router.example/", challenger: { host: "router.example", port: 80 } })),
      ).toEqual(SENT);
    });

    it("a challenger that differs only in port gets {}", async () => {
      expect(await answer(challenge({ challenger: { host: "intranet.example", port: 8443 } }))).toEqual({});
    });

    it("a challenger that differs only in host gets {}", async () => {
      expect(await answer(challenge({ challenger: { host: "evil.example", port: 443 } }))).toEqual({});
    });

    it("an origin with no binding gets {}", async () => {
      local[HTTP_AUTH_BINDINGS_KEY] = [];
      expect(await answer(challenge())).toEqual({});
    });

    it("a binding for the same host on another port gets {}", async () => {
      local[HTTP_AUTH_BINDINGS_KEY] = [];
      bind("https://intranet.example:8443");
      expect(await answer(challenge())).toEqual({});
    });

    it("a missing host permission gets {}", async () => {
      chromeMock.permissions.contains.mockResolvedValue(false);
      expect(await answer(challenge())).toEqual({});
      expect(deps.openPrompt).not.toHaveBeenCalled();
    });

    it.each(["::1", "[::1]"])("an IPv6 challenger %j matches its bracketed origin", async (host) => {
      local[HTTP_AUTH_BINDINGS_KEY] = [];
      bind("http://[::1]:8080");
      deps.fetchAndDecryptEntry.mockResolvedValue({
        ...LOGIN_ACCESS,
        blob: { url: "http://[::1]:8080/", password: "s3cret" },
      } as EntryAccess);
      expect(await answer(challenge({ url: "http://[::1]:8080/x", challenger: { host, port: 8080 } }))).toEqual(SENT);
    });

    it("an IPv6 challenger on another port gets {}", async () => {
      local[HTTP_AUTH_BINDINGS_KEY] = [];
      bind("http://[::1]:8080");
      expect(await answer(challenge({ url: "http://[::1]:8080/x", challenger: { host: "::1", port: 8081 } }))).toEqual({});
    });
  });

  describe("rule 5: one answer per request", () => {
    it("a repeated requestId gets {} with no new window", async () => {
      const first = challenge();
      expect(await answer(first)).toEqual(SENT);
      expect(await answer({ ...first })).toEqual({});
      expect(deps.openPrompt).toHaveBeenCalledTimes(1);
    });

    it("a request refused once stays refused (recorded at first receipt)", async () => {
      deps.openPrompt.mockResolvedValueOnce("cancel");
      const first = challenge();
      expect(await answer(first)).toEqual({});
      expect(await answer({ ...first })).toEqual({});
      expect(deps.openPrompt).toHaveBeenCalledTimes(1);
    });

    it("control: a new requestId is answered", async () => {
      expect(await answer(challenge())).toEqual(SENT);
      expect(await answer(challenge())).toEqual(SENT);
    });

    it("the record is bounded: the oldest id is forgotten past the limit", async () => {
      deps.openPrompt.mockResolvedValue("cancel");
      const oldest = challenge();
      await answer(oldest);
      for (let i = 0; i < ANSWERED_REQUEST_LIMIT; i++) await answer(challenge());
      deps.openPrompt.mockResolvedValue("send");
      expect(await answer({ ...oldest })).toEqual(SENT);
    });
  });

  describe("rule 6: the vault after hydration", () => {
    it("a locked vault gets {} and opens no window", async () => {
      unlocked = false;
      expect(await answer(challenge())).toEqual({});
      expect(deps.openPrompt).not.toHaveBeenCalled();
    });

    it("waits for hydration: released unlocked, it is answered", async () => {
      const hydration = deferred<void>();
      unlocked = false;
      deps.awaitHydrationBounded.mockReturnValueOnce(hydration.promise);
      const callback = vi.fn();
      const pending = handleAuthRequired(challenge(), callback);
      await vi.waitFor(() => expect(deps.awaitHydrationBounded).toHaveBeenCalled());
      expect(callback).not.toHaveBeenCalled();
      unlocked = true;
      hydration.resolve();
      await pending;
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(SENT);
    });

    it("hydration that ends locked (or past its bound) gets {}", async () => {
      const hydration = deferred<void>();
      unlocked = false;
      deps.awaitHydrationBounded.mockReturnValueOnce(hydration.promise);
      const callback = vi.fn();
      const pending = handleAuthRequired(challenge(), callback);
      hydration.resolve();
      await pending;
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith({});
    });
  });

  describe("account: only the registering account's challenges", () => {
    it("a binding registered by another account gets {} with no window", async () => {
      local[HTTP_AUTH_BINDINGS_KEY] = [];
      bind(ORIGIN, "e1", undefined, "user-2");
      expect(await answer(challenge())).toEqual({});
      expect(deps.openPrompt).not.toHaveBeenCalled();
    });

    it("a binding with no recorded account gets {} with no window", async () => {
      local[HTTP_AUTH_BINDINGS_KEY] = [];
      bind(ORIGIN, "e1", undefined, null);
      expect(await answer(challenge())).toEqual({});
      expect(deps.openPrompt).not.toHaveBeenCalled();
    });

    it("control: the same binding under its own account is answered", async () => {
      local[HTTP_AUTH_BINDINGS_KEY] = [];
      bind(ORIGIN, "e1", undefined, USER);
      expect(await answer(challenge())).toEqual(SENT);
    });

    it("a binding taken over by another account while the window was open gets {}", async () => {
      deps.openPrompt.mockImplementationOnce(async () => {
        local[HTTP_AUTH_BINDINGS_KEY] = [{ origin: ORIGIN, entryId: "e1", userId: "user-2" }];
        return "send";
      });
      expect(await answer(challenge())).toEqual({});
      expect(deps.fetchAndDecryptEntry).not.toHaveBeenCalled();
    });
  });

  describe("rule 7: the user's decision", () => {
    it("Cancel (also: window closed, timeout) gets {} and decrypts nothing", async () => {
      deps.openPrompt.mockResolvedValueOnce("cancel");
      expect(await answer(challenge())).toEqual({});
      expect(deps.fetchAndDecryptEntry).not.toHaveBeenCalled();
    });

    it("the full decrypt happens only after Send", async () => {
      const decision = deferred<"send" | "cancel">();
      deps.openPrompt.mockReturnValueOnce(decision.promise);
      const callback = vi.fn();
      const pending = handleAuthRequired(challenge(), callback);
      await vi.waitFor(() => expect(deps.openPrompt).toHaveBeenCalled());
      expect(deps.fetchAndDecryptEntry).not.toHaveBeenCalled();
      decision.resolve("send");
      await pending;
      expect(deps.fetchAndDecryptEntry).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(SENT);
    });

    it("the window shows the challenge and the cached overview, never the realm", async () => {
      await answer(challenge({ scheme: "Digest", initiator: "https://portal.example" }));
      const req = deps.openPrompt.mock.calls[0][0];
      expect(req).toEqual({
        requestId: expect.any(String),
        tabId: 7,
        url: `${ORIGIN}/admin`,
        origin: ORIGIN,
        initiator: "https://portal.example",
        scheme: "digest",
        entryTitle: "Intranet",
        entryUsername: "alice",
        insecure: false,
      });
    });

    it("an http origin is flagged insecure for the window, Digest too", async () => {
      bind("http://router.example");
      await answer(challenge({ url: "http://router.example/", scheme: "digest", challenger: { host: "router.example", port: 80 } }));
      expect(deps.openPrompt.mock.calls[0][0]).toMatchObject({ insecure: true, initiator: null });
    });

    it("an entry missing from the overview cache gets {} with no window", async () => {
      deps.getEntryOverview.mockResolvedValueOnce(null);
      expect(await answer(challenge())).toEqual({});
      expect(deps.openPrompt).not.toHaveBeenCalled();
    });

    it("a non-LOGIN overview gets {} with no window", async () => {
      deps.getEntryOverview.mockResolvedValueOnce({ title: "Card", username: "", entryType: "CREDIT_CARD" });
      expect(await answer(challenge())).toEqual({});
      expect(deps.openPrompt).not.toHaveBeenCalled();
    });
  });

  describe("after Send: rules 4 and 9 again", () => {
    it("a binding replaced while the window was open gets {}", async () => {
      deps.openPrompt.mockImplementationOnce(async () => {
        local[HTTP_AUTH_BINDINGS_KEY] = [{ origin: ORIGIN, entryId: "e2", userId: USER }];
        return "send";
      });
      expect(await answer(challenge())).toEqual({});
      expect(deps.fetchAndDecryptEntry).not.toHaveBeenCalled();
    });

    it("a binding removed while the window was open gets {}", async () => {
      deps.openPrompt.mockImplementationOnce(async () => {
        local[HTTP_AUTH_BINDINGS_KEY] = [];
        return "send";
      });
      expect(await answer(challenge())).toEqual({});
    });

    it("a permission revoked while the window was open gets {}", async () => {
      deps.openPrompt.mockImplementationOnce(async () => {
        chromeMock.permissions.contains.mockResolvedValue(false);
        return "send";
      });
      expect(await answer(challenge())).toEqual({});
      expect(deps.fetchAndDecryptEntry).not.toHaveBeenCalled();
    });
  });

  describe("rule 8: the vault state from the challenge through the decrypt", () => {
    it("a lock while the window was open gets {}", async () => {
      deps.openPrompt.mockImplementationOnce(async () => {
        epoch += 1;
        return "send";
      });
      expect(await answer(challenge())).toEqual({});
      expect(deps.fetchAndDecryptEntry).not.toHaveBeenCalled();
    });

    it("a lock during the decrypt gets {}", async () => {
      deps.fetchAndDecryptEntry.mockImplementationOnce(async () => {
        epoch += 1;
        return LOGIN_ACCESS;
      });
      expect(await answer(challenge())).toEqual({});
    });

    it("the decrypt is asked for the epoch the challenge captured", async () => {
      await answer(challenge());
      expect(deps.fetchAndDecryptEntry).toHaveBeenCalledWith("e1", undefined, 1);
    });
  });

  describe("rule 9: the decrypted entry still qualifies", () => {
    it("an https-saved entry on an http challenge gets {}", async () => {
      bind("http://intranet.example");
      expect(
        await answer(challenge({ url: "http://intranet.example/", challenger: { host: "intranet.example", port: 80 } })),
      ).toEqual({});
    });

    it("a failed decrypt gets {}", async () => {
      deps.fetchAndDecryptEntry.mockResolvedValueOnce({ ok: false, error: "VAULT_LOCKED" });
      expect(await answer(challenge())).toEqual({});
    });
  });

  describe("deadline and errors", () => {
    it("a decrypt that hangs past the deadline gets {}, and its late result is dropped", async () => {
      vi.useFakeTimers();
      const late = deferred<EntryAccess>();
      deps.fetchAndDecryptEntry.mockReturnValueOnce(late.promise);
      const callback = vi.fn();
      const pending = handleAuthRequired(challenge(), callback);
      await vi.advanceTimersByTimeAsync(DECRYPT_DEADLINE_MS);
      await pending;
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith({});
      late.resolve(LOGIN_ACCESS);
      await vi.advanceTimersByTimeAsync(0);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("control: a decrypt just inside the deadline is answered", async () => {
      vi.useFakeTimers();
      const slow = deferred<EntryAccess>();
      deps.fetchAndDecryptEntry.mockReturnValueOnce(slow.promise);
      const callback = vi.fn();
      const pending = handleAuthRequired(challenge(), callback);
      await vi.advanceTimersByTimeAsync(DECRYPT_DEADLINE_MS - 1);
      slow.resolve(LOGIN_ACCESS);
      await pending;
      expect(callback).toHaveBeenCalledWith(SENT);
    });

    it("an overview read that hangs past the deadline gets {} once, with no window", async () => {
      vi.useFakeTimers();
      deps.getEntryOverview.mockReturnValueOnce(new Promise(() => {}));
      const callback = vi.fn();
      const pending = handleAuthRequired(challenge(), callback);
      await vi.advanceTimersByTimeAsync(DECRYPT_DEADLINE_MS);
      await pending;
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith({});
      expect(deps.openPrompt).not.toHaveBeenCalled();
    });

    it("control: an overview read just inside the deadline goes on to the window", async () => {
      vi.useFakeTimers();
      const slow = deferred<{ title: string; username: string; entryType: string }>();
      deps.getEntryOverview.mockReturnValueOnce(slow.promise);
      const callback = vi.fn();
      const pending = handleAuthRequired(challenge(), callback);
      await vi.advanceTimersByTimeAsync(DECRYPT_DEADLINE_MS - 1);
      slow.resolve({ title: "Intranet", username: "alice", entryType: "LOGIN" });
      await pending;
      expect(callback).toHaveBeenCalledWith(SENT);
    });

    it("a thrown error gets {} exactly once", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      deps.getEntryOverview.mockRejectedValueOnce(new Error("VAULT_LOCKED"));
      expect(await answer(challenge())).toEqual({});
    });

    it("a callback that throws is not called again", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const callback = vi.fn(() => {
        throw new Error("port closed");
      });
      await handleAuthRequired(challenge(), callback);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("before initHttpAuth every challenge gets {}", async () => {
      vi.resetModules();
      const fresh = await import("../../background/http-auth");
      const callback = vi.fn();
      await fresh.handleAuthRequired(challenge(), callback);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith({});
    });
  });
});

// ── The shared entry predicate (C3 and rule 9) ───────────────────

describe("credentialsForOrigin", () => {
  const login = (blob: Record<string, unknown>, overview: Record<string, unknown> = { username: "alice" }, entryType = "LOGIN"): EntryAccess =>
    ({ ok: true, blob, overview, entryType }) as EntryAccess;

  it.each<[string, EntryAccess, string, AuthAnswer["authCredentials"] | null]>([
    ["a LOGIN saved for exactly the origin", login({ url: "https://h.example/x", password: "p" }), "https://h.example", { username: "alice", password: "p" }],
    ["the blob username when the overview has none", login({ url: "https://h.example/", username: "bob", password: "p" }, {}), "https://h.example", { username: "bob", password: "p" }],
    ["a url-type custom field match", login({ url: "https://other.example/", customFields: [{ type: "URL", value: "http://h.example:8080/" }], password: "p" }), "http://h.example:8080", { username: "alice", password: "p" }],
    ["an https url for an http origin", login({ url: "https://h.example/", password: "p" }), "http://h.example", null],
    ["a url on another port", login({ url: "https://h.example:8443/", password: "p" }), "https://h.example", null],
    ["a text custom field with the url", login({ customFields: [{ type: "text", value: "https://h.example/" }], password: "p" }), "https://h.example", null],
    ["an empty password", login({ url: "https://h.example/", password: "" }), "https://h.example", null],
    ["an empty username", login({ url: "https://h.example/", password: "p", username: "" }, { username: "" }), "https://h.example", null],
    ["a non-LOGIN entry", login({ url: "https://h.example/", password: "p" }, { username: "alice" }, "CREDIT_CARD"), "https://h.example", null],
    ["a failed access", { ok: false, error: "FETCH_FAILED" }, "https://h.example", null],
  ])("%s", (_name, access, origin, expected) => {
    expect(credentialsForOrigin(access, origin)).toEqual(expected);
  });
});

// ── C3: registration ─────────────────────────────────────────────

describe("registerHttpAuthBinding (C3)", () => {
  const removed = () => chromeMock.permissions.remove.mock.calls.map(([arg]) => arg);

  beforeEach(() => {
    local[HTTP_AUTH_BINDINGS_KEY] = [];
  });

  it("control: stores the binding and registers the listener", async () => {
    expect(await registerHttpAuthBinding({ origin: ORIGIN, entryId: "e1" })).toEqual({ ok: true });
    expect(local[HTTP_AUTH_BINDINGS_KEY]).toEqual([{ origin: ORIGIN, entryId: "e1", userId: USER }]);
    expect(removed()).toEqual([]);
    expect(chromeMock.webRequest!.onAuthRequired.addListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.permissions.contains).toHaveBeenCalledWith({
      origins: [`${ORIGIN}/*`],
      permissions: ["webRequest", "webRequestAuthProvider"],
    });
  });

  it("stores a team binding with its teamId", async () => {
    expect(await registerHttpAuthBinding({ origin: ORIGIN, entryId: "e1", teamId: "t1" })).toEqual({ ok: true });
    expect(deps.fetchAndDecryptEntry).toHaveBeenCalledWith("e1", "t1", 1);
    expect(local[HTTP_AUTH_BINDINGS_KEY]).toEqual([{ origin: ORIGIN, entryId: "e1", teamId: "t1", userId: USER }]);
  });

  it("allows a url-type custom field match", async () => {
    deps.fetchAndDecryptEntry.mockResolvedValueOnce({
      ...LOGIN_ACCESS,
      blob: { url: "https://elsewhere.example/", customFields: [{ type: "url", value: `${ORIGIN}/admin` }], password: "p" },
    } as EntryAccess);
    expect(await registerHttpAuthBinding({ origin: ORIGIN, entryId: "e1" })).toEqual({ ok: true });
  });

  const ROLLED_BACK = [{ origins: [`${ORIGIN}/*`] }, { permissions: ["webRequest", "webRequestAuthProvider"] }];

  it.each<[string, () => void, string]>([
    ["a locked vault", () => { unlocked = false; }, "VAULT_LOCKED"],
    ["missing permissions", () => { chromeMock.permissions.contains.mockResolvedValue(false); }, "HTTP_AUTH_PERMISSION_DENIED"],
    ["a non-LOGIN entry", () => { deps.fetchAndDecryptEntry.mockResolvedValueOnce({ ...LOGIN_ACCESS, entryType: "IDENTITY" } as EntryAccess); }, "HTTP_AUTH_ENTRY_MISMATCH"],
    ["an empty username", () => { deps.fetchAndDecryptEntry.mockResolvedValueOnce({ ...LOGIN_ACCESS, overview: { username: "" } } as EntryAccess); }, "HTTP_AUTH_ENTRY_MISMATCH"],
    ["an empty password", () => { deps.fetchAndDecryptEntry.mockResolvedValueOnce({ ...LOGIN_ACCESS, blob: { url: `${ORIGIN}/`, password: "" } } as EntryAccess); }, "HTTP_AUTH_ENTRY_MISMATCH"],
    ["an origin mismatch", () => { deps.fetchAndDecryptEntry.mockResolvedValueOnce({ ...LOGIN_ACCESS, blob: { url: "https://intranet.example:8443/", password: "p" } } as EntryAccess); }, "HTTP_AUTH_ENTRY_MISMATCH"],
    ["a fetch failure", () => { deps.fetchAndDecryptEntry.mockResolvedValueOnce({ ok: false, error: "FETCH_FAILED" }); }, "FETCH_FAILED"],
    ["a lock during the decrypt", () => { deps.fetchAndDecryptEntry.mockImplementationOnce(async () => { epoch += 1; return LOGIN_ACCESS; }); }, "VAULT_LOCKED"],
  ])("rejects %s, stores nothing and rolls the permissions back", async (_name, arrange, error) => {
    arrange();
    expect(await registerHttpAuthBinding({ origin: ORIGIN, entryId: "e1" })).toEqual({ ok: false, error });
    expect(local[HTTP_AUTH_BINDINGS_KEY]).toEqual([]);
    expect(removed()).toEqual(ROLLED_BACK);
  });

  it("rejects a non-serialized origin and rolls back its normalized pattern", async () => {
    expect(await registerHttpAuthBinding({ origin: `${ORIGIN}/admin`, entryId: "e1" })).toEqual({
      ok: false,
      error: "INVALID_URL",
    });
    expect(deps.fetchAndDecryptEntry).not.toHaveBeenCalled();
    expect(removed()).toEqual(ROLLED_BACK);
  });

  it.each(["not a url", "ftp://intranet.example", 42])("rejects the malformed origin %j", async (origin) => {
    expect(await registerHttpAuthBinding({ origin, entryId: "e1" })).toEqual({ ok: false, error: "INVALID_URL" });
    expect(deps.fetchAndDecryptEntry).not.toHaveBeenCalled();
  });

  it.each([["../x", undefined], ["e1", "t 1"], [5, undefined]])("rejects the malformed ids %j / %j", async (entryId, teamId) => {
    expect(await registerHttpAuthBinding({ origin: ORIGIN, entryId, teamId })).toEqual({
      ok: false,
      error: "HTTP_AUTH_ENTRY_MISMATCH",
    });
    expect(deps.fetchAndDecryptEntry).not.toHaveBeenCalled();
    expect(removed()).toEqual(ROLLED_BACK);
  });

  it("a rollback keeps what another binding needs", async () => {
    bind("https://intranet.example:9443", "e9");
    unlocked = false;
    expect(await registerHttpAuthBinding({ origin: ORIGIN, entryId: "e1" })).toEqual({ ok: false, error: "VAULT_LOCKED" });
    // The portless pattern covers :9443, and a binding remains.
    expect(removed()).toEqual([]);
  });

  it("is idempotent: a second completion for the same account is a no-op that keeps everything", async () => {
    expect(await registerHttpAuthBinding({ origin: ORIGIN, entryId: "e1" })).toEqual({ ok: true });
    expect(await registerHttpAuthBinding({ origin: ORIGIN, entryId: "e1" })).toEqual({ ok: true });
    expect(deps.fetchAndDecryptEntry).toHaveBeenCalledTimes(1);
    expect(local[HTTP_AUTH_BINDINGS_KEY]).toEqual([{ origin: ORIGIN, entryId: "e1", userId: USER }]);
    expect(removed()).toEqual([]);
  });

  it("a second completion after a lock keeps the binding and the permissions", async () => {
    expect(await registerHttpAuthBinding({ origin: ORIGIN, entryId: "e1" })).toEqual({ ok: true });
    unlocked = false;
    expect(await registerHttpAuthBinding({ origin: ORIGIN, entryId: "e1" })).toEqual({ ok: false, error: "VAULT_LOCKED" });
    expect(local[HTTP_AUTH_BINDINGS_KEY]).toEqual([{ origin: ORIGIN, entryId: "e1", userId: USER }]);
    expect(removed()).toEqual([]);
  });

  it("re-registering another account's binding for the same entry runs the checks and takes it over", async () => {
    bind(ORIGIN, "e1", undefined, "user-2");
    expect(await registerHttpAuthBinding({ origin: ORIGIN, entryId: "e1" })).toEqual({ ok: true });
    expect(deps.fetchAndDecryptEntry).toHaveBeenCalledTimes(1);
    expect(local[HTTP_AUTH_BINDINGS_KEY]).toEqual([{ origin: ORIGIN, entryId: "e1", userId: USER }]);
  });

  it("control: registering another entry for a bound origin runs the checks", async () => {
    bind(ORIGIN, "e0");
    expect(await registerHttpAuthBinding({ origin: ORIGIN, entryId: "e1" })).toEqual({ ok: true });
    expect(deps.fetchAndDecryptEntry).toHaveBeenCalledTimes(1);
    expect(local[HTTP_AUTH_BINDINGS_KEY]).toEqual([{ origin: ORIGIN, entryId: "e1", userId: USER }]);
  });
});

// ── C3: the pending intent ───────────────────────────────────────

describe("pending intent (C3)", () => {
  const PATTERN = `${ORIGIN}/*`;
  const write = (over: Record<string, unknown> = {}) => {
    session[HTTP_AUTH_PENDING_INTENT_KEY] = {
      nonce: "n1",
      origin: ORIGIN,
      entryId: "e1",
      expiresAt: Date.now() + 60_000,
      ...over,
    };
  };

  beforeEach(() => {
    local[HTTP_AUTH_BINDINGS_KEY] = [];
  });

  it("onAdded completes a fresh intent whose pattern was added, and clears the slot", async () => {
    write();
    await completePendingIntent([PATTERN]);
    expect(local[HTTP_AUTH_BINDINGS_KEY]).toEqual([{ origin: ORIGIN, entryId: "e1", userId: USER }]);
    expect(session[HTTP_AUTH_PENDING_INTENT_KEY]).toBeUndefined();
  });

  it("does nothing for a grant of another origin", async () => {
    write();
    await completePendingIntent(["https://other.example/*"]);
    expect(local[HTTP_AUTH_BINDINGS_KEY]).toEqual([]);
    expect(session[HTTP_AUTH_PENDING_INTENT_KEY]).toBeDefined();
  });

  it("does nothing while the API permissions are missing", async () => {
    write();
    chromeMock.permissions.contains.mockImplementation(async (req) => !req.permissions);
    await completePendingIntent([PATTERN]);
    expect(local[HTTP_AUTH_BINDINGS_KEY]).toEqual([]);
    // Left for the API grant still to come: neither consumed nor rolled back.
    expect(session[HTTP_AUTH_PENDING_INTENT_KEY]).toBeDefined();
    expect(chromeMock.permissions.remove).not.toHaveBeenCalled();
  });

  it("drops an expired intent without registering", async () => {
    write({ expiresAt: Date.now() - 1 });
    await completePendingIntent([PATTERN]);
    expect(local[HTTP_AUTH_BINDINGS_KEY]).toEqual([]);
    expect(session[HTTP_AUTH_PENDING_INTENT_KEY]).toBeUndefined();
  });

  it("at SW start (no added list) completes an intent whose origin is already granted", async () => {
    write();
    await completePendingIntent(null);
    expect(local[HTTP_AUTH_BINDINGS_KEY]).toEqual([{ origin: ORIGIN, entryId: "e1", userId: USER }]);
    expect(deps.awaitHydrationBounded).toHaveBeenCalled();
  });

  it("control: at SW start, an origin not granted leaves the intent alone", async () => {
    write();
    chromeMock.permissions.contains.mockImplementation(async (req) => !req.origins);
    await completePendingIntent(null);
    expect(local[HTTP_AUTH_BINDINGS_KEY]).toEqual([]);
    expect(session[HTTP_AUTH_PENDING_INTENT_KEY]).toBeDefined();
  });

  it("clearPendingIntent clears only the named intent", async () => {
    write();
    await clearPendingIntent("other");
    expect(session[HTTP_AUTH_PENDING_INTENT_KEY]).toBeDefined();
    await clearPendingIntent("n1");
    expect(session[HTTP_AUTH_PENDING_INTENT_KEY]).toBeUndefined();
  });
});

// ── C6: listener lifecycle ───────────────────────────────────────

describe("listener lifecycle (C6)", () => {
  it("registers the asyncBlocking listener for top-level navigations", () => {
    registerHttpAuthListeners();
    const auth = chromeMock.webRequest!.onAuthRequired;
    expect(auth.addListener).toHaveBeenCalledTimes(1);
    expect(auth.addListener).toHaveBeenCalledWith(
      expect.any(Function),
      { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
      ["asyncBlocking"],
    );
    expect(chromeMock.webRequest!.onErrorOccurred.addListener).toHaveBeenCalledTimes(1);
  });

  it("a second registration is a no-op", () => {
    registerHttpAuthListeners();
    registerHttpAuthListeners();
    expect(chromeMock.webRequest!.onAuthRequired.addListener).toHaveBeenCalledTimes(1);
  });

  it("without chrome.webRequest (not granted) nothing throws and permission events are still wired", () => {
    chromeMock = installChrome({ webRequest: false });
    expect(() => installHttpAuthLifecycle()).not.toThrow();
    expect(chromeMock.permissions.onAdded.addListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.permissions.onRemoved.addListener).toHaveBeenCalledTimes(1);
  });

  it("without chrome.permissions events (older mocks) nothing throws", () => {
    vi.stubGlobal("chrome", { ...chromeMock, permissions: { contains: vi.fn(async () => false) } });
    expect(() => installHttpAuthLifecycle()).not.toThrow();
  });

  it("an addListener throw is logged and does not stop the rest of the install", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    chromeMock.webRequest!.onAuthRequired.addListener.mockImplementation(() => {
      throw new Error("Unchecked runtime.lastError");
    });
    expect(() => installHttpAuthLifecycle()).not.toThrow();
    expect(chromeMock.permissions.onAdded.addListener).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[passwd-sso] http-auth-listener-register-failed: error");
  });

  it("onAdded with the API permissions registers the challenge listener", async () => {
    const webRequest = chromeMock.webRequest;
    chromeMock = installChrome({ webRequest: false });
    installHttpAuthLifecycle();
    // The grant makes the namespace appear.
    (chrome as unknown as { webRequest: unknown }).webRequest = webRequest;
    const [onAdded] = [...chromeMock.permissions.onAdded.listeners] as Array<(p: chrome.permissions.Permissions) => void>;
    onAdded({ permissions: ["webRequest", "webRequestAuthProvider"], origins: [] });
    await vi.waitFor(() => expect(webRequest!.onAuthRequired.addListener).toHaveBeenCalledTimes(1));
  });

  it("onAdded for an unrelated permission does not register", async () => {
    const webRequest = chromeMock.webRequest;
    chromeMock = installChrome({ webRequest: false });
    installHttpAuthLifecycle();
    (chrome as unknown as { webRequest: unknown }).webRequest = webRequest;
    const [onAdded] = [...chromeMock.permissions.onAdded.listeners] as Array<(p: chrome.permissions.Permissions) => void>;
    onAdded({ permissions: ["clipboardRead"], origins: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(webRequest!.onAuthRequired.addListener).not.toHaveBeenCalled();
  });

  it("onRemoved for the API permissions unregisters", () => {
    installHttpAuthLifecycle();
    const [onRemoved] = [...chromeMock.permissions.onRemoved.listeners] as Array<(p: chrome.permissions.Permissions) => void>;
    onRemoved({ permissions: ["webRequestAuthProvider"] });
    expect(chromeMock.webRequest!.onAuthRequired.removeListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.webRequest!.onAuthRequired.listeners.size).toBe(0);
  });

  it("onRemoved with the namespace already gone does not throw", () => {
    installHttpAuthLifecycle();
    const [onRemoved] = [...chromeMock.permissions.onRemoved.listeners] as Array<(p: chrome.permissions.Permissions) => void>;
    (chrome as unknown as { webRequest: unknown }).webRequest = undefined;
    expect(() => onRemoved({ permissions: ["webRequest"] })).not.toThrow();
  });

  it("the registered listener answers through asyncCallback", async () => {
    registerHttpAuthListeners();
    const [listener] = [...chromeMock.webRequest!.onAuthRequired.listeners] as Array<
      (d: AuthChallenge, cb: (a: AuthAnswer) => void) => unknown
    >;
    const callback = vi.fn();
    expect(listener(challenge(), callback)).toBeUndefined();
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(SENT));
  });
});
