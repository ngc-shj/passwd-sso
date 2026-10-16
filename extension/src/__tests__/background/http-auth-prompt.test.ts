import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PROMPT_COOLDOWN_MS,
  PROMPT_PAGE,
  PROMPT_TIMEOUT_MS,
  decidePrompt,
  getPromptView,
  handlePromptRequestError,
  handlePromptTabRemoved,
  handlePromptWindowRemoved,
  openPrompt,
  registerPromptListeners,
  resetHttpAuthPrompts,
  type PromptRequest,
} from "../../background/http-auth-prompt";

let nextWindowId: number;
let chromeMock: ReturnType<typeof installChrome>;

function installChrome() {
  nextWindowId = 100;
  const mock = {
    runtime: { getURL: vi.fn((path: string) => `chrome-extension://ext-id/${path}`) },
    tabs: {
      get: vi.fn(async (id: number) => ({ id, windowId: 5 })),
      onRemoved: { addListener: vi.fn(), hasListener: vi.fn(() => false) },
    },
    windows: {
      get: vi.fn(async () => ({ id: 5, left: 100, top: 50, width: 1240, height: 800 })),
      create: vi.fn(async (_params: chrome.windows.CreateData) => ({ id: nextWindowId++ })),
      remove: vi.fn(async () => {}),
      onRemoved: { addListener: vi.fn(), hasListener: vi.fn(() => false) },
    },
  };
  vi.stubGlobal("chrome", mock);
  return mock;
}

const request = (over: Partial<PromptRequest> = {}): PromptRequest => ({
  requestId: "req-1",
  tabId: 7,
  url: "https://intranet.example/admin",
  origin: "https://intranet.example",
  initiator: null,
  redirectedFrom: null,
  scheme: "basic",
  entryTitle: "Intranet",
  entryUsername: "alice",
  insecure: false,
  ...over,
});

const tick = () => new Promise((r) => setTimeout(r, 0));

/** The prompt id from the window URL the SW opened. */
function promptIdOf(callIndex = 0): string {
  const { url } = chromeMock.windows.create.mock.calls[callIndex][0] as { url: string };
  return new URL(url).searchParams.get("id") ?? "";
}

async function opened(count = 1): Promise<void> {
  await vi.waitFor(() => expect(chromeMock.windows.create).toHaveBeenCalledTimes(count));
}

beforeEach(() => {
  chromeMock = installChrome();
  resetHttpAuthPrompts();
});

afterEach(() => {
  resetHttpAuthPrompts();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("openPrompt", () => {
  it("opens a popup window on the prompt page, placed over the tab's window", async () => {
    void openPrompt(request());
    await opened();
    expect(chromeMock.windows.create).toHaveBeenCalledWith({
      url: expect.stringMatching(new RegExp(`^chrome-extension://ext-id/${PROMPT_PAGE}\\?id=`)),
      type: "popup",
      width: 440,
      height: 460,
      focused: true,
      left: 500,
      top: 130,
    });
    expect(chromeMock.tabs.get).toHaveBeenCalledWith(7);
    expect(chromeMock.windows.get).toHaveBeenCalledWith(5);
  });

  it("opens unplaced when the tab's window cannot be read", async () => {
    chromeMock.tabs.get.mockRejectedValueOnce(new Error("No tab"));
    void openPrompt(request());
    await opened();
    const params = chromeMock.windows.create.mock.calls[0][0] as Record<string, unknown>;
    expect(params.left).toBeUndefined();
    expect(params.top).toBeUndefined();
  });

  it("keeps negative window coordinates (a display left of or above the primary)", async () => {
    chromeMock.windows.get.mockResolvedValueOnce({ id: 5, left: -1920, top: -200, width: 1920, height: 1080 });
    void openPrompt(request());
    await opened();
    expect(chromeMock.windows.create).toHaveBeenCalledWith(expect.objectContaining({ left: -1180, top: -120 }));
  });

  it("retries once unplaced when a placed window cannot be created", async () => {
    chromeMock.windows.create.mockRejectedValueOnce(new Error("Invalid value for bounds"));
    const decision = openPrompt(request());
    await opened(2);
    const retry = chromeMock.windows.create.mock.calls[1][0] as Record<string, unknown>;
    expect(retry.left).toBeUndefined();
    expect(retry.top).toBeUndefined();
    await tick();
    expect(decidePrompt(promptIdOf(1), "send")).toBe(true);
    await expect(decision).resolves.toBe("send");
  });

  it("cancels when the unplaced retry fails too", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    chromeMock.windows.create.mockRejectedValue(new Error("no windows"));
    await expect(openPrompt(request())).resolves.toBe("cancel");
    expect(chromeMock.windows.create).toHaveBeenCalledTimes(2);
  });

  it("cancels promptly when windows.create resolves without an id", async () => {
    chromeMock.windows.create.mockResolvedValueOnce({} as { id: number });
    await expect(openPrompt(request())).resolves.toBe("cancel");
  });

  it("gives every prompt an unguessable id", async () => {
    const first = openPrompt(request());
    await opened();
    decidePrompt(promptIdOf(0), "cancel");
    await first;
    void openPrompt(request({ tabId: 8, requestId: "req-2" }));
    await opened(2);
    const [a, b] = [promptIdOf(0), promptIdOf(1)];
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  it("serves the view to its window, without the request or tab ids", async () => {
    void openPrompt(request());
    await opened();
    expect(getPromptView(promptIdOf())).toEqual({
      url: "https://intranet.example/admin",
      origin: "https://intranet.example",
      initiator: null,
      redirectedFrom: null,
      scheme: "basic",
      entryTitle: "Intranet",
      entryUsername: "alice",
      insecure: false,
    });
    expect(getPromptView("unknown")).toBeNull();
    expect(getPromptView(42)).toBeNull();
  });

  it("Send resolves send and closes the window", async () => {
    const decision = openPrompt(request());
    await opened();
    expect(decidePrompt(promptIdOf(), "send")).toBe(true);
    await expect(decision).resolves.toBe("send");
    expect(chromeMock.windows.remove).toHaveBeenCalledWith(100);
    expect(getPromptView(promptIdOf())).toBeNull();
  });

  it("Cancel resolves cancel", async () => {
    const decision = openPrompt(request());
    await opened();
    expect(decidePrompt(promptIdOf(), "cancel")).toBe(true);
    await expect(decision).resolves.toBe("cancel");
  });

  it("ignores an unknown id and an invalid decision", async () => {
    const decision = openPrompt(request());
    await opened();
    expect(decidePrompt("not-the-id", "send")).toBe(false);
    expect(decidePrompt(promptIdOf(), "allow")).toBe(false);
    expect(decidePrompt(promptIdOf(), "cancel")).toBe(true);
    await expect(decision).resolves.toBe("cancel");
  });

  it("drops a second decision for a settled prompt", async () => {
    const decision = openPrompt(request());
    await opened();
    const id = promptIdOf();
    expect(decidePrompt(id, "cancel")).toBe(true);
    expect(decidePrompt(id, "send")).toBe(false);
    await expect(decision).resolves.toBe("cancel");
  });

  it("closing the window resolves cancel", async () => {
    const decision = openPrompt(request());
    await opened();
    // The window id is recorded once windows.create resolves.
    await new Promise((r) => setTimeout(r, 0));
    handlePromptWindowRemoved(100);
    await expect(decision).resolves.toBe("cancel");
  });

  it("control: closing another window leaves it pending", async () => {
    const decision = openPrompt(request());
    await opened();
    await new Promise((r) => setTimeout(r, 0));
    handlePromptWindowRemoved(999);
    expect(decidePrompt(promptIdOf(), "send")).toBe(true);
    await expect(decision).resolves.toBe("send");
  });

  it("closing the tab resolves cancel", async () => {
    const decision = openPrompt(request());
    await opened();
    handlePromptTabRemoved(7);
    await expect(decision).resolves.toBe("cancel");
  });

  it("control: closing another tab leaves it pending", async () => {
    const decision = openPrompt(request());
    await opened();
    handlePromptTabRemoved(99);
    expect(decidePrompt(promptIdOf(), "send")).toBe(true);
    await expect(decision).resolves.toBe("send");
  });

  it("a webRequest error for its request resolves cancel", async () => {
    const decision = openPrompt(request());
    await opened();
    handlePromptRequestError("req-1");
    await expect(decision).resolves.toBe("cancel");
  });

  it("control: another request's error leaves it pending", async () => {
    const decision = openPrompt(request());
    await opened();
    handlePromptRequestError("req-other");
    expect(decidePrompt(promptIdOf(), "send")).toBe(true);
    await expect(decision).resolves.toBe("send");
  });

  it("times out after 60 s as cancel and closes the window", async () => {
    vi.useFakeTimers();
    const decision = openPrompt(request());
    await vi.advanceTimersByTimeAsync(0);
    expect(chromeMock.windows.create).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PROMPT_TIMEOUT_MS - 1);
    expect(getPromptView(promptIdOf())).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await expect(decision).resolves.toBe("cancel");
    expect(chromeMock.windows.remove).toHaveBeenCalledWith(100);
  });

  it("a request error ends only that request; the prompt ends when none remains", async () => {
    const first = openPrompt(request());
    const second = openPrompt(request({ requestId: "req-2" }));
    await opened();
    handlePromptRequestError("req-1");
    await tick();
    expect(getPromptView(promptIdOf())).not.toBeNull();
    handlePromptRequestError("req-2");
    await expect(first).resolves.toBe("cancel");
    await expect(second).resolves.toBe("cancel");
  });

  it("two challenges from one origin and tab share one window and its decision", async () => {
    const first = openPrompt(request());
    const second = openPrompt(request({ requestId: "req-2" }));
    await opened();
    await new Promise((r) => setTimeout(r, 0));
    expect(chromeMock.windows.create).toHaveBeenCalledTimes(1);
    decidePrompt(promptIdOf(), "send");
    await expect(first).resolves.toBe("send");
    await expect(second).resolves.toBe("send");
  });

  it.each<[string, Partial<PromptRequest>]>([
    ["another url", { url: "https://intranet.example/other" }],
    ["another initiator", { initiator: "https://evil.example" }],
    ["another scheme", { scheme: "digest" }],
    ["another redirect source", { redirectedFrom: "https://evil.example" }],
    ["another entry title", { entryTitle: "Other" }],
    ["another entry username", { entryUsername: "bob" }],
    ["another insecure flag", { insecure: true }],
  ])("a concurrent challenge with %s does not reuse the decision: it gets cancel at once", async (_name, over) => {
    const first = openPrompt(request());
    const other = openPrompt(request({ requestId: "req-2", ...over }));
    await expect(other).resolves.toBe("cancel");
    await opened();
    expect(decidePrompt(promptIdOf(), "send")).toBe(true);
    await expect(first).resolves.toBe("send");
    expect(chromeMock.windows.create).toHaveBeenCalledTimes(1);
  });


  it("a prompt settled before its window opened closes that window", async () => {
    let finishCreate!: (w: { id: number }) => void;
    chromeMock.windows.create.mockReturnValueOnce(new Promise((r) => { finishCreate = r; }));
    const decision = openPrompt(request());
    await opened();
    handlePromptTabRemoved(7);
    await expect(decision).resolves.toBe("cancel");
    finishCreate({ id: 321 });
    await vi.waitFor(() => expect(chromeMock.windows.remove).toHaveBeenCalledWith(321));
  });

  describe("one window at a time", () => {
    it("two concurrent prompts never have two windows; the queued one opens after the first settles", async () => {
      const first = openPrompt(request());
      const second = openPrompt(request({ tabId: 8, requestId: "req-2", origin: "https://nas.example", url: "https://nas.example/" }));
      await opened();
      await tick();
      expect(chromeMock.windows.create).toHaveBeenCalledTimes(1);
      decidePrompt(promptIdOf(0), "cancel");
      await expect(first).resolves.toBe("cancel");
      await opened(2);
      expect(getPromptView(promptIdOf(1))).toMatchObject({ origin: "https://nas.example" });
      expect(decidePrompt(promptIdOf(1), "send")).toBe(true);
      await expect(second).resolves.toBe("send");
    });

    it("a queued prompt is neither served nor decidable before it is shown", async () => {
      // Known ids, so the queued prompt's id can be tried before any window has it.
      let n = 0;
      const uuid = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
        n += 1;
        return `00000000-0000-4000-8000-00000000000${n}` as `${string}-${string}-${string}-${string}-${string}`;
      });
      try {
        const first = openPrompt(request());
        const second = openPrompt(request({ tabId: 8, requestId: "req-2" }));
        await opened();
        const queuedId = "00000000-0000-4000-8000-000000000002";
        expect(getPromptView(queuedId)).toBeNull();
        expect(decidePrompt(queuedId, "send")).toBe(false);
        expect(decidePrompt(promptIdOf(0), "cancel")).toBe(true);
        await first;
        await opened(2);
        expect(promptIdOf(1)).toBe(queuedId);
        expect(getPromptView(queuedId)).not.toBeNull();
        expect(decidePrompt(queuedId, "send")).toBe(true);
        await expect(second).resolves.toBe("send");
      } finally {
        uuid.mockRestore();
      }
    });

    it("a queued prompt cancelled while waiting leaves the queue: it never gets a window", async () => {
      const first = openPrompt(request());
      const second = openPrompt(request({ tabId: 8, requestId: "req-2" }));
      await opened();
      handlePromptTabRemoved(8);
      await expect(second).resolves.toBe("cancel");
      expect(decidePrompt(promptIdOf(0), "send")).toBe(true);
      await expect(first).resolves.toBe("send");
      await tick();
      expect(chromeMock.windows.create).toHaveBeenCalledTimes(1);
    });

    it("a queued prompt's 60 s runs from when it was queued (fail-closed)", async () => {
      vi.useFakeTimers();
      const settledAs: Record<string, string> = {};
      void openPrompt(request()).then((d) => (settledAs.first = d));
      void openPrompt(request({ tabId: 8, requestId: "req-2" })).then((d) => (settledAs.second = d));
      await vi.advanceTimersByTimeAsync(PROMPT_TIMEOUT_MS - 1);
      expect(settledAs).toEqual({});
      await vi.advanceTimersByTimeAsync(1);
      expect(settledAs).toEqual({ first: "cancel", second: "cancel" });
    });
  });

  describe("cooldown after a cross-site prompt ends without Send", () => {
    const crossSite = { initiator: "https://evil.example" };

    it("a queued cross-site prompt for an origin that went into cooldown settles cancel without a window", async () => {
      const first = openPrompt(request(crossSite));
      const second = openPrompt(request({ ...crossSite, tabId: 8, requestId: "req-2" }));
      await opened();
      decidePrompt(promptIdOf(), "cancel");
      await first;
      await expect(second).resolves.toBe("cancel");
      await tick();
      expect(chromeMock.windows.create).toHaveBeenCalledTimes(1);
    });

    it("control: a queued prompt with no initiator still opens after the cooldown starts", async () => {
      const first = openPrompt(request(crossSite));
      void openPrompt(request({ initiator: null, tabId: 8, requestId: "req-2" }));
      await opened();
      decidePrompt(promptIdOf(), "cancel");
      await first;
      await opened(2);
    });

    it("a challenge with no initiator is not held by the cooldown", async () => {
      const first = openPrompt(request(crossSite));
      await opened();
      decidePrompt(promptIdOf(), "cancel");
      await first;
      void openPrompt(request({ initiator: null, requestId: "req-2" }));
      await opened(2);
    });

    it("answers cancel without a window for 10 s", async () => {
      vi.useFakeTimers();
      const first = openPrompt(request(crossSite));
      await vi.advanceTimersByTimeAsync(0);
      decidePrompt(promptIdOf(), "cancel");
      await first;
      await expect(openPrompt(request({ ...crossSite, requestId: "req-2" }))).resolves.toBe("cancel");
      expect(chromeMock.windows.create).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(PROMPT_COOLDOWN_MS);
      void openPrompt(request({ ...crossSite, requestId: "req-3" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(chromeMock.windows.create).toHaveBeenCalledTimes(2);
    });

    it.each<[string, Partial<PromptRequest>]>([
      ["no initiator", { initiator: null }],
      ["a same-origin initiator", { initiator: "https://intranet.example" }],
    ])("control: %s starts no cooldown", async (_name, over) => {
      const first = openPrompt(request(over));
      await opened();
      decidePrompt(promptIdOf(), "cancel");
      await first;
      void openPrompt(request({ ...crossSite, requestId: "req-2" }));
      await opened(2);
    });

    it("control: Send starts no cooldown", async () => {
      const first = openPrompt(request(crossSite));
      await opened();
      decidePrompt(promptIdOf(), "send");
      await first;
      void openPrompt(request({ ...crossSite, requestId: "req-2" }));
      await opened(2);
    });

    it("control: another origin is not cooled down", async () => {
      const first = openPrompt(request(crossSite));
      await opened();
      decidePrompt(promptIdOf(), "cancel");
      await first;
      void openPrompt(request({ ...crossSite, requestId: "req-2", origin: "https://nas.example", url: "https://nas.example/" }));
      await opened(2);
    });
  });

  it("after a decision, a new challenge opens a new window", async () => {
    const first = openPrompt(request());
    await opened();
    decidePrompt(promptIdOf(), "cancel");
    await first;
    void openPrompt(request({ requestId: "req-2" }));
    await opened(2);
  });
});

describe("registerPromptListeners", () => {
  it("wires window and tab removal, once", () => {
    registerPromptListeners();
    expect(chromeMock.windows.onRemoved.addListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.tabs.onRemoved.addListener).toHaveBeenCalledTimes(1);
    chromeMock.windows.onRemoved.hasListener.mockReturnValue(true);
    chromeMock.tabs.onRemoved.hasListener.mockReturnValue(true);
    registerPromptListeners();
    expect(chromeMock.windows.onRemoved.addListener).toHaveBeenCalledTimes(1);
  });

  it("does not throw without chrome.windows", () => {
    vi.stubGlobal("chrome", { tabs: chromeMock.tabs });
    expect(() => registerPromptListeners()).not.toThrow();
  });
});
