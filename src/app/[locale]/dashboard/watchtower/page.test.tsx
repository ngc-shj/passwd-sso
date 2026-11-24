import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";

vi.mock("@/components/watchtower/watchtower-page", () => ({ WatchtowerPage: () => null }));

import PersonalWatchtowerPage from "./page";
import { WatchtowerPage } from "@/components/watchtower/watchtower-page";

describe("PersonalWatchtowerPage", () => {
  it("renders the watchtower scoped to the personal vault", () => {
    const el = PersonalWatchtowerPage() as ReactElement;
    expect(el.type).toBe(WatchtowerPage);
    expect(el.props).toEqual({ scope: { type: "personal" } });
  });
});
