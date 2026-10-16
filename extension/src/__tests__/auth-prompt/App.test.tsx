/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { HttpAuthPromptView } from "../../types/messages";
import { HTTP_AUTH_PROMPT_TIMEOUT_MS } from "../../lib/constants";

const mockSendMessage = vi.fn();
vi.mock("../../lib/messaging", () => ({
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
}));

import { App, SEND_ARM_DELAY_MS, URL_DISPLAY_MAX, displayUrl } from "../../auth-prompt/App";

const VIEW: HttpAuthPromptView = {
  url: "http://router.example:8080/admin",
  origin: "http://router.example:8080",
  initiator: "https://portal.example",
  redirectedFrom: null,
  scheme: "basic",
  entryTitle: "Router",
  entryUsername: "admin",
  insecure: true,
};

let focused: boolean;
let visibility: DocumentVisibilityState;

function decisions(): unknown[] {
  return mockSendMessage.mock.calls
    .map(([msg]) => msg as { type: string; decision?: string })
    .filter((m) => m.type === "HTTP_AUTH_PROMPT_DECIDE")
    .map((m) => m.decision);
}

async function renderPrompt(view: HttpAuthPromptView | null = VIEW, promptId: string | null = "p-1") {
  mockSendMessage.mockImplementation(async (msg: { type: string }) =>
    msg.type === "HTTP_AUTH_PROMPT_GET"
      ? { type: msg.type, prompt: view }
      : { type: msg.type, ok: true },
  );
  render(<App promptId={promptId} />);
  // Let the GET resolve and the view render.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const sendButton = () => screen.getByRole("button", { name: "Send" });
const isArmed = () => sendButton().getAttribute("aria-disabled") === "false";
/** A full pointer press on Send: pointerdown, then a pointer click (detail 1). */
const pressSend = () => {
  fireEvent.pointerDown(sendButton());
  fireEvent.click(sendButton(), { detail: 1 });
};

beforeEach(() => {
  vi.useFakeTimers();
  mockSendMessage.mockReset();
  focused = true;
  visibility = "visible";
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  vi.stubGlobal("close", vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("auth-prompt page", () => {
  it("asks the SW for its own prompt id", async () => {
    await renderPrompt();
    expect(mockSendMessage).toHaveBeenCalledWith({ type: "HTTP_AUTH_PROMPT_GET", promptId: "p-1" });
  });

  it("shows the site, address, initiator, login and scheme", async () => {
    await renderPrompt();
    expect(screen.getByText("http://router.example:8080")).toBeInTheDocument();
    expect(screen.getByText("http://router.example:8080/admin")).toBeInTheDocument();
    expect(screen.getByText("Triggered by")).toBeInTheDocument();
    expect(screen.getByText("https://portal.example")).toBeInTheDocument();
    expect(screen.getByText("Router (admin)")).toBeInTheDocument();
    expect(screen.getByTestId("auth-method")).toHaveTextContent("Method: Basic");
  });

  it("does not claim the address bar when no initiator was reported", async () => {
    await renderPrompt({ ...VIEW, initiator: null });
    expect(
      screen.getByText("Not from a web page (address bar, bookmark, another app, or a redirect)"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Address bar or bookmark$/)).toBeNull();
  });

  it("names the origin a redirect came from", async () => {
    await renderPrompt({ ...VIEW, initiator: null, redirectedFrom: "https://evil.example" });
    expect(screen.getByText("Redirected from")).toBeInTheDocument();
    expect(screen.getByText("https://evil.example")).toBeInTheDocument();
  });

  it("control: no redirect row without a redirect", async () => {
    await renderPrompt();
    expect(screen.queryByText("Redirected from")).toBeNull();
  });

  it("shows the http warning for an insecure origin", async () => {
    await renderPrompt();
    expect(screen.getByRole("alert")).toHaveTextContent(/plain HTTP/);
  });

  it("control: no warning for an https origin", async () => {
    await renderPrompt({ ...VIEW, origin: "https://router.example", url: "https://router.example/", insecure: false, scheme: "digest" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("auth-method")).toHaveTextContent("Digest");
  });

  it("puts the warning and the method above the details", async () => {
    await renderPrompt();
    const details = document.querySelector("dl") as HTMLElement;
    for (const above of [screen.getByRole("alert"), screen.getByTestId("auth-method")]) {
      expect(above.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("cuts a long address, keeping the origin whole", async () => {
    const longUrl = `http://router.example:8080/${"a".repeat(300)}`;
    await renderPrompt({ ...VIEW, url: longUrl });
    const shown = screen.getByText(/^http:\/\/router\.example:8080\/a+…$/).textContent ?? "";
    expect(shown.length).toBe(URL_DISPLAY_MAX);
    expect(screen.queryByText(longUrl)).toBeNull();
  });

  it.each([
    ["a short url is unchanged", "https://h.example/x", "https://h.example/x"],
    ["a long path is cut with an ellipsis", `https://h.example/${"p".repeat(200)}`, `https://h.example/${"p".repeat(101)}…`],
    ["an origin longer than the cap is kept whole", `https://${"h".repeat(130)}.example/x`, `https://${"h".repeat(130)}.example…`],
    ["a bare origin longer than the cap is unchanged, no ellipsis", `https://${"h".repeat(130)}.example`, `https://${"h".repeat(130)}.example`],
  ])("displayUrl: %s", (_name, url, expected) => {
    expect(displayUrl(url)).toBe(expected);
  });

  it("shows long initiator and redirect origins whole (never hiding the registrable domain) with the buttons kept in view", async () => {
    // Both rows are origins: displayUrl keeps an origin whole, since cutting a
    // host would hide its registrable domain (the part that tells sites apart).
    const long = `https://${"x".repeat(200)}.evil.example`;
    await renderPrompt({ ...VIEW, initiator: long, redirectedFrom: `${long}:8443` });
    expect(screen.getByText(long)).toBeInTheDocument();
    expect(screen.getByText(`${long}:8443`)).toBeInTheDocument();
    const actions = screen.getByTestId("auth-actions");
    expect(screen.getByRole("alert").compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(actions.className).toMatch(/\bsticky\b/);
    expect(actions.className).toMatch(/\bbottom-0\b/);
  });

  it("caps an initiator that carries a path like the address", async () => {
    const withPath = `https://portal.example/${"p".repeat(300)}`;
    await renderPrompt({ ...VIEW, initiator: withPath });
    const shown = screen.getByText(/^https:\/\/portal\.example\/p+…$/).textContent ?? "";
    expect(shown.length).toBe(URL_DISPLAY_MAX);
  });

  it("an unknown or settled id shows that the request is over, with no Send", async () => {
    await renderPrompt(null);
    expect(screen.getByText("This sign-in request is no longer pending.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("closes itself once the challenge's time is up", async () => {
    await renderPrompt();
    await advance(HTTP_AUTH_PROMPT_TIMEOUT_MS - 1);
    expect(window.close).not.toHaveBeenCalled();
    await advance(1);
    expect(window.close).toHaveBeenCalled();
  });

  describe("input protection", () => {
    it("keeps Send disarmed for 800 ms after the window is visible and focused", async () => {
      await renderPrompt();
      expect(isArmed()).toBe(false);
      await advance(SEND_ARM_DELAY_MS - 1);
      expect(isArmed()).toBe(false);
      await advance(1);
      expect(isArmed()).toBe(true);
    });

    it("does not arm while the window is unfocused", async () => {
      focused = false;
      await renderPrompt();
      await advance(SEND_ARM_DELAY_MS * 3);
      expect(isArmed()).toBe(false);
    });

    it("does not arm while the window is hidden", async () => {
      visibility = "hidden";
      await renderPrompt();
      await advance(SEND_ARM_DELAY_MS * 3);
      expect(isArmed()).toBe(false);
    });

    it("disarms on blur and re-arms 800 ms after the next focus", async () => {
      await renderPrompt();
      await advance(SEND_ARM_DELAY_MS);
      expect(isArmed()).toBe(true);
      focused = false;
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });
      expect(isArmed()).toBe(false);
      focused = true;
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      await advance(SEND_ARM_DELAY_MS - 1);
      expect(isArmed()).toBe(false);
      await advance(1);
      expect(isArmed()).toBe(true);
    });

    it("re-arms 800 ms after becoming visible again", async () => {
      await renderPrompt();
      await advance(SEND_ARM_DELAY_MS);
      visibility = "hidden";
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(isArmed()).toBe(false);
      visibility = "visible";
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await advance(SEND_ARM_DELAY_MS - 1);
      expect(isArmed()).toBe(false);
      await advance(1);
      expect(isArmed()).toBe(true);
    });

    it("a click train across the 800 ms boundary never sends", async () => {
      await renderPrompt();
      // A press every 500 ms keeps restarting the delay, so Send never arms.
      for (let i = 0; i < 6; i++) {
        await advance(500);
        pressSend();
      }
      expect(isArmed()).toBe(false);
      expect(decisions()).toEqual([]);
    });

    it("a key press while disarmed restarts the delay", async () => {
      await renderPrompt();
      await advance(SEND_ARM_DELAY_MS - 100);
      fireEvent.keyDown(window, { key: "a" });
      await advance(100);
      expect(isArmed()).toBe(false);
      await advance(SEND_ARM_DELAY_MS - 100);
      expect(isArmed()).toBe(true);
    });

    it("a press that began before arming does not send when it ends after", async () => {
      await renderPrompt();
      await advance(SEND_ARM_DELAY_MS - 1);
      fireEvent.pointerDown(sendButton());
      await advance(SEND_ARM_DELAY_MS);
      expect(isArmed()).toBe(true);
      fireEvent.click(sendButton(), { detail: 1 });
      expect(decisions()).toEqual([]);
    });

    it("a press interrupted by a disarm does not count after re-arming", async () => {
      await renderPrompt();
      await advance(SEND_ARM_DELAY_MS);
      fireEvent.pointerDown(sendButton());
      focused = false;
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });
      focused = true;
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      await advance(SEND_ARM_DELAY_MS);
      expect(isArmed()).toBe(true);
      fireEvent.click(sendButton(), { detail: 1 });
      expect(decisions()).toEqual([]);
    });

    it("a pointer click without a pointerdown on Send does not send", async () => {
      await renderPrompt();
      await advance(SEND_ARM_DELAY_MS);
      fireEvent.click(sendButton(), { detail: 1 });
      expect(decisions()).toEqual([]);
    });

    it("a click with no pointer behind it (detail 0: Space, assistive tech) sends while armed", async () => {
      await renderPrompt();
      await advance(SEND_ARM_DELAY_MS);
      fireEvent.click(sendButton(), { detail: 0 });
      expect(decisions()).toEqual(["send"]);
    });

    it("a detail-0 click while disarmed does not send", async () => {
      await renderPrompt();
      fireEvent.click(sendButton(), { detail: 0 });
      expect(decisions()).toEqual([]);
    });

    it("keyboard focus reaching Send restarts the delay (Tab then Space needs a pause)", async () => {
      await renderPrompt();
      await advance(SEND_ARM_DELAY_MS);
      expect(isArmed()).toBe(true);
      fireEvent.focus(sendButton());
      expect(isArmed()).toBe(false);
      fireEvent.click(sendButton(), { detail: 0 });
      expect(decisions()).toEqual([]);
      await advance(SEND_ARM_DELAY_MS);
      fireEvent.click(sendButton(), { detail: 0 });
      expect(decisions()).toEqual(["send"]);
    });

    it("control: the focus a pointer press gives Send does not disarm it", async () => {
      await renderPrompt();
      await advance(SEND_ARM_DELAY_MS);
      fireEvent.pointerDown(sendButton());
      fireEvent.focus(sendButton());
      expect(isArmed()).toBe(true);
      fireEvent.click(sendButton(), { detail: 1 });
      expect(decisions()).toEqual(["send"]);
    });

    it("while disarmed Send is aria-disabled, not disabled", async () => {
      // A disabled button gets no pointerdown in a browser, so a press on it
      // could not restart the delay. jsdom dispatches events to disabled
      // buttons anyway, so it cannot show that; the attributes are what is
      // pinned here.
      await renderPrompt();
      expect(sendButton()).not.toBeDisabled();
      expect(sendButton()).toHaveAttribute("aria-disabled", "true");
    });

    it("an armed press while the window lacks focus decides nothing", async () => {
      await renderPrompt();
      await advance(SEND_ARM_DELAY_MS);
      focused = false;
      pressSend();
      expect(decisions()).toEqual([]);
    });

    it("an armed press with focus decides send, once", async () => {
      await renderPrompt();
      await advance(SEND_ARM_DELAY_MS);
      pressSend();
      pressSend();
      expect(decisions()).toEqual(["send"]);
      expect(mockSendMessage).toHaveBeenCalledWith({ type: "HTTP_AUTH_PROMPT_DECIDE", promptId: "p-1", decision: "send" });
    });

    it("Space on an armed Send decides send (keyboard users)", async () => {
      await renderPrompt();
      await advance(SEND_ARM_DELAY_MS);
      fireEvent.keyDown(sendButton(), { key: " " });
      fireEvent.click(sendButton(), { detail: 0 });
      expect(decisions()).toEqual(["send"]);
    });

    it.each(["Enter", "Escape"])("%s means Cancel, even with Send armed", async (key) => {
      await renderPrompt();
      await advance(SEND_ARM_DELAY_MS);
      fireEvent.keyDown(sendButton(), { key });
      expect(decisions()).toEqual(["cancel"]);
    });

    it("Send is never focused by the page, nor a default (submit) button", async () => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      await renderPrompt();
      await advance(SEND_ARM_DELAY_MS);
      expect(focus.mock.contexts.filter((el) => el === sendButton())).toEqual([]);
      expect(document.activeElement).not.toBe(sendButton());
      expect(sendButton()).toHaveAttribute("type", "button");
      expect(sendButton()).not.toHaveAttribute("autofocus");
      expect(document.querySelector("form")).toBeNull();
    });

    it("decides once: a key after Cancel sends nothing more", async () => {
      await renderPrompt();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      fireEvent.keyDown(window, { key: "Escape" });
      expect(decisions()).toEqual(["cancel"]);
    });

    it("Cancel decides cancel and closes the window", async () => {
      await renderPrompt();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(decisions()).toEqual(["cancel"]);
      await advance(0);
      expect(window.close).toHaveBeenCalled();
    });
  });
});
