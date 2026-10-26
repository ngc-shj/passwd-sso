/**
 * The dashboard layout's passkey branches (plan C2, D6, D7).
 *
 * A server component, so the layout is invoked directly and the element it
 * returns is inspected. The rendered screens are stubbed so a branch is told
 * apart by component identity rather than by copy.
 *
 * Every verdict cell sets `passkeyBlocked` OPPOSITE to what the raw fields give
 * under the fixed test clock (I5): a layout that read the display verdict
 * instead of `passkeyEnforcementBlocks` over the raw fields goes red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement, ReactNode } from "react";

const { mockAuth, mockRedirect } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRedirect: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/i18n/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next-intl/server", () => ({
  getMessages: async () => ({}),
  setRequestLocale: () => {},
}));
vi.mock("next-intl", () => ({
  NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
}));
// passkey-enforcement's DB helper is not called by the layout; only its
// module-level imports need satisfying.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/tenant-rls", () => ({ withBypassRls: vi.fn() }));
vi.mock("@/components/vault/vault-gate", () => ({
  VaultGate: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/layout/dashboard-shell", () => ({
  DashboardShell: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/auth/passkey-required-screen", () => ({
  PasskeyRequiredScreen: () => null,
}));
vi.mock("@/components/auth/session-state-unavailable", () => ({
  SessionStateUnavailable: () => null,
}));

import DashboardLayout from "./layout";
import { VaultGate } from "@/components/vault/vault-gate";
import { PasskeyRequiredScreen } from "@/components/auth/passkey-required-screen";
import { SessionStateUnavailable } from "@/components/auth/session-state-unavailable";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_DAYS = 7;

// Enforcement enabled 8 days ago with a 7-day grace: past grace → blocks.
const RAW_PAST_GRACE = {
  requirePasskey: true,
  hasPasskey: false,
  requirePasskeyEnabledAt: new Date(NOW.getTime() - 8 * DAY_MS).toISOString(),
  passkeyGracePeriodDays: GRACE_DAYS,
};
// Enabled 6 days ago with the same grace: inside grace → allowed.
const RAW_IN_GRACE = {
  ...RAW_PAST_GRACE,
  requirePasskeyEnabledAt: new Date(NOW.getTime() - 6 * DAY_MS).toISOString(),
};

function sessionWith(user: Record<string, unknown>) {
  return { user: { id: "user-1", ...user } };
}

async function renderLayout(): Promise<ReactElement> {
  return (await DashboardLayout({
    children: <div data-testid="page" />,
    params: Promise.resolve({ locale: "ja" }),
  })) as ReactElement;
}

/** The single element the layout renders inside the intl provider. */
function content(el: ReactElement): ReactElement {
  return (el.props as { children: ReactElement }).children;
}

describe("DashboardLayout passkey branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockRedirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the passkey-required screen past grace, even when passkeyBlocked says false", async () => {
    mockAuth.mockResolvedValue(sessionWith({ ...RAW_PAST_GRACE, passkeyBlocked: false }));

    expect(content(await renderLayout()).type).toBe(PasskeyRequiredScreen);
  });

  it("renders the vault gate inside grace, even when passkeyBlocked says true", async () => {
    mockAuth.mockResolvedValue(sessionWith({ ...RAW_IN_GRACE, passkeyBlocked: true }));

    expect(content(await renderLayout()).type).toBe(VaultGate);
  });

  it("renders the retry state for a degraded session, checked before the blocked verdict", async () => {
    // The raw fields block as well: only checking degraded FIRST yields the retry state.
    mockAuth.mockResolvedValue(
      sessionWith({ ...RAW_PAST_GRACE, passkeyBlocked: false, passkeyStateDegraded: true }),
    );

    expect(content(await renderLayout()).type).toBe(SessionStateUnavailable);
  });

  it("redirects to sign-in without a session", async () => {
    mockAuth.mockResolvedValue(null);

    await expect(renderLayout()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledWith({ href: "/auth/signin", locale: "ja" });
  });
});
