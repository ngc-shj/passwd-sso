import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";

vi.mock("@/components/settings/developer/delegation-manager", () => ({ DelegationManager: () => null }));

import DelegationPage from "./page";
import { DelegationManager } from "@/components/settings/developer/delegation-manager";

describe("DelegationPage", () => {
  it("renders the delegation manager", () => {
    const el = DelegationPage() as ReactElement;
    expect(el.type).toBe(DelegationManager);
    expect(el.props).toEqual({});
  });
});
