// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const { mockReplace } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

import TenantServiceAccountsPage from "../page";

describe("TenantServiceAccountsPage", () => {
  it("redirects to /admin/tenant/service-accounts/accounts", () => {
    render(<TenantServiceAccountsPage />);
    expect(mockReplace).toHaveBeenCalledWith("/admin/tenant/service-accounts/accounts");
  });
});
