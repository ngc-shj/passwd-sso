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
  useTranslations: () => (key: string) => key,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: mockFetchApi,
  appUrl: (path: string) => `https://example.com${path}`,
}));

vi.mock("@/lib/constants", () => ({
  TEAM_ROLE: { ADMIN: "ADMIN", MEMBER: "MEMBER", VIEWER: "VIEWER" },
  apiPath: {
    teamInvitations: (id: string) => `/api/teams/${id}/invitations`,
  },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled }: React.ComponentProps<"button">) => (
    <button onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children }: React.ComponentProps<"label">) => <label>{children}</label>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children, value, onValueChange }: { children: React.ReactNode; value?: string; onValueChange?: (v: string) => void }) => (
    <div data-testid="select" data-value={value}>
      <select value={value} onChange={(e) => onValueChange?.(e.target.value)}>{children}</select>
    </div>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => <option value={value}>{children}</option>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
}));

// Stub clipboard
Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

import { toast } from "sonner";
import { TeamInviteByEmailSection } from "../team-invite-by-email-section";

describe("TeamInviteByEmailSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables the invite button when email input is empty", () => {
    render(<TeamInviteByEmailSection teamId="team-1" onSuccess={vi.fn()} />);
    const btn = screen.getByText("inviteSend");
    expect(btn).toBeDisabled();
  });

  it("calls fetchApi POST and onSuccess when invite succeeds", async () => {
    mockFetchApi.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "abc123" }),
    });

    const onSuccess = vi.fn();
    render(<TeamInviteByEmailSection teamId="team-1" onSuccess={onSuccess} />);

    const emailInput = screen.getByPlaceholderText("inviteEmailPlaceholder");
    fireEvent.change(emailInput, { target: { value: "bob@example.com" } });

    const btn = screen.getByText("inviteSend");
    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(mockFetchApi).toHaveBeenCalledWith(
        "/api/teams/team-1/invitations",
        expect.objectContaining({ method: "POST" }),
      );
    });

    expect(onSuccess).toHaveBeenCalled();
  });
  describe("409 refusals", () => {
    async function inviteWith(res: Response) {
      mockFetchApi.mockResolvedValue(res);
      const onSuccess = vi.fn();
      render(<TeamInviteByEmailSection teamId="team-1" onSuccess={onSuccess} />);
      fireEvent.change(screen.getByPlaceholderText("inviteEmailPlaceholder"), {
        target: { value: "bob@example.com" },
      });
      await act(async () => {
        fireEvent.click(screen.getByText("inviteSend"));
      });
      expect(onSuccess).not.toHaveBeenCalled();
    }

    const conflict = (error?: string) =>
      new Response(JSON.stringify(error === undefined ? {} : { error }), { status: 409 });

    it.each([
      ["INVITATION_ALREADY_SENT", "alreadyInvited"],
      ["ALREADY_A_MEMBER", "alreadyMember"],
      ["CONFLICT", "conflict"],
      ["TEAM_BUSY", "teamBusy"],
    ])("%s shows %s", async (code, message) => {
      await inviteWith(conflict(code));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message));
      expect(toast.error).toHaveBeenCalledTimes(1);
    });

    it("a code-less 409 shows the generic message, not alreadyInvited", async () => {
      await inviteWith(conflict());
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("unknownError"));
    });
  });
});
