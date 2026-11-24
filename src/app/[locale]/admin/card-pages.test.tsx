// @vitest-environment jsdom
/**
 * Admin leaf pages each mount exactly one settings card. What a page decides
 * is which card, and — for the shared cards — which variant or policy section
 * and which team. Each case asserts the card by its rendered marker and the
 * exact props it received.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { Suspense, type ComponentType, type ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";

const { cards } = vi.hoisted(() => {
  const make = (testId: string) =>
    vi.fn((_props: Record<string, unknown>): ReactNode => <div data-testid={testId} />);
  return {
    cards: {
      TeamPolicySettings: make("TeamPolicySettings"),
      TeamWebhookCard: make("TeamWebhookCard"),
      TenantAuditLogCard: make("TenantAuditLogCard"),
      AuditDeliveryTargetCard: make("AuditDeliveryTargetCard"),
      DirectorySyncCard: make("DirectorySyncCard"),
      ScimProvisioningCard: make("ScimProvisioningCard"),
      TenantWebhookCard: make("TenantWebhookCard"),
      McpClientCard: make("McpClientCard"),
      OperatorTokenCard: make("OperatorTokenCard"),
      AccessRequestCard: make("AccessRequestCard"),
      ServiceAccountCard: make("ServiceAccountCard"),
      TenantAccessRestrictionCard: make("TenantAccessRestrictionCard"),
      TenantLockoutPolicyCard: make("TenantLockoutPolicyCard"),
      TenantPasskeyPolicyCard: make("TenantPasskeyPolicyCard"),
      TenantPasswordPolicyCard: make("TenantPasswordPolicyCard"),
      TenantSessionPolicyCard: make("TenantSessionPolicyCard"),
      TenantDelegationPolicyCard: make("TenantDelegationPolicyCard"),
      TenantTokenPolicyCard: make("TenantTokenPolicyCard"),
      TenantRetentionPolicyCard: make("TenantRetentionPolicyCard"),
    },
  };
});

vi.mock("next-intl", () => ({ useLocale: () => "ja" }));
vi.mock("@/components/team/security/team-policy-settings", () => ({
  TeamPolicySettings: cards.TeamPolicySettings,
}));
vi.mock("@/components/team/security/team-webhook-card", () => ({
  TeamWebhookCard: cards.TeamWebhookCard,
}));
vi.mock("@/components/settings/account/tenant-audit-log-card", () => ({
  TenantAuditLogCard: cards.TenantAuditLogCard,
}));
vi.mock("@/components/settings/developer/audit-delivery-target-card", () => ({
  AuditDeliveryTargetCard: cards.AuditDeliveryTargetCard,
}));
vi.mock("@/components/settings/developer/directory-sync-card", () => ({
  DirectorySyncCard: cards.DirectorySyncCard,
}));
vi.mock("@/components/settings/developer/scim-provisioning-card", () => ({
  ScimProvisioningCard: cards.ScimProvisioningCard,
}));
vi.mock("@/components/settings/developer/tenant-webhook-card", () => ({
  TenantWebhookCard: cards.TenantWebhookCard,
}));
vi.mock("@/components/settings/developer/mcp-client-card", () => ({
  McpClientCard: cards.McpClientCard,
}));
vi.mock("@/components/settings/developer/operator-token-card", () => ({
  OperatorTokenCard: cards.OperatorTokenCard,
}));
vi.mock("@/components/settings/developer/access-request-card", () => ({
  AccessRequestCard: cards.AccessRequestCard,
}));
vi.mock("@/components/settings/developer/service-account-card", () => ({
  ServiceAccountCard: cards.ServiceAccountCard,
}));
vi.mock("@/components/settings/security/tenant-access-restriction-card", () => ({
  TenantAccessRestrictionCard: cards.TenantAccessRestrictionCard,
}));
vi.mock("@/components/settings/security/tenant-lockout-policy-card", () => ({
  TenantLockoutPolicyCard: cards.TenantLockoutPolicyCard,
}));
vi.mock("@/components/settings/security/tenant-passkey-policy-card", () => ({
  TenantPasskeyPolicyCard: cards.TenantPasskeyPolicyCard,
}));
vi.mock("@/components/settings/security/tenant-password-policy-card", () => ({
  TenantPasswordPolicyCard: cards.TenantPasswordPolicyCard,
}));
vi.mock("@/components/settings/security/tenant-session-policy-card", () => ({
  TenantSessionPolicyCard: cards.TenantSessionPolicyCard,
}));
vi.mock("@/components/settings/security/tenant-delegation-policy-card", () => ({
  TenantDelegationPolicyCard: cards.TenantDelegationPolicyCard,
}));
vi.mock("@/components/settings/security/tenant-token-policy-card", () => ({
  TenantTokenPolicyCard: cards.TenantTokenPolicyCard,
}));
vi.mock("@/components/settings/account/tenant-retention-policy-card", () => ({
  TenantRetentionPolicyCard: cards.TenantRetentionPolicyCard,
}));

import TeamPolicyAccessRestrictionPage from "@/app/[locale]/admin/teams/[teamId]/policy/access-restriction/page";
import TeamPolicyPasswordPage from "@/app/[locale]/admin/teams/[teamId]/policy/password/page";
import TeamPolicySessionPage from "@/app/[locale]/admin/teams/[teamId]/policy/session/page";
import TeamPolicySharingPage from "@/app/[locale]/admin/teams/[teamId]/policy/sharing/page";
import TeamWebhooksPage from "@/app/[locale]/admin/teams/[teamId]/webhooks/page";
import * as auditLogsPage from "@/app/[locale]/admin/tenant/audit-logs/page";
import * as breakglassPage from "@/app/[locale]/admin/tenant/breakglass/page";
import AuditDeliveryPage from "@/app/[locale]/admin/tenant/integrations/audit-delivery/page";
import DirectorySyncPage from "@/app/[locale]/admin/tenant/integrations/provisioning/directory-sync/page";
import ScimPage from "@/app/[locale]/admin/tenant/integrations/provisioning/scim/page";
import TenantWebhooksPage from "@/app/[locale]/admin/tenant/integrations/webhooks/page";
import McpClientsPage from "@/app/[locale]/admin/tenant/machine-identity/mcp-clients/page";
import OperatorTokensPage from "@/app/[locale]/admin/tenant/machine-identity/operator-tokens/page";
import AccessRequestsPage from "@/app/[locale]/admin/tenant/machine-identity/service-accounts/access-requests/page";
import ServiceAccountsPage from "@/app/[locale]/admin/tenant/machine-identity/service-accounts/accounts/page";
import TenantAccessRestrictionPage from "@/app/[locale]/admin/tenant/policies/access-restriction/page";
import LockoutPolicyPage from "@/app/[locale]/admin/tenant/policies/authentication/lockout/page";
import PasskeyPolicyPage from "@/app/[locale]/admin/tenant/policies/authentication/passkey/page";
import PasswordPolicyPage from "@/app/[locale]/admin/tenant/policies/authentication/password/page";
import TenantSessionPolicyPage from "@/app/[locale]/admin/tenant/policies/authentication/session/page";
import DelegationPolicyPage from "@/app/[locale]/admin/tenant/policies/machine-identity/delegation/page";
import TokenPolicyPage from "@/app/[locale]/admin/tenant/policies/machine-identity/token/page";
import RetentionPolicyPage from "@/app/[locale]/admin/tenant/policies/retention/page";

type CardName = keyof typeof cards;
// Tenant pages take no props; React ignores the extra params prop.
type RoutePage = ComponentType<{ params: Promise<{ teamId: string }> }>;

const TEAM_ID = "team-42";

async function renderPage(Page: RoutePage) {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <Page params={Promise.resolve({ teamId: TEAM_ID })} />
      </Suspense>,
    );
  });
}

function propsOf(card: CardName): Record<string, unknown> | undefined {
  return cards[card].mock.lastCall?.[0];
}

const cases: [string, CardName, RoutePage, Record<string, unknown>][] = [
  [
    "team access-restriction policy",
    "TeamPolicySettings",
    TeamPolicyAccessRestrictionPage,
    { teamId: TEAM_ID, section: "access-restriction" },
  ],
  ["team password policy", "TeamPolicySettings", TeamPolicyPasswordPage, { teamId: TEAM_ID, section: "password" }],
  ["team session policy", "TeamPolicySettings", TeamPolicySessionPage, { teamId: TEAM_ID, section: "session" }],
  ["team sharing policy", "TeamPolicySettings", TeamPolicySharingPage, { teamId: TEAM_ID, section: "sharing" }],
  ["team webhooks", "TeamWebhookCard", TeamWebhooksPage, { teamId: TEAM_ID, locale: "ja" }],
  ["tenant audit logs", "TenantAuditLogCard", auditLogsPage.default, { variant: "logs" }],
  ["tenant break glass", "TenantAuditLogCard", breakglassPage.default, { variant: "breakglass" }],
  ["tenant audit delivery", "AuditDeliveryTargetCard", AuditDeliveryPage, {}],
  ["tenant directory sync", "DirectorySyncCard", DirectorySyncPage, {}],
  ["tenant SCIM", "ScimProvisioningCard", ScimPage, {}],
  ["tenant webhooks", "TenantWebhookCard", TenantWebhooksPage, {}],
  ["tenant MCP clients", "McpClientCard", McpClientsPage, {}],
  ["tenant operator tokens", "OperatorTokenCard", OperatorTokensPage, {}],
  ["tenant access requests", "AccessRequestCard", AccessRequestsPage, {}],
  ["tenant service accounts", "ServiceAccountCard", ServiceAccountsPage, {}],
  ["tenant access restriction policy", "TenantAccessRestrictionCard", TenantAccessRestrictionPage, {}],
  ["tenant lockout policy", "TenantLockoutPolicyCard", LockoutPolicyPage, {}],
  ["tenant passkey policy", "TenantPasskeyPolicyCard", PasskeyPolicyPage, {}],
  ["tenant password policy", "TenantPasswordPolicyCard", PasswordPolicyPage, {}],
  ["tenant session policy", "TenantSessionPolicyCard", TenantSessionPolicyPage, {}],
  ["tenant delegation policy", "TenantDelegationPolicyCard", DelegationPolicyPage, {}],
  ["tenant token policy", "TenantTokenPolicyCard", TokenPolicyPage, {}],
  ["tenant retention policy", "TenantRetentionPolicyCard", RetentionPolicyPage, {}],
];

describe("admin card pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(cases)("%s page mounts %s with its props", async (_name, card, Page, expectedProps) => {
    await renderPage(Page);

    expect(screen.getByTestId(card)).toBeInTheDocument();
    expect(document.querySelectorAll("[data-testid]")).toHaveLength(1);
    expect(propsOf(card)).toEqual(expectedProps);
  });

  it("opts the tenant audit-log page out of caching", () => {
    expect(auditLogsPage.dynamic).toBe("force-dynamic");
  });

  it("opts the tenant break-glass page out of caching", () => {
    expect(breakglassPage.dynamic).toBe("force-dynamic");
  });
});
