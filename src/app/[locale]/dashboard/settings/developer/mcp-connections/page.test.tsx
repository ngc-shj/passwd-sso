import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";

vi.mock("@/components/settings/developer/mcp-connections-card", () => ({ McpConnectionsCard: () => null }));

import McpConnectionsPage from "./page";
import { McpConnectionsCard } from "@/components/settings/developer/mcp-connections-card";

describe("McpConnectionsPage", () => {
  it("renders the MCP connections card", () => {
    const el = McpConnectionsPage() as ReactElement;
    expect(el.type).toBe(McpConnectionsCard);
    expect(el.props).toEqual({});
  });
});
