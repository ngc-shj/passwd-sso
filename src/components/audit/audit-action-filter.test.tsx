// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { AuditActionValue } from "@/lib/constants";
import { AuditActionFilter } from "./audit-action-filter";

vi.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string) => key;
    Object.assign(t, { has: () => true });
    return t;
  },
}));

// Radix Collapsible hides closed content via the `hidden` attribute, which
// breaks getByText. Stub with plain divs so child labels are queryable.
vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) => (
    asChild ? <>{children}</> : <button type="button">{children}</button>
  ),
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
  }: {
    checked?: boolean;
    onCheckedChange?: (v: boolean) => void;
  }) => (
    <input
      type="checkbox"
      aria-label="action"
      checked={!!checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
    />
  ),
}));

interface ActionGroupDef {
  value: string;
  label: string;
  actions: readonly AuditActionValue[];
}

const SAMPLE_GROUPS: readonly ActionGroupDef[] = [
  {
    value: "auth",
    label: "groupAuth",
    actions: ["AUTH_LOGIN", "AUTH_LOGOUT"] as readonly AuditActionValue[],
  },
];

function renderFilter(overrides: Partial<React.ComponentProps<typeof AuditActionFilter>> = {}) {
  const props = {
    actionGroups: SAMPLE_GROUPS,
    selectedActions: new Set<AuditActionValue>(),
    actionSearch: "",
    filterOpen: true,
    actionSummary: "all",
    actionLabel: (a: AuditActionValue | string) => `label_${a}`,
    filteredActions: (actions: readonly AuditActionValue[]) => actions,
    isActionSelected: () => false,
    toggleAction: vi.fn(),
    setGroupSelection: vi.fn(),
    clearActions: vi.fn(),
    setActionSearch: vi.fn(),
    setFilterOpen: vi.fn(),
    ...overrides,
  };
  render(<AuditActionFilter {...props} />);
  return props;
}

describe("AuditActionFilter", () => {
  it("renders the action summary inside the trigger", () => {
    renderFilter({ actionSummary: "myActions" });
    expect(screen.getByText(/myActions/)).toBeInTheDocument();
  });

  it("uses the actionLabel prop callback to render each action label (prop-driven exhaustiveness)", () => {
    renderFilter();
    expect(screen.getByText("label_AUTH_LOGIN")).toBeInTheDocument();
    expect(screen.getByText("label_AUTH_LOGOUT")).toBeInTheDocument();
  });

  it("renders a Clear button only when at least one action is selected", () => {
    const { rerender } = render(
      <AuditActionFilter
        actionGroups={SAMPLE_GROUPS}
        selectedActions={new Set<AuditActionValue>()}
        actionSearch=""
        filterOpen={true}
        actionSummary="none"
        actionLabel={(a) => String(a)}
        filteredActions={(a) => a}
        isActionSelected={() => false}
        toggleAction={vi.fn()}
        setGroupSelection={vi.fn()}
        clearActions={vi.fn()}
        setActionSearch={vi.fn()}
        setFilterOpen={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "allActions" })).toBeNull();

    rerender(
      <AuditActionFilter
        actionGroups={SAMPLE_GROUPS}
        selectedActions={new Set<AuditActionValue>(["AUTH_LOGIN"] as AuditActionValue[])}
        actionSearch=""
        filterOpen={true}
        actionSummary="some"
        actionLabel={(a) => String(a)}
        filteredActions={(a) => a}
        isActionSelected={(a) => a === "AUTH_LOGIN"}
        toggleAction={vi.fn()}
        setGroupSelection={vi.fn()}
        clearActions={vi.fn()}
        setActionSearch={vi.fn()}
        setFilterOpen={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "allActions" })).toBeInTheDocument();
  });

  it("invokes setActionSearch when typing in the search input", () => {
    const props = renderFilter();
    const input = screen.getByPlaceholderText("actionSearch") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "lo" } });
    expect(props.setActionSearch).toHaveBeenCalledWith("lo");
  });

  it("hides groups whose filteredActions is empty", () => {
    renderFilter({ filteredActions: () => [] });
    expect(screen.queryByText("label_AUTH_LOGIN")).toBeNull();
  });

  it("uses groupLabelResolver override when provided", () => {
    renderFilter({ groupLabelResolver: () => "customGroupKey" });
    expect(screen.getByText("customGroupKey")).toBeInTheDocument();
  });
});
