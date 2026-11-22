// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, act } from "@testing-library/react";

const { panelProps, mockRefresh } = vi.hoisted(() => ({
  panelProps: { current: undefined as { teamId: string; onComplete: () => void } | undefined },
  mockRefresh: vi.fn(),
}));

vi.mock("next/navigation", async () => ({
  ...(await import("@/__tests__/helpers/mock-app-navigation")).mockNextNavigation({
    router: { refresh: mockRefresh },
  }),
  useParams: () => ({ teamId: "team-9" }),
}));
vi.mock("@/components/passwords/import/password-import", () => ({
  TeamImportPagePanel: (props: { teamId: string; onComplete: () => void }) => {
    panelProps.current = props;
    return null;
  },
}));

import TeamImportPage from "./page";
import { VAULT_DATA_CHANGED_EVENT } from "@/lib/events";

describe("TeamImportPage", () => {
  const onChanged = vi.fn();
  afterEach(() => window.removeEventListener(VAULT_DATA_CHANGED_EVENT, onChanged));

  it("imports into the team named by the route", () => {
    render(<TeamImportPage />);
    expect(panelProps.current?.teamId).toBe("team-9");
  });

  it("announces the vault data change and refreshes when the import completes", () => {
    window.addEventListener(VAULT_DATA_CHANGED_EVENT, onChanged);
    render(<TeamImportPage />);
    expect(mockRefresh).not.toHaveBeenCalled();
    act(() => panelProps.current?.onComplete());
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
