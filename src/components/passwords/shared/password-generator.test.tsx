// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const { mockToastError } = vi.hoisted(() => ({ mockToastError: vi.fn() }));

vi.mock("sonner", () => ({
  toast: { error: mockToastError, success: vi.fn() },
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ password: "GeneratedPwd1!" }),
  }),
}));

import { PasswordGenerator } from "./password-generator";
import { fetchApi } from "@/lib/url-helpers";
import {
  DEFAULT_GENERATOR_SETTINGS,
  type GeneratorSettings,
} from "@/lib/generator/generator-prefs";
import type { TeamPolicyClient } from "@/hooks/team/use-team-policy";

function respondWith(password: string) {
  vi.mocked(fetchApi).mockResolvedValue({
    ok: true,
    json: async () => ({ password }),
  } as Response);
}

function lastRequestBody(): Record<string, unknown> {
  const calls = vi.mocked(fetchApi).mock.calls;
  const init = calls[calls.length - 1][1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

async function renderGenerator(
  props: Partial<Parameters<typeof PasswordGenerator>[0]> = {},
) {
  const onUse = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <PasswordGenerator open={true} onClose={onClose} onUse={onUse} {...props} />,
  );
  await waitFor(() => expect(fetchApi).toHaveBeenCalled());
  return { ...view, onUse, onClose };
}

const POLICY: TeamPolicyClient = {
  minPasswordLength: 0,
  requireUppercase: false,
  requireLowercase: false,
  requireNumbers: false,
  requireSymbols: false,
  requireRepromptForAll: false,
  allowExport: true,
  allowSharing: true,
  requireSharePassword: false,
  passwordHistoryCount: 0,
  inheritTenantCidrs: true,
  teamAllowedCidrs: [],
};

describe("PasswordGenerator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    respondWith("GeneratedPwd1!");
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders nothing when open is false", () => {
    const { container } = render(
      <PasswordGenerator open={false} onClose={vi.fn()} onUse={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("calls fetchApi to generate a password when open", async () => {
    render(<PasswordGenerator open={true} onClose={vi.fn()} onUse={vi.fn()} />);

    await waitFor(() => {
      expect(fetchApi).toHaveBeenCalled();
    });

    // The mocked password should appear in DOM
    await waitFor(() => {
      expect(screen.getByText("GeneratedPwd1!")).toBeInTheDocument();
    });
  });

  it("invokes onUse with generated password and current settings when Use is clicked", async () => {
    const onUse = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <PasswordGenerator open={true} onClose={onClose} onUse={onUse} />,
    );

    await waitFor(() => {
      expect(screen.getByText("GeneratedPwd1!")).toBeInTheDocument();
    });

    const useButton = screen.getByRole("button", { name: "use" });
    await user.click(useButton);

    expect(onUse).toHaveBeenCalledWith(
      "GeneratedPwd1!",
      expect.objectContaining({ mode: expect.any(String) }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when Cancel is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<PasswordGenerator open={true} onClose={onClose} onUse={vi.fn()} />);

    const cancelButton = screen.getByRole("button", { name: "cancel" });
    await user.click(cancelButton);

    expect(onClose).toHaveBeenCalled();
  });

  it("posts the password settings to the generate endpoint", async () => {
    await renderGenerator();

    expect(fetchApi).toHaveBeenCalledWith(
      "/api/passwords/generate",
      expect.objectContaining({ method: "POST" }),
    );
    expect(lastRequestBody()).toEqual({
      mode: "password",
      length: 20,
      uppercase: true,
      lowercase: true,
      numbers: true,
      symbols: "",
      excludeAmbiguous: false,
      includeChars: "",
      excludeChars: "",
    });
  });

  it("shows no password and disables Use when generation fails", async () => {
    vi.mocked(fetchApi).mockResolvedValue({ ok: false } as Response);
    await renderGenerator();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "use" })).toBeDisabled(),
    );
    expect(screen.queryByText("strength")).not.toBeInTheDocument();
  });

  it("shows no password and disables Use when the generated body cannot be read", async () => {
    vi.mocked(fetchApi).mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
    } as unknown as Response);
    await renderGenerator();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "use" })).toBeDisabled(),
    );
    expect(screen.queryByText("strength")).not.toBeInTheDocument();
  });

  it("regenerates when the refresh button is clicked", async () => {
    const user = userEvent.setup();
    await renderGenerator();
    await screen.findByText("GeneratedPwd1!");

    respondWith("SecondPwd2@");
    await user.click(screen.getAllByRole("button")[1]);

    expect(await screen.findByText("SecondPwd2@")).toBeInTheDocument();
  });

  it.each([
    ["Ab1", "strengthWeak"],
    ["Abcdefghij", "strengthFair"],
    ["Abcdefghijklm", "strengthStrong"],
    ["Abcdefghijklmnopqr", "strengthVeryStrong"],
  ])("rates a %s password over the default charset as %s", async (pw, label) => {
    respondWith(pw);
    await renderGenerator();

    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it("switches to passphrase mode and posts the passphrase settings", async () => {
    const user = userEvent.setup();
    await renderGenerator();

    await user.click(screen.getByRole("button", { name: "modePassphrase" }));

    await waitFor(() =>
      expect(lastRequestBody()).toEqual({
        mode: "passphrase",
        wordCount: 4,
        separator: "-",
        capitalize: true,
        includeNumber: false,
      }),
    );
    expect(screen.getByLabelText("wordCount")).toHaveValue(4);
    expect(screen.queryByLabelText("length")).not.toBeInTheDocument();
  });

  it("rates a passphrase by word count, not by its length", async () => {
    const user = userEvent.setup();
    respondWith("a-very-long-passphrase-with-many-characters");
    await renderGenerator();
    await user.click(screen.getByRole("button", { name: "modePassphrase" }));

    // 4 words * 12 bits = 48 bits
    expect(await screen.findByText("strengthWeak")).toBeInTheDocument();
  });

  it("switches back to password mode", async () => {
    const user = userEvent.setup();
    await renderGenerator({
      settings: { ...DEFAULT_GENERATOR_SETTINGS, mode: "passphrase" },
    });

    await user.click(screen.getByRole("button", { name: "modePassword" }));

    await waitFor(() => expect(lastRequestBody()).toMatchObject({ mode: "password" }));
  });

  it("posts the character-type toggles", async () => {
    const user = userEvent.setup();
    await renderGenerator();

    await user.click(screen.getByRole("checkbox", { name: "uppercase" }));
    await user.click(screen.getByRole("checkbox", { name: "numbers" }));
    await user.click(screen.getByRole("checkbox", { name: "excludeAmbiguous" }));

    await waitFor(() =>
      expect(lastRequestBody()).toMatchObject({
        uppercase: false,
        lowercase: true,
        numbers: false,
        excludeAmbiguous: true,
      }),
    );
  });

  it("posts the selected symbol groups as one symbol string", async () => {
    const user = userEvent.setup();
    await renderGenerator();

    await user.click(screen.getByRole("checkbox", { name: "#$%&@^`~" }));
    await user.click(screen.getByRole("checkbox", { name: "{}[]()" }));

    await waitFor(() =>
      expect(lastRequestBody()).toMatchObject({ symbols: "#$%&@^`~{}[]()" }),
    );

    await user.click(screen.getByRole("checkbox", { name: "#$%&@^`~" }));
    await waitFor(() => expect(lastRequestBody()).toMatchObject({ symbols: "{}[]()" }));
  });

  it("warns and disables refresh when no character type is enabled", async () => {
    const user = userEvent.setup();
    await renderGenerator();

    await user.click(screen.getByRole("checkbox", { name: "uppercase" }));
    await user.click(screen.getByRole("checkbox", { name: "lowercase" }));
    expect(screen.queryByText("noAvailableChars")).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "numbers" }));

    expect(screen.getByText("noAvailableChars")).toBeInTheDocument();
    expect(screen.getAllByRole("button")[1]).toBeDisabled();
  });

  it("applies a quick length preset", async () => {
    const user = userEvent.setup();
    await renderGenerator();

    await user.click(screen.getByRole("button", { name: "32" }));

    await waitFor(() => expect(lastRequestBody()).toMatchObject({ length: 32 }));
    expect(screen.getByLabelText("length")).toHaveValue(32);
  });

  it("ignores a non-numeric length entry", async () => {
    await renderGenerator();
    const input = screen.getByLabelText("length");

    fireEvent.change(input, { target: { value: "" } });

    expect(input).toHaveValue(20);
  });

  it("clamps an out-of-range length on blur", async () => {
    await renderGenerator();
    const input = screen.getByLabelText("length");

    fireEvent.change(input, { target: { value: "500" } });
    expect(input).toHaveValue(500);
    fireEvent.blur(input);

    expect(input).toHaveValue(128);
    await waitFor(() => expect(lastRequestBody()).toMatchObject({ length: 128 }));
  });

  it("raises the length from the slider keyboard control", async () => {
    const user = userEvent.setup();
    await renderGenerator();

    screen.getByRole("slider").focus();
    await user.keyboard("{ArrowRight}");

    expect(screen.getByLabelText("length")).toHaveValue(21);
  });

  it("posts the include and exclude characters", async () => {
    const user = userEvent.setup();
    await renderGenerator();

    await user.type(screen.getByLabelText("includeChars"), "xy");
    await user.type(screen.getByLabelText("excludeChars"), "z");

    await waitFor(() =>
      expect(lastRequestBody()).toMatchObject({ includeChars: "xy", excludeChars: "z" }),
    );
  });

  it("posts the passphrase separator and toggles", async () => {
    const user = userEvent.setup();
    await renderGenerator({
      settings: { ...DEFAULT_GENERATOR_SETTINGS, mode: "passphrase" },
    });

    await user.click(screen.getByRole("button", { name: "_" }));
    await user.click(screen.getByRole("checkbox", { name: "capitalize" }));
    await user.click(screen.getByRole("checkbox", { name: "includeNumber" }));

    await waitFor(() =>
      expect(lastRequestBody()).toMatchObject({
        separator: "_",
        capitalize: false,
        includeNumber: true,
      }),
    );
  });

  it("posts a space separator from the visible-space button", async () => {
    const user = userEvent.setup();
    await renderGenerator({
      settings: { ...DEFAULT_GENERATOR_SETTINGS, mode: "passphrase" },
    });

    await user.click(screen.getByRole("button", { name: "\u2423" }));

    await waitFor(() => expect(lastRequestBody()).toMatchObject({ separator: " " }));
  });

  it("clamps an out-of-range word count on blur and ignores non-numeric entry", async () => {
    await renderGenerator({
      settings: { ...DEFAULT_GENERATOR_SETTINGS, mode: "passphrase" },
    });
    const input = screen.getByLabelText("wordCount");

    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveValue(4);
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.blur(input);

    expect(input).toHaveValue(3);
    await waitFor(() => expect(lastRequestBody()).toMatchObject({ wordCount: 3 }));
  });

  it("raises the word count from the slider keyboard control", async () => {
    const user = userEvent.setup();
    await renderGenerator({
      settings: { ...DEFAULT_GENERATOR_SETTINGS, mode: "passphrase" },
    });

    screen.getByRole("slider").focus();
    await user.keyboard("{ArrowRight}");

    expect(screen.getByLabelText("wordCount")).toHaveValue(5);
  });

  it("adopts new settings passed in after mount", async () => {
    const { rerender, onUse, onClose } = await renderGenerator();
    const next: GeneratorSettings = { ...DEFAULT_GENERATOR_SETTINGS, length: 40 };

    rerender(
      <PasswordGenerator open={true} onClose={onClose} onUse={onUse} settings={next} />,
    );

    await waitFor(() => expect(lastRequestBody()).toMatchObject({ length: 40 }));
    expect(screen.getByLabelText("length")).toHaveValue(40);
  });

  it("shows a team policy warning listing each violation", async () => {
    await renderGenerator({
      teamPolicy: { ...POLICY, minPasswordLength: 30, requireSymbols: true },
    });

    expect(
      screen.getByText("policyWarning: policyMinLength, policySymbols"),
    ).toBeInTheDocument();
  });

  it("shows no team policy warning when the settings satisfy the policy", async () => {
    await renderGenerator({
      teamPolicy: { ...POLICY, minPasswordLength: 16, requireUppercase: true },
    });

    expect(screen.queryByText(/policyWarning/)).not.toBeInTheDocument();
  });

  it("copies the generated password to the clipboard", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    await renderGenerator();
    const pw = await screen.findByText("GeneratedPwd1!");
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText, readText: vi.fn() },
      configurable: true,
    });

    await user.click(pw.nextElementSibling as HTMLElement);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("GeneratedPwd1!"));
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("reports a rejected clipboard write instead of failing silently", async () => {
    const user = userEvent.setup();
    await renderGenerator();
    const pw = await screen.findByText("GeneratedPwd1!");
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });

    await user.click(pw.nextElementSibling as HTMLElement);

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("copyWriteFailed"));
  });

  it("keeps used passwords in a history that can be expanded and copied", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    await renderGenerator();
    await screen.findByText("GeneratedPwd1!");

    await user.click(screen.getByRole("button", { name: "use" }));
    const historyToggle = screen.getByRole("button", { name: /history \(1\)/ });
    expect(screen.getAllByText("GeneratedPwd1!")).toHaveLength(1);

    await user.click(historyToggle);
    const entries = screen.getAllByText("GeneratedPwd1!");
    expect(entries).toHaveLength(2);

    Object.defineProperty(navigator, "clipboard", {
      value: { writeText, readText: vi.fn() },
      configurable: true,
    });
    await user.click(entries[1].nextElementSibling as HTMLElement);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("GeneratedPwd1!"));

    await user.click(historyToggle);
    expect(screen.getAllByText("GeneratedPwd1!")).toHaveLength(1);
  });
});
