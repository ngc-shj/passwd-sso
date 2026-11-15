// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import React from "react";
import { toast } from "sonner";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const { mockFetchApi } = vi.hoisted(() => ({ mockFetchApi: vi.fn() }));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  useLocale: () => "en",
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: mockFetchApi,
}));

vi.mock("@/lib/constants", () => ({
  apiPath: {
    teamInvitationById: (teamId: string, invId: string) => `/api/teams/${teamId}/invitations/${invId}`,
  },
}));

vi.mock("@/lib/format/format-datetime", () => ({
  formatDate: (_date: string, _locale: string) => "2026-06-01",
}));

vi.mock("@/components/team/management/team-role-badge", () => ({
  TeamRoleBadge: ({ role }: { role: string }) => <span data-testid="role-badge">{role}</span>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled, "aria-label": ariaLabel }: React.ComponentProps<"button">) => (
    <button onClick={onClick} disabled={disabled} aria-label={ariaLabel}>{children}</button>
  ),
}));

import { apiErrorToI18nKey } from "@/lib/http/api-error-codes";
import { TeamPendingInvitationsList } from "../team-pending-invitations-list";
import type { Invitation } from "../team-pending-invitations-list";

const SAMPLE_INVITATIONS: Invitation[] = [
  {
    id: "inv-1",
    email: "charlie@example.com",
    role: "MEMBER",
    expiresAt: "2026-06-01T00:00:00Z",
    invitedBy: { name: "Admin" },
  },
];

describe("TeamPendingInvitationsList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the empty state when invitations list is empty", () => {
    // Header renders always; empty-state copy fills the body when there are
    // no invitations (so the card position doesn't shift on first invite).
    render(
      <TeamPendingInvitationsList invitations={[]} teamId="team-1" onCancel={vi.fn()} />,
    );
    expect(screen.getByText("noInvitations")).toBeInTheDocument();
  });

  it("calls fetchApi DELETE and onCancel when cancel button is clicked", async () => {
    mockFetchApi.mockResolvedValue({ ok: true });
    const onCancel = vi.fn();

    render(
      <TeamPendingInvitationsList
        invitations={SAMPLE_INVITATIONS}
        teamId="team-1"
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText("charlie@example.com")).toBeInTheDocument();

    const xBtn = screen.getByRole("button", { name: "cancelInvitation" });
    await act(async () => {
      fireEvent.click(xBtn);
    });

    await waitFor(() => {
      expect(mockFetchApi).toHaveBeenCalledWith(
        "/api/teams/team-1/invitations/inv-1",
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("invitationCancelled");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each([
    [403, "FORBIDDEN"],
    [404, "INVITATION_NOT_FOUND"],
    [409, "CONFLICT"],
  ])("shows the mapped API error and does not call onCancel on a %i response", async (status, code) => {
    mockFetchApi.mockResolvedValue(
      new Response(JSON.stringify({ error: code }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const onCancel = vi.fn();

    render(
      <TeamPendingInvitationsList
        invitations={SAMPLE_INVITATIONS}
        teamId="team-1"
        onCancel={onCancel}
      />,
    );

    const xBtn = screen.getAllByRole("button").find((b) => !b.hasAttribute("data-testid"));
    await act(async () => {
      fireEvent.click(xBtn!);
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(apiErrorToI18nKey(code));
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("shows the network error and does not call onCancel when the request throws", async () => {
    mockFetchApi.mockRejectedValue(new TypeError("fetch failed"));
    const onCancel = vi.fn();

    render(
      <TeamPendingInvitationsList
        invitations={SAMPLE_INVITATIONS}
        teamId="team-1"
        onCancel={onCancel}
      />,
    );

    const xBtn = screen.getAllByRole("button").find((b) => !b.hasAttribute("data-testid"));
    await act(async () => {
      fireEvent.click(xBtn!);
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("networkError");
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  // The link is shown once, when issued: the server keeps only its digest.
  it("offers no link to copy for a pending invitation", () => {
    render(
      <TeamPendingInvitationsList
        invitations={SAMPLE_INVITATIONS}
        teamId="team-1"
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
