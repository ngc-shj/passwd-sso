/**
 * The admin layout's passkey branches (plan C2 N4, D6, D7).
 *
 * A server component, so the layout is invoked directly and the element it
 * returns is inspected. Its own auth() is fresh where the proxy's view may be
 * cached, so it re-checks: degraded renders the retry state in place, blocked
 * redirects to the passkey page.
 *
 * Every verdict cell sets `passkeyBlocked` OPPOSITE to what the raw fields give
 * under the fixed test clock (I5).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement, ReactNode } from "react";

const { mockAuth, mockRedirect, mockGetTenantRole, mockGetAdminTeamMemberships } = vi.hoisted(
  () => ({
    mockAuth: vi.fn(),
    mockRedirect: vi.fn(),
    mockGetTenantRole: vi.fn(),
    mockGetAdminTeamMemberships: vi.fn(),
  }),
);

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/i18n/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next-intl/server", () => ({
  getMessages: async () => ({}),
  setRequestLocale: () => {},
}));
vi.mock("next-intl", () => ({
  NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/tenant-rls", () => ({ withBypassRls: vi.fn() }));
vi.mock("@/lib/auth/access/tenant-auth", () => ({
  getTenantRole: mockGetTenantRole,
  isTenantAdminRole: (role: string | null) => role === "OWNER" || role === "ADMIN",
}));
vi.mock("@/lib/auth/access/team-auth", () => ({
  getAdminTeamMemberships: mockGetAdminTeamMemberships,
}));
vi.mock("@/components/admin/admin-shell", () => ({
  AdminShell: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/auth/session-state-unavailable", () => ({
  SessionStateUnavailable: () => null,
}));

import AdminLayout from "./layout";
import { AdminShell } from "@/components/admin/admin-shell";
import { SessionStateUnavailable } from "@/components/auth/session-state-unavailable";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const RAW_PAST_GRACE = {
  requirePasskey: true,
  hasPasskey: false,
  requirePasskeyEnabledAt: new Date(NOW.getTime() - 8 * DAY_MS).toISOString(),
  passkeyGracePeriodDays: 7,
};
const RAW_IN_GRACE = {
  ...RAW_PAST_GRACE,
  requirePasskeyEnabledAt: new Date(NOW.getTime() - 6 * DAY_MS).toISOString(),
};

function sessionWith(user: Record<string, unknown>) {
  return { user: { id: "user-1", ...user } };
}

async function renderLayout(): Promise<ReactElement> {
  return (await AdminLayout({
    children: <div data-testid="page" />,
    params: Promise.resolve({ locale: "en" }),
  })) as ReactElement;
}

function content(el: ReactElement): ReactElement {
  return (el.props as { children: ReactElement }).children;
}

describe("AdminLayout passkey branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockRedirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });
    mockGetTenantRole.mockResolvedValue("ADMIN");
    mockGetAdminTeamMemberships.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("redirects past grace to the passkey page, even when passkeyBlocked says false", async () => {
    mockAuth.mockResolvedValue(sessionWith({ ...RAW_PAST_GRACE, passkeyBlocked: false }));

    await expect(renderLayout()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledWith({
      href: "/dashboard/settings/auth/passkey",
      locale: "en",
    });
    expect(mockGetTenantRole).not.toHaveBeenCalled();
  });

  it("renders the admin shell inside grace, even when passkeyBlocked says true", async () => {
    mockAuth.mockResolvedValue(sessionWith({ ...RAW_IN_GRACE, passkeyBlocked: true }));

    expect(content(await renderLayout()).type).toBe(AdminShell);
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("renders the retry state in place for a degraded session, checked before the blocked verdict", async () => {
    mockAuth.mockResolvedValue(
      sessionWith({ ...RAW_PAST_GRACE, passkeyBlocked: false, passkeyStateDegraded: true }),
    );

    expect(content(await renderLayout()).type).toBe(SessionStateUnavailable);
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockGetTenantRole).not.toHaveBeenCalled();
  });
});
