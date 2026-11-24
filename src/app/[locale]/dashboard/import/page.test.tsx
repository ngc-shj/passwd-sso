// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, act } from "@testing-library/react";

const { panelProps, mockRefresh } = vi.hoisted(() => ({
  panelProps: { current: undefined as { onComplete: () => void } | undefined },
  mockRefresh: vi.fn(),
}));

vi.mock("next/navigation", async () =>
  (await import("@/__tests__/helpers/mock-app-navigation")).mockNextNavigation({
    router: { refresh: mockRefresh },
  }),
);
vi.mock("@/components/passwords/import/password-import", () => ({
  ImportPagePanel: (props: { onComplete: () => void }) => {
    panelProps.current = props;
    return null;
  },
}));

import ImportPage from "./page";
import { VAULT_DATA_CHANGED_EVENT } from "@/lib/events";

function completeImport() {
  render(<ImportPage />);
  act(() => panelProps.current?.onComplete());
}

describe("ImportPage", () => {
  const onChanged = vi.fn();
  afterEach(() => window.removeEventListener(VAULT_DATA_CHANGED_EVENT, onChanged));

  it("announces the vault data change when the import completes", () => {
    window.addEventListener(VAULT_DATA_CHANGED_EVENT, onChanged);
    completeImport();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("refreshes the router when the import completes", () => {
    completeImport();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh before the import completes", () => {
    render(<ImportPage />);
    expect(panelProps.current?.onComplete).toBeInstanceOf(Function);
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
