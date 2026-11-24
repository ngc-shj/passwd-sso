// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";

import { CLIPBOARD_CLEAR_TIMEOUT_MS } from "@/lib/constants";
import { CopyCancelledError } from "./copy-cancelled-error";
import { installClipboard, uninstallClipboard } from "@/__tests__/helpers/mock-clipboard";
import {
  COPY_OUTCOME,
  REFOCUS_RETRY_WINDOW_MS,
  copySecretToClipboard,
  copySecretWithoutClear,
} from "./copy-secret";

describe("copySecretToClipboard", () => {
  let addSpy: MockInstance<Window["addEventListener"]>;

  beforeEach(() => {
    vi.useFakeTimers();
    installClipboard();
    addSpy = vi.spyOn(window, "addEventListener");
  });

  // Registered at acquisition, not after the assertions: a failing test must not
  // leave fake timers, the clipboard descriptor or a refocus listener installed
  // for the rest of the file.
  afterEach(() => {
    for (const [type, listener] of addSpy.mock.calls) {
      if (type === "focus") window.removeEventListener("focus", listener);
    }
    addSpy.mockRestore();
    vi.useRealTimers();
    uninstallClipboard();
  });

  describe("outcomes", () => {
    it("returns UNAVAILABLE without invoking the getter when there is no clipboard", async () => {
      uninstallClipboard();
      const getValue = vi.fn();

      expect(await copySecretToClipboard(getValue)).toBe(COPY_OUTCOME.UNAVAILABLE);
      // The mutation, not just the outcome: a page that cannot write must not
      // decrypt the secret in the first place.
      expect(getValue).not.toHaveBeenCalled();
    });

    it("returns EMPTY without writing when the value is an empty string", async () => {
      const clip = installClipboard();
      expect(await copySecretToClipboard(() => "")).toBe(COPY_OUTCOME.EMPTY);
      expect(clip.writeText).not.toHaveBeenCalled();
    });

    it("returns EMPTY without writing when the value is only whitespace", async () => {
      const clip = installClipboard();
      expect(await copySecretToClipboard(() => "   ")).toBe(COPY_OUTCOME.EMPTY);
      expect(clip.writeText).not.toHaveBeenCalled();
    });

    it("writes the value untrimmed when it merely contains whitespace", async () => {
      const clip = installClipboard();
      expect(await copySecretToClipboard(() => "  p  ")).toBe(COPY_OUTCOME.OK);
      // Byte fidelity: trimming decides emptiness, never what lands on the clipboard.
      expect(clip.writeText).toHaveBeenCalledWith("  p  ");
    });

    it("returns CANCELLED and schedules no clear when the getter reports a decline", async () => {
      const clip = installClipboard();
      const outcome = await copySecretToClipboard(() => {
        throw new CopyCancelledError();
      });

      expect(outcome).toBe(COPY_OUTCOME.CANCELLED);
      expect(clip.writeText).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("returns SOURCE_FAILED for an impostor that only claims the cancellation name", async () => {
      // CANCELLED is the one outcome a caller may report silently, so it must not
      // be reachable by anything but the real sentinel.
      const impostor = Object.assign(new Error("x"), { name: "CopyCancelledError" });
      const outcome = await copySecretToClipboard(() => {
        throw impostor;
      });
      expect(outcome).toBe(COPY_OUTCOME.SOURCE_FAILED);
    });

    it("returns SOURCE_FAILED without writing when the getter rejects", async () => {
      const clip = installClipboard();
      const outcome = await copySecretToClipboard(() =>
        Promise.reject(new Error("decrypt failed")),
      );

      expect(outcome).toBe(COPY_OUTCOME.SOURCE_FAILED);
      expect(clip.writeText).not.toHaveBeenCalled();
    });

    it("returns SOURCE_FAILED when the getter resolves a non-string", async () => {
      const clip = installClipboard();
      const outcome = await copySecretToClipboard(
        () => undefined as unknown as string,
      );

      expect(outcome).toBe(COPY_OUTCOME.SOURCE_FAILED);
      // Guards against a mis-typed adapter reaching writeText and stringifying.
      expect(clip.writeText).not.toHaveBeenCalled();
    });

    it("returns WRITE_FAILED and schedules no clear when the write is rejected", async () => {
      const clip = installClipboard({
        writeText: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")),
      });

      expect(await copySecretToClipboard(() => "secret")).toBe(COPY_OUTCOME.WRITE_FAILED);
      // The write was genuinely attempted — otherwise this would be
      // indistinguishable from bailing out before ever reaching the clipboard.
      expect(clip.writeText).toHaveBeenCalledWith("secret");
      // Nothing reached the clipboard, so there is nothing to clear.
      expect(vi.getTimerCount()).toBe(0);
    });

    it("returns OK and schedules exactly one clear on success", async () => {
      const clip = installClipboard();

      expect(await copySecretToClipboard(() => "secret")).toBe(COPY_OUTCOME.OK);
      expect(clip.writeText).toHaveBeenCalledWith("secret");
      expect(vi.getTimerCount()).toBe(1);
    });
  });

  describe("the 30s clear", () => {
    async function copyThenAdvance(clip: ReturnType<typeof installClipboard>) {
      await copySecretToClipboard(() => "secret");
      clip.writeText.mockClear();
      await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_TIMEOUT_MS);
    }

    it("blanks the clipboard when it still holds the copied value", async () => {
      const clip = installClipboard({ readText: vi.fn().mockResolvedValue("secret") });
      await copyThenAdvance(clip);

      expect(clip.readText).toHaveBeenCalledTimes(1);
      expect(clip.writeText).toHaveBeenCalledTimes(1);
      expect(clip.writeText).toHaveBeenCalledWith("");
    });

    it("leaves the clipboard alone when it now holds something else", async () => {
      const clip = installClipboard({ readText: vi.fn().mockResolvedValue("something newer") });
      await copyThenAdvance(clip);

      // readText asserted first: "the timer never fired" and "the value had
      // changed" otherwise present identically as writeText not being called.
      expect(clip.readText).toHaveBeenCalledTimes(1);
      expect(clip.writeText).not.toHaveBeenCalled();
    });

    it("blanks unconditionally when read-back is unavailable", async () => {
      // Chromium without the clipboard-read permission. On Firefox and WebKit
      // the blanking write is refused as well (no transient activation).
      const clip = installClipboard({
        readText: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")),
      });
      await copyThenAdvance(clip);

      expect(clip.writeText).toHaveBeenCalledTimes(1);
      expect(clip.writeText).toHaveBeenCalledWith("");
    });

    it("does not let a rejected fallback write escape", async () => {
      const clip = installClipboard({
        writeText: vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValue(new DOMException("denied", "NotAllowedError")),
        readText: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")),
      });

      await expect(copyThenAdvance(clip)).resolves.toBeUndefined();
      expect(clip.writeText).toHaveBeenCalledTimes(1);
      // The failure is handed to the refocus retry rather than dropped. Awaited
      // here so the listener is registered before afterEach removes it.
      await vi.waitFor(() =>
        expect(addSpy).toHaveBeenCalledWith("focus", expect.any(Function)),
      );
    });
  });

  describe("copySecretWithoutClear", () => {
    it("returns OK and schedules no clear", async () => {
      const clip = installClipboard();

      expect(await copySecretWithoutClear(() => "recovery-key")).toBe(COPY_OUTCOME.OK);
      expect(clip.writeText).toHaveBeenCalledWith("recovery-key");
      // The deny side of the pair below: the recovery key must survive on the
      // clipboard because the user is told to store it permanently.
      expect(vi.getTimerCount()).toBe(0);
    });

    it("still classifies failures the same way as the clearing variant", async () => {
      installClipboard();
      expect(await copySecretWithoutClear(() => "")).toBe(COPY_OUTCOME.EMPTY);
    });
  });
});

describe("copySecretToClipboard — the refocus retry after a failed clear", () => {
  const SECRET = "https://app.example.com/s/tok#key=abc";
  const denied = () => new DOMException("denied", "NotAllowedError");

  let addSpy: MockInstance<Window["addEventListener"]>;
  let hasFocusSpy: MockInstance<Document["hasFocus"]>;

  /** A clipboard that holds its content, and can be made to refuse like a backgrounded tab. */
  function statefulClipboard() {
    const state = { content: "", readable: true, writable: true };
    const clip = installClipboard({
      writeText: vi.fn(async (value: string) => {
        if (!state.writable) throw denied();
        state.content = value;
      }),
      readText: vi.fn(async () => {
        if (!state.readable) throw denied();
        return state.content;
      }),
    });
    return { state, clip };
  }

  function focusListenerCount(): number {
    return addSpy.mock.calls.filter(([type]) => type === "focus").length;
  }

  /** Copy, then let the timed clear fail because the tab is refused everything. */
  async function copyAndFailTheTimedClear() {
    const stateful = statefulClipboard();
    await copySecretToClipboard(() => SECRET);
    stateful.state.readable = false;
    stateful.state.writable = false;
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_TIMEOUT_MS);
    await vi.waitFor(() => expect(focusListenerCount()).toBe(1));
    // The user is back: the clipboard answers again.
    stateful.state.readable = true;
    stateful.state.writable = true;
    stateful.clip.readText.mockClear();
    stateful.clip.writeText.mockClear();
    return stateful;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    addSpy = vi.spyOn(window, "addEventListener");
    // jsdom reports no focus by default.
    hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    for (const [type, listener] of addSpy.mock.calls) {
      if (type === "focus") window.removeEventListener("focus", listener);
    }
    vi.runOnlyPendingTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
    uninstallClipboard();
  });

  it("blanks the clipboard on the next focused return", async () => {
    const { state, clip } = await copyAndFailTheTimedClear();

    window.dispatchEvent(new Event("focus"));

    await vi.waitFor(() => expect(state.content).toBe(""));
    expect(clip.readText).toHaveBeenCalledTimes(1);
  });

  it("waits for a focus the document reports before attempting", async () => {
    const { state, clip } = await copyAndFailTheTimedClear();

    hasFocusSpy.mockReturnValue(false);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(clip.readText).not.toHaveBeenCalled();
    expect(state.content).toBe(SECRET);

    hasFocusSpy.mockReturnValue(true);
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(state.content).toBe(""));
  });

  it("leaves a clipboard that now holds something else alone", async () => {
    const { state, clip } = await copyAndFailTheTimedClear();
    state.content = "copied later by the user";

    window.dispatchEvent(new Event("focus"));

    await vi.waitFor(() => expect(clip.readText).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(clip.writeText).not.toHaveBeenCalled();
    expect(state.content).toBe("copied later by the user");
  });

  it("blanks without comparing when the read-back is refused on retry", async () => {
    const { state, clip } = await copyAndFailTheTimedClear();
    state.readable = false;

    window.dispatchEvent(new Event("focus"));

    await vi.waitFor(() => expect(clip.writeText).toHaveBeenCalledWith(""));
    expect(state.content).toBe("");
  });

  it("makes exactly one attempt across later focus events", async () => {
    const { clip } = await copyAndFailTheTimedClear();
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(clip.writeText).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);

    expect(clip.readText).toHaveBeenCalledTimes(1);
    expect(clip.writeText).toHaveBeenCalledTimes(1);
  });

  it("registers nothing and digests nothing when the timed clear succeeds", async () => {
    const digestSpy = vi.spyOn(crypto.subtle, "digest");
    const { state } = statefulClipboard();
    await copySecretToClipboard(() => SECRET);

    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_TIMEOUT_MS);

    // Positive control: the timed clear really ran and blanked the clipboard.
    expect(state.content).toBe("");
    expect(digestSpy).not.toHaveBeenCalled();
    expect(focusListenerCount()).toBe(0);
  });

  it("does not re-register when the retry itself fails", async () => {
    const { state, clip } = await copyAndFailTheTimedClear();
    state.readable = false;
    state.writable = false;

    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(clip.writeText).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(focusListenerCount()).toBe(1);

    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(clip.writeText).toHaveBeenCalledTimes(1);
    expect(clip.readText).toHaveBeenCalledTimes(1);
  });

  describe("the retry window", () => {
    it("still blanks on a focused return inside the window", async () => {
      const { state } = await copyAndFailTheTimedClear();

      // Not `- 1`: under fake timers vi.waitFor advances the clock on each poll,
      // so the helper's wait has already spent part of the window.
      await vi.advanceTimersByTimeAsync(REFOCUS_RETRY_WINDOW_MS - CLIPBOARD_CLEAR_TIMEOUT_MS);
      window.dispatchEvent(new Event("focus"));

      await vi.waitFor(() => expect(state.content).toBe(""));
    });

    it("makes no attempt on a focused return after the window has passed", async () => {
      const { state, clip } = await copyAndFailTheTimedClear();

      await vi.advanceTimersByTimeAsync(REFOCUS_RETRY_WINDOW_MS);
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);

      expect(clip.readText).not.toHaveBeenCalled();
      expect(clip.writeText).not.toHaveBeenCalled();
      expect(state.content).toBe(SECRET);
    });

    it("removes the focus listener it registered when the window closes", async () => {
      const removeSpy = vi.spyOn(window, "removeEventListener");
      await copyAndFailTheTimedClear();
      const registered = addSpy.mock.calls.find(([type]) => type === "focus")?.[1];

      await vi.advanceTimersByTimeAsync(REFOCUS_RETRY_WINDOW_MS);

      expect(registered).toEqual(expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith("focus", registered);
    });

    it("leaves no expiry timer behind once the retry has run", async () => {
      const { state } = await copyAndFailTheTimedClear();
      window.dispatchEvent(new Event("focus"));
      await vi.waitFor(() => expect(state.content).toBe(""));

      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
