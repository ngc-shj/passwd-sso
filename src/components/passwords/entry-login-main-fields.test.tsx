// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EntryLoginMainFields } from "@/components/passwords/entry-login-main-fields";
import { DEFAULT_GENERATOR_SETTINGS } from "@/lib/generator-prefs";

vi.mock("@/components/passwords/password-generator", () => ({
  PasswordGenerator: ({ onUse }: { onUse: (password: string, settings: typeof DEFAULT_GENERATOR_SETTINGS) => void }) => (
    <button
      type="button"
      data-testid="generator-use"
      onClick={() => onUse("generated-password", DEFAULT_GENERATOR_SETTINGS)}
    >
      use
    </button>
  ),
}));

describe("EntryLoginMainFields", () => {
  const baseProps = {
    title: "",
    onTitleChange: vi.fn(),
    titleLabel: "Title",
    titlePlaceholder: "Enter title",
    username: "",
    onUsernameChange: vi.fn(),
    usernameLabel: "Username",
    usernamePlaceholder: "Enter username",
    password: "",
    onPasswordChange: vi.fn(),
    passwordLabel: "Password",
    passwordPlaceholder: "Enter password",
    showPassword: false,
    onToggleShowPassword: vi.fn(),
    generatorSummary: "password summary",
    showGenerator: false,
    onToggleGenerator: vi.fn(),
    closeGeneratorLabel: "Close",
    openGeneratorLabel: "Generate",
    generatorSettings: DEFAULT_GENERATOR_SETTINGS,
    onGeneratorUse: vi.fn(),
    url: "",
    onUrlChange: vi.fn(),
    urlLabel: "URL",
    notes: "",
    onNotesChange: vi.fn(),
    notesLabel: "Notes",
    notesPlaceholder: "Enter notes",
  };

  it("renders title by default and hides it when hideTitle=true", () => {
    const { rerender } = render(<EntryLoginMainFields {...baseProps} />);

    expect(screen.getByLabelText("Title")).toBeTruthy();

    rerender(<EntryLoginMainFields {...baseProps} hideTitle />);

    expect(screen.queryByLabelText("Title")).toBeNull();
  });

  it("applies required flags and triggers password visibility toggle", () => {
    const onToggleShowPassword = vi.fn();

    render(
      <EntryLoginMainFields
        {...baseProps}
        titleRequired
        passwordRequired
        onToggleShowPassword={onToggleShowPassword}
      />
    );

    expect(screen.getByLabelText("Title").hasAttribute("required")).toBe(true);
    expect(screen.getByLabelText("Password").hasAttribute("required")).toBe(true);

    const passwordInput = screen.getByLabelText("Password");
    const passwordRow = passwordInput.closest("div");
    const toggleButton = passwordRow?.querySelector("button");
    expect(toggleButton).toBeTruthy();
    fireEvent.click(toggleButton as HTMLButtonElement);
    expect(onToggleShowPassword).toHaveBeenCalledTimes(1);
  });

  it("switches generator label and passes onUse through to parent", () => {
    const onGeneratorUse = vi.fn();

    const { rerender } = render(<EntryLoginMainFields {...baseProps} onGeneratorUse={onGeneratorUse} />);

    expect(screen.getByRole("button", { name: /generate/i })).toBeTruthy();

    rerender(<EntryLoginMainFields {...baseProps} onGeneratorUse={onGeneratorUse} showGenerator />);
    expect(screen.getByRole("button", { name: /close/i })).toBeTruthy();

    fireEvent.click(screen.getByTestId("generator-use"));
    expect(onGeneratorUse).toHaveBeenCalledWith("generated-password", DEFAULT_GENERATOR_SETTINGS);
  });
});
