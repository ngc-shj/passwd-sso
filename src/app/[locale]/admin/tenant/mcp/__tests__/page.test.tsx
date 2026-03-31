// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const { mockReplace } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

import TenantMcpPage from "../page";

describe("TenantMcpPage", () => {
  it("redirects to /admin/tenant/mcp/clients", () => {
    render(<TenantMcpPage />);
    expect(mockReplace).toHaveBeenCalledWith("/admin/tenant/mcp/clients");
  });
});
