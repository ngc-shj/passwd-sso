// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import React from "react";

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
  appUrl: (path: string) => `https://example.com${path}`,
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

vi.mock("@/components/passwords/shared/copy-button", () => ({
  CopyButton: ({ getValue }: { getValue: () => string }) => (
    <button data-testid="copy-btn" onClick={() => getValue()}>copy</button>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled }: React.ComponentProps<"button">) => (
    <button onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));

import { TeamPendingInvitationsList } from "../team-pending-invitations-list";
import type { Invitation } from "../team-pending-invitations-list";

const SAMPLE_INVITATIONS: Invitation[] = [
  {
    id: "inv-1",
    email: "charlie@example.com",
    role: "MEMBER",
    token: "tok-abc",
    expiresAt: "2026-06-01T00:00:00Z",
    invitedBy: { name: "Admin" },
  },
];

describe("TeamPendingInvitationsList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the empty state when invitations list is empty", () => {
    // Per round-1 code-review F3: render header always; show empty-state
    // copy when there are no invitations (avoids layout shift after first
    // invite is sent).
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

    const cancelButtons = screen.getAllByRole("button");
    // The X button (last one in row, after copy-btn)
    const xBtn = cancelButtons.find((b) => !b.hasAttribute("data-testid"));
    await act(async () => {
      fireEvent.click(xBtn!);
    });

    await waitFor(() => {
      expect(mockFetchApi).toHaveBeenCalledWith(
        "/api/teams/team-1/invitations/inv-1",
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    expect(onCancel).toHaveBeenCalled();
  });
});
