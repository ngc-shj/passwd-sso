import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";

vi.mock("@/components/settings/account/travel-mode-card", () => ({ TravelModeCard: () => null }));

import TravelModePage from "./page";
import { TravelModeCard } from "@/components/settings/account/travel-mode-card";

describe("TravelModePage", () => {
  it("renders the travel mode card", () => {
    const el = TravelModePage() as ReactElement;
    expect(el.type).toBe(TravelModeCard);
    expect(el.props).toEqual({});
  });
});
