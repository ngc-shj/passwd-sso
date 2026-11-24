/**
 * Admin section index pages own no content; each one decides which sub-page
 * a bare section URL lands on, under the request locale.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRedirect, mockGetLocale } = vi.hoisted(() => ({
  mockRedirect: vi.fn(),
  mockGetLocale: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next-intl/server", () => ({ getLocale: mockGetLocale }));

import TeamGeneralPage from "@/app/[locale]/admin/teams/[teamId]/general/page";
import TeamMembersPage from "@/app/[locale]/admin/teams/[teamId]/members/page";
import TeamPolicyPage from "@/app/[locale]/admin/teams/[teamId]/policy/page";
import TenantIntegrationsPage from "@/app/[locale]/admin/tenant/integrations/page";
import TenantIntegrationsProvisioningPage from "@/app/[locale]/admin/tenant/integrations/provisioning/page";
import TenantMachineIdentityPage from "@/app/[locale]/admin/tenant/machine-identity/page";
import TenantMachineIdentityServiceAccountsPage from "@/app/[locale]/admin/tenant/machine-identity/service-accounts/page";
import TenantPoliciesAuthenticationPage from "@/app/[locale]/admin/tenant/policies/authentication/page";
import TenantPoliciesMachineIdentityPage from "@/app/[locale]/admin/tenant/policies/machine-identity/page";
import TenantPoliciesPage from "@/app/[locale]/admin/tenant/policies/page";

const teamParams = { params: Promise.resolve({ teamId: "team-7" }) };

describe("admin section index redirects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLocale.mockResolvedValue("ja");
    mockRedirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });
  });

  it.each([
    ["team general → profile", () => TeamGeneralPage(teamParams), "/ja/admin/teams/team-7/general/profile"],
    ["team members → list", () => TeamMembersPage(teamParams), "/ja/admin/teams/team-7/members/list"],
    ["team policy → password", () => TeamPolicyPage(teamParams), "/ja/admin/teams/team-7/policy/password"],
    ["tenant integrations → SCIM", () => TenantIntegrationsPage(), "/ja/admin/tenant/integrations/provisioning/scim"],
    [
      "tenant provisioning → SCIM",
      () => TenantIntegrationsProvisioningPage(),
      "/ja/admin/tenant/integrations/provisioning/scim",
    ],
    [
      "tenant machine identity → service accounts",
      () => TenantMachineIdentityPage(),
      "/ja/admin/tenant/machine-identity/service-accounts/accounts",
    ],
    [
      "tenant service accounts → accounts",
      () => TenantMachineIdentityServiceAccountsPage(),
      "/ja/admin/tenant/machine-identity/service-accounts/accounts",
    ],
    [
      "tenant authentication policy → password",
      () => TenantPoliciesAuthenticationPage(),
      "/ja/admin/tenant/policies/authentication/password",
    ],
    [
      "tenant machine-identity policy → token",
      () => TenantPoliciesMachineIdentityPage(),
      "/ja/admin/tenant/policies/machine-identity/token",
    ],
    ["tenant policies → authentication password", () => TenantPoliciesPage(), "/ja/admin/tenant/policies/authentication/password"],
  ])("redirects %s under the request locale", async (_name, invoke, href) => {
    await expect(invoke()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledTimes(1);
    expect(mockRedirect).toHaveBeenCalledWith(href);
  });
});
