// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";
import { CopyButton } from "./copy-button";
import { CopyCancelledError } from "@/lib/clipboard/copy-cancelled-error";
import { CLIPBOARD_CLEAR_TIMEOUT_MS } from "@/lib/constants";
import { installClipboard, uninstallClipboard } from "@/__tests__/helpers/mock-clipboard";

const toastSuccess = toast.success as ReturnType<typeof vi.fn>;
const toastError = toast.error as ReturnType<typeof vi.fn>;

describe("CopyButton", () => {
  beforeEach(() => {
    // Fails as "mock incomplete" rather than as `toast.error is not a function`
    // inside a handler if the sonner mock ever loses a member.
    expect(vi.isMockFunction(toast.error)).toBe(true);
    toastSuccess.mockClear();
    toastError.mockClear();
    installClipboard();
  });

  // The descriptor and any fake timers are released here rather than at the end of
  // each test body, so a failing assertion cannot leave them installed for the rest
  // of the file (src/__tests__/setup.ts restores neither).
  afterEach(() => {
    vi.useRealTimers();
    uninstallClipboard();
  });

  it("has no clipboard installed at the start of a fresh test", () => {
    // Paired positive for the teardown above: proves the descriptor is genuinely
    // removed between tests, so the UNAVAILABLE path can be exercised at all.
    Reflect.deleteProperty(navigator, "clipboard");
    expect(navigator.clipboard).toBeUndefined();
  });

  it("renders a button with copy tooltip text", () => {
    render(<CopyButton getValue={() => "secret"} />);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("calls navigator.clipboard.writeText with resolved value when clicked", async () => {
    const writeTextSpy = navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
    const getValue = vi.fn().mockResolvedValue("my-value");

    render(<CopyButton getValue={getValue} />);

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(getValue).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(writeTextSpy).toHaveBeenCalledWith("my-value");
    });
  });

  it("renders provided label alongside the icon", () => {
    render(<CopyButton getValue={() => "x"} label="Copy URL" />);
    expect(screen.getByText("Copy URL")).toBeInTheDocument();
  });

  it("uses ariaLabel as the accessible name so users know WHAT is copied", () => {
    render(<CopyButton getValue={() => "x"} ariaLabel="Copy password" />);
    // Accessible name reflects what gets copied (not the generic "copy" key).
    expect(screen.getByRole("button", { name: "Copy password" })).toBeInTheDocument();
  });

  // ── Every outcome is reported (the defect this change exists to remove) ──────
  //
  // Before this change, handleCopy wrapped the value fetch and the clipboard
  // write in one `try` with an empty `catch`, so all of these produced the same
  // observable as a dead button.
  describe("outcome feedback", () => {
    async function clickAndSettle(getValue: () => Promise<string> | string) {
      render(<CopyButton getValue={getValue} ariaLabel="Copy password" />);
      const button = screen.getByRole("button", { name: "Copy password" });
      fireEvent.click(button);
      await waitFor(() => expect(toastSuccess.mock.calls.length + toastError.mock.calls.length).toBeGreaterThan(0));
      return button;
    }

    it("shows the check and a success toast when the copy lands", async () => {
      const button = await clickAndSettle(() => "secret");
      await waitFor(() => expect(button).toHaveAttribute("aria-label", "copied"));
      expect(toastSuccess).toHaveBeenCalledTimes(1);
      expect(toastError).not.toHaveBeenCalled();
    });

    it("does NOT show the check for an empty value, and says nothing was copied", async () => {
      // Reds on the pre-change code, which called writeText("") successfully and
      // entered the copied state — telling the user a secret had been copied
      // when the clipboard had just been wiped instead.
      const clip = installClipboard();
      const button = await clickAndSettle(() => "");

      expect(button).toHaveAttribute("aria-label", "Copy password");
      expect(clip.writeText).not.toHaveBeenCalled();
      expect(toastError).toHaveBeenCalledWith("copyEmpty");
      expect(toastSuccess).not.toHaveBeenCalled();
    });

    it("reports a failure to obtain the value", async () => {
      // Reds on the pre-change code, where this was the silent `catch {}`.
      const button = await clickAndSettle(() => Promise.reject(new Error("decrypt failed")));

      expect(button).toHaveAttribute("aria-label", "Copy password");
      expect(toastError).toHaveBeenCalledWith("copySourceFailed");
    });

    it("reports a rejected clipboard write", async () => {
      installClipboard({
        writeText: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")),
      });
      await clickAndSettle(() => "secret");
      expect(toastError).toHaveBeenCalledWith("copyWriteFailed");
    });

    it("reports an unavailable clipboard without fetching the secret", async () => {
      Reflect.deleteProperty(navigator, "clipboard");
      const getValue = vi.fn();
      await clickAndSettle(getValue);

      expect(toastError).toHaveBeenCalledWith("copyUnavailable");
      expect(getValue).not.toHaveBeenCalled();
    });

    it("stays silent when the user declines a re-prompt", async () => {
      // Green before AND after this change — the old empty `catch` produced the
      // same observable. It is kept because it reds against the plausible wrong
      // implementation that classifies a deliberate decline as a failure and
      // tells the user to try again, which trains people to click through a
      // security prompt. It cannot detect a regression in the other outcomes.
      render(
        <CopyButton
          getValue={() => {
            throw new CopyCancelledError();
          }}
          ariaLabel="Copy password"
        />,
      );
      const button = screen.getByRole("button", { name: "Copy password" });
      fireEvent.click(button);

      await waitFor(() => expect(button).toHaveAttribute("aria-label", "Copy password"));
      expect(toastError).not.toHaveBeenCalled();
      expect(toastSuccess).not.toHaveBeenCalled();
    });
  });

  // The clear routine's own four branches are pinned in copy-secret.test.ts,
  // where they live now. What only this layer can assert is which variant
  // CopyButton reaches for: copySecretWithoutClear would leave the secret on the
  // clipboard indefinitely while the button still promises otherwise.
  it("routes to the clearing variant, not the no-clear one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const clip = installClipboard({ readText: vi.fn().mockResolvedValue("secret") });

    render(<CopyButton getValue={() => "secret"} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(clip.writeText).toHaveBeenCalledWith("secret"));
    clip.writeText.mockClear();

    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_TIMEOUT_MS);
    expect(clip.writeText).toHaveBeenCalledWith("");
  });
});
