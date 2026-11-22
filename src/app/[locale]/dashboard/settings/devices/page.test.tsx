import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";

vi.mock("@/components/sessions/sessions-card", () => ({ SessionsCard: () => null }));

import DevicesPage from "./page";
import { SessionsCard } from "@/components/sessions/sessions-card";

describe("DevicesPage", () => {
  it("renders the sessions card", () => {
    const el = DevicesPage() as ReactElement;
    expect(el.type).toBe(SessionsCard);
    expect(el.props).toEqual({});
  });
});
