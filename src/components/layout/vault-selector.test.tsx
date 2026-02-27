// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Children, isValidElement } from "react";
import type { ReactNode } from "react";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      vault: "Vault",
      personalVault: "Vault",
    };
    return map[key] ?? key;
  },
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select
      aria-label="vault-select"
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: ReactNode;
  }) => {
    const text = Children.toArray(children)
      .map((node) => {
        if (typeof node === "string") return node;
        if (typeof node === "number") return String(node);
        if (isValidElement(node) && typeof node.props.children === "string") {
          return node.props.children;
        }
        return "";
      })
      .join("")
      .trim();

    return <option value={value}>{text || value}</option>;
  },
}));

import { VaultSelector } from "./vault-selector";

describe("VaultSelector", () => {
  it("does not render when team list is empty", () => {
    const { container } = render(
      <VaultSelector value="personal" teams={[]} onValueChange={() => {}} />
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders selector when teams exist", () => {
    render(
      <VaultSelector
        value="personal"
        teams={[{ id: "team-1", name: "Security" }]}
        onValueChange={() => {}}
      />
    );

    expect(screen.getAllByText("Vault").length).toBeGreaterThan(0);
    expect(screen.getByRole("combobox", { name: "vault-select" })).toBeTruthy();
  });

  it("calls onValueChange when team is selected", async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();

    render(
      <VaultSelector
        value="personal"
        teams={[{ id: "team-1", name: "Security" }]}
        onValueChange={onValueChange}
      />
    );

    await user.selectOptions(
      screen.getByRole("combobox", { name: "vault-select" }),
      "team-1"
    );

    expect(onValueChange).toHaveBeenCalledWith("team-1");
  });
});
