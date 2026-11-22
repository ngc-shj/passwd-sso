import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";

vi.mock("@/components/team/management/team-export", () => ({ TeamExportPagePanel: () => null }));

import TeamExportPage from "./page";
import { TeamExportPagePanel } from "@/components/team/management/team-export";

describe("TeamExportPage", () => {
  it("renders the team export panel for the team in the route", async () => {
    const el = (await TeamExportPage({ params: Promise.resolve({ teamId: "team-42" }) })) as ReactElement;
    expect(el.type).toBe(TeamExportPagePanel);
    expect(el.props).toEqual({ teamId: "team-42" });
  });
});
