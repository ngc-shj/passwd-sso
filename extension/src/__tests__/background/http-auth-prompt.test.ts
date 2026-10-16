import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
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
  scheme: "basic",
  entryTitle: "Intranet",
  entryUsername: "alice",
  insecure: false,
  ...over,
});

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
      height: 420,
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

  it("gives every prompt an unguessable id", async () => {
    void openPrompt(request());
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

  it("control: the same origin in another tab gets its own window", async () => {
    void openPrompt(request());
    void openPrompt(request({ tabId: 8, requestId: "req-2" }));
    await opened(2);
  });

  it("a window that cannot be created resolves cancel", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    chromeMock.windows.create.mockRejectedValueOnce(new Error("no windows"));
    await expect(openPrompt(request())).resolves.toBe("cancel");
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
