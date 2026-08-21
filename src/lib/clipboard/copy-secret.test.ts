// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { CLIPBOARD_CLEAR_TIMEOUT_MS } from "@/lib/constants";
import { CopyCancelledError } from "./copy-cancelled-error";
import { installClipboard, uninstallClipboard } from "@/__tests__/helpers/mock-clipboard";
import {
  COPY_OUTCOME,
  copySecretToClipboard,
  copySecretWithoutClear,
} from "./copy-secret";

describe("copySecretToClipboard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installClipboard();
  });

  // Registered at acquisition, not after the assertions: a failing test must not
  // leave fake timers or the clipboard descriptor installed for the rest of the file.
  afterEach(() => {
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
      // The dominant path on Firefox (no page-script readText) and WebKit
      // (permission-gated), not an edge case.
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
