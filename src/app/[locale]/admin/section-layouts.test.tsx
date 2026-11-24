// @vitest-environment jsdom
/**
 * Admin section layouts own only their section header and sub-navigation:
 * which icon, which AdminConsole title/description keys, and which sub-page
 * links (team-scoped ones carry the route's teamId). Each case asserts the
 * exact props handed to SectionLayout and that the route's children render
 * inside it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { Suspense, type ComponentType, type ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import {
  Archive,
  Blocks,
  Bot,
  Clock,
  Cpu,
  Crown,
  Database,
  FolderSync,
  Globe,
  Handshake,
  Key,
  KeyRound,
  List,
  ListChecks,
  Lock,
  ScrollText,
  Send,
  Settings2,
  Share2,
  Shield,
  ShieldAlert,
  ShieldBan,
  ShieldCheck,
  Trash2,
  User,
  Users,
  Webhook,
  type LucideIcon,
} from "lucide-react";

const { mockSectionLayout } = vi.hoisted(() => ({
  mockSectionLayout: vi.fn(({ children }: { children: ReactNode }) => (
    <div data-testid="section-layout">{children}</div>
  )),
}));

vi.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));
vi.mock("@/components/settings/account/section-layout", () => ({
  SectionLayout: mockSectionLayout,
}));
vi.mock("@/components/settings/account/tenant-members-card", () => ({
  TenantMembersCard: () => <div data-testid="tenant-members-card" />,
}));

import TeamGeneralLayout from "@/app/[locale]/admin/teams/[teamId]/general/layout";
import TeamKeyRotationLayout from "@/app/[locale]/admin/teams/[teamId]/key-rotation/layout";
import TeamMembersLayout from "@/app/[locale]/admin/teams/[teamId]/members/layout";
import TeamPolicyLayout from "@/app/[locale]/admin/teams/[teamId]/policy/layout";
import TeamWebhooksLayout from "@/app/[locale]/admin/teams/[teamId]/webhooks/layout";
import TenantAuditLogsLayout from "@/app/[locale]/admin/tenant/audit-logs/layout";
import TenantBreakglassLayout from "@/app/[locale]/admin/tenant/breakglass/layout";
import TenantIntegrationsAuditDeliveryLayout from "@/app/[locale]/admin/tenant/integrations/audit-delivery/layout";
import TenantIntegrationsProvisioningLayout from "@/app/[locale]/admin/tenant/integrations/provisioning/layout";
import TenantIntegrationsWebhooksLayout from "@/app/[locale]/admin/tenant/integrations/webhooks/layout";
import TenantMachineIdentityMcpClientsLayout from "@/app/[locale]/admin/tenant/machine-identity/mcp-clients/layout";
import TenantOperatorTokensLayout from "@/app/[locale]/admin/tenant/machine-identity/operator-tokens/layout";
import TenantMachineIdentityServiceAccountsLayout from "@/app/[locale]/admin/tenant/machine-identity/service-accounts/layout";
import TenantMembersPage from "@/app/[locale]/admin/tenant/members/page";
import TenantPoliciesAccessRestrictionLayout from "@/app/[locale]/admin/tenant/policies/access-restriction/layout";
import TenantPoliciesAuthenticationLayout from "@/app/[locale]/admin/tenant/policies/authentication/layout";
import TenantPoliciesMachineIdentityLayout from "@/app/[locale]/admin/tenant/policies/machine-identity/layout";
import TenantPoliciesRetentionLayout from "@/app/[locale]/admin/tenant/policies/retention/layout";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

interface ExpectedHeader {
  icon: LucideIcon;
  title: string;
  description: string;
  navItems?: NavItem[];
}

// Tenant layouts take only children; React ignores the extra params prop.
type RouteLayout = ComponentType<{ children: ReactNode; params: Promise<{ teamId: string }> }>;

const TEAM_ID = "team-42";

async function renderLayout(Layout: RouteLayout) {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <Layout params={Promise.resolve({ teamId: TEAM_ID })}>
          <div data-testid="route-child" />
        </Layout>
      </Suspense>,
    );
  });
}

function lastHeaderProps(): ExpectedHeader {
  const props = mockSectionLayout.mock.lastCall?.[0] as unknown as ExpectedHeader & { children: ReactNode };
  return {
    icon: props.icon,
    title: props.title,
    description: props.description,
    ...(props.navItems ? { navItems: props.navItems } : {}),
  };
}

const nav = (href: string, label: string, icon: LucideIcon): NavItem => ({
  href,
  label: `AdminConsole.${label}`,
  icon,
});

const header = (icon: LucideIcon, key: string, navItems?: NavItem[]): ExpectedHeader => ({
  icon,
  title: `AdminConsole.${key}`,
  description: `AdminConsole.${key}Desc`,
  ...(navItems ? { navItems } : {}),
});

const teamCases: [string, RouteLayout, ExpectedHeader][] = [
  [
    "team general",
    TeamGeneralLayout,
    header(Settings2, "teamSectionGeneral", [
      nav(`/admin/teams/${TEAM_ID}/general/profile`, "subTabProfile", User),
      nav(`/admin/teams/${TEAM_ID}/general/delete`, "subTabDelete", Trash2),
    ]),
  ],
  ["team key rotation", TeamKeyRotationLayout, header(KeyRound, "teamSectionKeyRotation")],
  [
    "team members",
    TeamMembersLayout,
    header(Users, "teamSectionMembers", [
      nav(`/admin/teams/${TEAM_ID}/members/list`, "subTabMembersList", List),
      nav(`/admin/teams/${TEAM_ID}/members/transfer-ownership`, "subTabMembersTransferOwnership", Crown),
    ]),
  ],
  [
    "team policy",
    TeamPolicyLayout,
    header(ListChecks, "teamSectionPolicy", [
      nav(`/admin/teams/${TEAM_ID}/policy/password`, "subTabPassword", Lock),
      nav(`/admin/teams/${TEAM_ID}/policy/session`, "subTabSession", Clock),
      nav(`/admin/teams/${TEAM_ID}/policy/sharing`, "subTabSharing", Share2),
      nav(`/admin/teams/${TEAM_ID}/policy/access-restriction`, "subTabAccessRestriction", Globe),
    ]),
  ],
  ["team webhooks", TeamWebhooksLayout, header(Webhook, "teamSectionWebhooks")],
];

const tenantCases: [string, RouteLayout, ExpectedHeader][] = [
  ["tenant audit logs", TenantAuditLogsLayout, header(ScrollText, "sectionAuditLogs")],
  ["tenant break glass", TenantBreakglassLayout, header(ShieldAlert, "sectionBreakglass")],
  [
    "tenant audit delivery",
    TenantIntegrationsAuditDeliveryLayout,
    header(Send, "sectionIntegrationAuditDelivery"),
  ],
  [
    "tenant provisioning",
    TenantIntegrationsProvisioningLayout,
    header(Handshake, "sectionIntegrationProvisioning", [
      nav("/admin/tenant/integrations/provisioning/scim", "subTabScim", Database),
      nav("/admin/tenant/integrations/provisioning/directory-sync", "subTabDirectorySync", FolderSync),
    ]),
  ],
  ["tenant webhooks", TenantIntegrationsWebhooksLayout, header(Webhook, "sectionIntegrationWebhooks")],
  [
    "tenant MCP clients",
    TenantMachineIdentityMcpClientsLayout,
    header(Blocks, "sectionMachineIdentityMcpClients"),
  ],
  [
    "tenant operator tokens",
    TenantOperatorTokensLayout,
    header(KeyRound, "sectionMachineIdentityOperatorTokens"),
  ],
  [
    "tenant service accounts",
    TenantMachineIdentityServiceAccountsLayout,
    header(Bot, "sectionMachineIdentityServiceAccounts", [
      nav("/admin/tenant/machine-identity/service-accounts/accounts", "subTabSaAccounts", Bot),
      nav(
        "/admin/tenant/machine-identity/service-accounts/access-requests",
        "subTabSaAccessRequests",
        ShieldCheck,
      ),
    ]),
  ],
  [
    "tenant access restriction policy",
    TenantPoliciesAccessRestrictionLayout,
    header(ShieldBan, "sectionPolicyAccessRestriction"),
  ],
  [
    "tenant authentication policy",
    TenantPoliciesAuthenticationLayout,
    header(Shield, "sectionPolicyAuthentication", [
      nav("/admin/tenant/policies/authentication/password", "subTabPassword", Lock),
      nav("/admin/tenant/policies/authentication/session", "subTabSession", Clock),
      nav("/admin/tenant/policies/authentication/passkey", "subTabPasskey", KeyRound),
      nav("/admin/tenant/policies/authentication/lockout", "subTabLockout", ShieldAlert),
    ]),
  ],
  [
    "tenant machine-identity policy",
    TenantPoliciesMachineIdentityLayout,
    header(Cpu, "sectionPolicyMachineIdentity", [
      nav("/admin/tenant/policies/machine-identity/token", "subTabToken", Key),
      nav("/admin/tenant/policies/machine-identity/delegation", "subTabDelegation", Handshake),
    ]),
  ],
  ["tenant retention policy", TenantPoliciesRetentionLayout, header(Archive, "sectionPolicyRetention")],
];

describe("admin section layouts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(teamCases)("%s layout passes its header and team-scoped nav", async (_name, Layout, expected) => {
    await renderLayout(Layout);

    expect(lastHeaderProps()).toEqual(expected);
    expect(screen.getByTestId("section-layout")).toContainElement(screen.getByTestId("route-child"));
  });

  it.each(tenantCases)("%s layout passes its header and nav", async (_name, Layout, expected) => {
    await renderLayout(Layout);

    expect(lastHeaderProps()).toEqual(expected);
    expect(screen.getByTestId("section-layout")).toContainElement(screen.getByTestId("route-child"));
  });

  it("tenant members page wraps the members card in the members section header", async () => {
    await act(async () => {
      render(<TenantMembersPage />);
    });

    expect(lastHeaderProps()).toEqual(header(Users, "sectionMembers"));
    expect(screen.getByTestId("section-layout")).toContainElement(screen.getByTestId("tenant-members-card"));
  });
});
