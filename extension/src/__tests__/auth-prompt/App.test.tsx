/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { HttpAuthPromptView } from "../../types/messages";

const mockSendMessage = vi.fn();
vi.mock("../../lib/messaging", () => ({
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
}));

import { App, SEND_ARM_DELAY_MS } from "../../auth-prompt/App";

const VIEW: HttpAuthPromptView = {
  url: "http://router.example:8080/admin",
  origin: "http://router.example:8080",
  initiator: "https://portal.example",
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

const sendButton = () => screen.getByRole("button", { name: "Send" });

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
    expect(screen.getByText("Basic")).toBeInTheDocument();
  });

  it("labels a navigation with no initiator as the address bar or a bookmark", async () => {
    await renderPrompt({ ...VIEW, initiator: null });
    expect(screen.getByText("Address bar or bookmark")).toBeInTheDocument();
  });

  it("shows the http warning for an insecure origin", async () => {
    await renderPrompt();
    expect(screen.getByRole("alert")).toHaveTextContent(/plain HTTP/);
  });

  it("control: no warning for an https origin", async () => {
    await renderPrompt({ ...VIEW, origin: "https://router.example", url: "https://router.example/", insecure: false, scheme: "digest" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Digest")).toBeInTheDocument();
  });

  it("an unknown or settled id shows that the request is over, with no Send", async () => {
    await renderPrompt(null);
    expect(screen.getByText("This sign-in request is no longer pending.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  describe("input protection", () => {
    it("keeps Send disabled for 800 ms after the window is visible and focused", async () => {
      await renderPrompt();
      expect(sendButton()).toBeDisabled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SEND_ARM_DELAY_MS - 1);
      });
      expect(sendButton()).toBeDisabled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(sendButton()).toBeEnabled();
    });

    it("does not arm while the window is unfocused", async () => {
      focused = false;
      await renderPrompt();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SEND_ARM_DELAY_MS * 3);
      });
      expect(sendButton()).toBeDisabled();
    });

    it("does not arm while the window is hidden", async () => {
      visibility = "hidden";
      await renderPrompt();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SEND_ARM_DELAY_MS * 3);
      });
      expect(sendButton()).toBeDisabled();
    });

    it("disarms on blur and re-arms 800 ms after the next focus", async () => {
      await renderPrompt();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SEND_ARM_DELAY_MS);
      });
      expect(sendButton()).toBeEnabled();
      focused = false;
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });
      expect(sendButton()).toBeDisabled();
      focused = true;
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(sendButton()).toBeDisabled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SEND_ARM_DELAY_MS - 1);
      });
      expect(sendButton()).toBeDisabled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(sendButton()).toBeEnabled();
    });

    it("a click on the disarmed Send decides nothing", async () => {
      await renderPrompt();
      fireEvent.click(sendButton());
      expect(decisions()).toEqual([]);
    });

    it("an armed Send click while the window lacks focus decides nothing", async () => {
      await renderPrompt();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SEND_ARM_DELAY_MS);
      });
      focused = false;
      fireEvent.click(sendButton());
      expect(decisions()).toEqual([]);
    });

    it("an armed Send click with focus decides send, once", async () => {
      await renderPrompt();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SEND_ARM_DELAY_MS);
      });
      fireEvent.click(sendButton());
      fireEvent.click(sendButton());
      expect(decisions()).toEqual(["send"]);
      expect(mockSendMessage).toHaveBeenCalledWith({ type: "HTTP_AUTH_PROMPT_DECIDE", promptId: "p-1", decision: "send" });
    });

    it.each(["Enter", "Escape"])("%s means Cancel, even with Send armed and focused", async (key) => {
      await renderPrompt();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SEND_ARM_DELAY_MS);
      });
      sendButton().focus();
      fireEvent.keyDown(sendButton(), { key });
      expect(decisions()).toEqual(["cancel"]);
    });

    it("Send is never focused, autofocused or a default (submit) button", async () => {
      await renderPrompt();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SEND_ARM_DELAY_MS);
      });
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
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(window.close).toHaveBeenCalled();
    });
  });
});
