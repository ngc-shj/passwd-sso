/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mockSendMessage = vi.fn();
const mockGetSettings = vi.fn();
const mockEnsureHostPermission = vi.fn();

vi.mock("../../lib/messaging", () => ({
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
}));
vi.mock("../../lib/storage", () => ({
  getSettings: () => mockGetSettings(),
}));
vi.mock("../../lib/api", () => ({
  ensureHostPermission: (...args: unknown[]) => mockEnsureHostPermission(...args),
}));

import { VaultUnlock } from "../../popup/components/VaultUnlock";

describe("VaultUnlock", () => {
  beforeEach(() => {
    // The assertions below are English literals, and t() resolves through
    // navigator.language. jsdom happens to default to en-US, but ten sibling
    // test files pin it rather than inherit it — do the same.
    Object.defineProperty(navigator, "language", { value: "en-US", configurable: true });
    vi.clearAllMocks();
    mockGetSettings.mockResolvedValue({ serverUrl: "https://example.com" });
    mockEnsureHostPermission.mockResolvedValue(true);
  });

  it("does not submit when passphrase is empty", async () => {
    render(<VaultUnlock onUnlocked={vi.fn()} />);
    const button = screen.getByRole("button", { name: /unlock/i });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    await waitFor(() => {
      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  it("shows error when permission denied", async () => {
    mockEnsureHostPermission.mockResolvedValue(false);
    render(<VaultUnlock onUnlocked={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("Passphrase"), {
      target: { value: "pw" },
    });
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));

    expect(await screen.findByText(/host permission was denied/i)).toBeInTheDocument();
  });

  it("calls onUnlocked on success", async () => {
    mockSendMessage.mockResolvedValue({ type: "UNLOCK_VAULT", ok: true });
    const onUnlocked = vi.fn();
    render(<VaultUnlock onUnlocked={onUnlocked} />);

    fireEvent.change(screen.getByPlaceholderText("Passphrase"), {
      target: { value: "pw" },
    });
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));

    await waitFor(() => {
      expect(onUnlocked).toHaveBeenCalled();
    });
  });

  it("shows error on invalid passphrase", async () => {
    mockSendMessage.mockResolvedValue({
      type: "UNLOCK_VAULT",
      ok: false,
      error: "INVALID_PASSPHRASE",
    });
    render(<VaultUnlock onUnlocked={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("Passphrase"), {
      target: { value: "pw" },
    });
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));

    expect(await screen.findByText(/passphrase is incorrect/i)).toBeInTheDocument();
  });

  it("autofocuses passphrase input", async () => {
    render(<VaultUnlock onUnlocked={vi.fn()} />);
    const input = screen.getByPlaceholderText("Passphrase");
    expect(input).toHaveFocus();
  });

  it("toggles show/hide passphrase", async () => {
    render(<VaultUnlock onUnlocked={vi.fn()} />);
    const input = screen.getByPlaceholderText("Passphrase");
    const toggle = screen.getByRole("button", { name: /show/i });
    expect(input).toHaveAttribute("type", "password");
    fireEvent.click(toggle);
    expect(input).toHaveAttribute("type", "text");
  });

  describe("passphrase visibility toggle", () => {
    // Returns the toggle's icon markup, failing loudly when there is none.
    // Without the null guard, comparing two absent icons comes out as
    // undefined === undefined — a pass or a fail that means nothing either way.
    const iconFor = (name: RegExp): string => {
      const svg = screen.getByRole("button", { name }).querySelector("svg");
      expect(svg).not.toBeNull();
      return svg!.outerHTML;
    };

    // T1 + T2. The name must be wired to state, not to a constant.
    it("flips the accessible name show → hide → show", () => {
      render(<VaultUnlock onUnlocked={vi.fn()} />);

      fireEvent.click(screen.getByRole("button", { name: /show/i }));
      expect(screen.queryByRole("button", { name: /show/i })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: /hide/i }));
      expect(screen.getByRole("button", { name: /show/i })).toBeInTheDocument();
    });

    // A revealed passphrase must not stay legible after a failed attempt. The
    // value is kept so the user can correct it; only the visibility resets.
    it.each([
      ["the unlock is rejected", () => mockSendMessage.mockResolvedValue({ ok: false, error: "INVALID_PASSPHRASE" })],
      ["host permission is denied", () => mockEnsureHostPermission.mockResolvedValue(false)],
    ])("re-masks the passphrase when %s", async (_label, arrangeFailure) => {
      arrangeFailure();
      render(<VaultUnlock onUnlocked={vi.fn()} />);
      const input = screen.getByPlaceholderText("Passphrase");

      fireEvent.change(input, { target: { value: "wrong-passphrase" } });
      fireEvent.click(screen.getByRole("button", { name: /show/i }));
      expect(input).toHaveAttribute("type", "text");

      fireEvent.click(screen.getByRole("button", { name: /unlock/i }));

      await waitFor(() => expect(input).toHaveAttribute("type", "password"));
      // The value survives so the user can fix a typo rather than retype it.
      expect(input).toHaveValue("wrong-passphrase");
    });

    // type="text" (the revealed state) is where a browser would otherwise
    // spellcheck and autocorrect a secret.
    it("opts the passphrase field out of spellcheck and autocorrect", () => {
      render(<VaultUnlock onUnlocked={vi.fn()} />);
      const input = screen.getByPlaceholderText("Passphrase");

      expect(input).toHaveAttribute("spellcheck", "false");
      expect(input).toHaveAttribute("autocorrect", "off");
      expect(input).toHaveAttribute("autocapitalize", "off");
      expect(input).toHaveAttribute("autocomplete", "current-password");
    });

    // T4. outerHTML, not innerHTML: strokeWidth and viewBox live on the element
    // itself, so innerHTML would miss an icon that changed only its attributes.
    it("renders a different icon in each state", () => {
      render(<VaultUnlock onUnlocked={vi.fn()} />);

      const hidden = iconFor(/show/i);
      fireEvent.click(screen.getByRole("button", { name: /show/i }));
      const visible = iconFor(/hide/i);

      expect(visible).not.toBe(hidden);
    });

    // T5. The masking mechanism, restated away from the test whose query the
    // icon change threatens.
    it("round-trips the input type password → text → password", () => {
      render(<VaultUnlock onUnlocked={vi.fn()} />);
      const input = screen.getByPlaceholderText("Passphrase");

      expect(input).toHaveAttribute("type", "password");
      fireEvent.click(screen.getByRole("button", { name: /show/i }));
      expect(input).toHaveAttribute("type", "text");
      fireEvent.click(screen.getByRole("button", { name: /hide/i }));
      expect(input).toHaveAttribute("type", "password");
    });

    // T6. The only test that can tell aria-label from title: a name-based query
    // resolves through either, so dropping aria-label leaves every other test green.
    it("sets aria-label itself, not only the title fallback", () => {
      render(<VaultUnlock onUnlocked={vi.fn()} />);

      const toggle = screen.getByRole("button", { name: /show/i });
      expect(toggle).toHaveAttribute("aria-label", "Show");

      fireEvent.click(toggle);
      expect(screen.getByRole("button", { name: /hide/i })).toHaveAttribute("aria-label", "Hide");
    });

    // T7. Pins which glyph goes with which state. T4 only proves they differ —
    // a swapped pairing renders two different icons too, and passes it.
    //
    // The pupil circle is asserted as well as the slash: without it, any glyph
    // without a <line> satisfies the hidden state, and a meaningless square
    // passes. jsdom cannot judge whether a path looks like an eye, so this pins
    // the two elements that carry the meaning and leaves the rest to M2.
    it("shows a plain eye while hidden and a slashed eye while visible", () => {
      render(<VaultUnlock onUnlocked={vi.fn()} />);

      const hidden = iconFor(/show/i);
      expect(hidden).toContain("<circle");
      expect(hidden).not.toContain("<line");

      fireEvent.click(screen.getByRole("button", { name: /show/i }));

      const visible = iconFor(/hide/i);
      expect(visible).toContain("<line");
    });
  });

  it("enables unlock button when passphrase is entered", async () => {
    render(<VaultUnlock onUnlocked={vi.fn()} />);
    const button = screen.getByRole("button", { name: /unlock/i });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("Passphrase"), {
      target: { value: "pw" },
    });
    expect(button).not.toBeDisabled();
  });
});
