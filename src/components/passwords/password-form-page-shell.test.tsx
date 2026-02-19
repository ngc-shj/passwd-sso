// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PasswordFormPageShell } from "@/components/passwords/password-form-page-shell";

describe("PasswordFormPageShell", () => {
  it("renders title/children and calls onBack", () => {
    const onBack = vi.fn();

    render(
      <PasswordFormPageShell backLabel="Back" onBack={onBack} title="Form Title">
        <div>Form Content</div>
      </PasswordFormPageShell>,
    );

    expect(screen.getByText("Form Title")).toBeTruthy();
    expect(screen.getByText("Form Content")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
