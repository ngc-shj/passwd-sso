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

vi.mock("@/components/passwords/shared/copy-button", () => ({
  CopyButton: ({ getValue }: { getValue: () => string }) => (
    <button data-copy-value={getValue()}>copy</button>
  ),
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

  describe("the issued link (shown once: the server keeps only its digest)", () => {
    const LINK = "https://example.com/dashboard/teams/invite/abc123";
    // The label names the invitee the link belongs to.
    const BOB_LINK_LABEL = 'inviteLinkShownOnce:{"email":"bob@example.com"}';

    async function invite() {
      mockFetchApi.mockResolvedValue({ ok: true, status: 201, json: async () => ({ token: "abc123" }) });
      const onSuccess = vi.fn();
      render(<TeamInviteByEmailSection teamId="team-1" onSuccess={onSuccess} />);
      fireEvent.change(screen.getByPlaceholderText("inviteEmailPlaceholder"), {
        target: { value: "bob@example.com" },
      });
      await act(async () => {
        fireEvent.click(screen.getByText("inviteSend"));
      });
      return onSuccess;
    }

    it("is displayed and copied after a successful invite", async () => {
      await invite();
      expect(screen.getByLabelText(BOB_LINK_LABEL)).toHaveValue(LINK);
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(LINK);
      expect(toast.success).toHaveBeenCalledWith("invitedWithLink");
    });

    it("stays displayed when the clipboard refuses, and the invite is not reported as failed", async () => {
      vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("denied"));
      const onSuccess = await invite();
      expect(screen.getByLabelText(BOB_LINK_LABEL)).toHaveValue(LINK);
      expect(toast.success).toHaveBeenCalledWith("invitedLinkNotCopied");
      expect(toast.error).not.toHaveBeenCalled();
      expect(onSuccess).toHaveBeenCalled();
    });

    it("stays displayed when there is no clipboard (a non-secure origin)", async () => {
      const clipboard = navigator.clipboard;
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
      try {
        await invite();
      } finally {
        Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
      }
      expect(screen.getByLabelText(BOB_LINK_LABEL)).toHaveValue(LINK);
      expect(toast.success).toHaveBeenCalledWith("invitedLinkNotCopied");
      expect(toast.error).not.toHaveBeenCalled();
    });

    it("is cleared when the next invite is refused", async () => {
      await invite();
      expect(screen.getByLabelText(BOB_LINK_LABEL)).toHaveValue(LINK);

      mockFetchApi.mockResolvedValue(new Response(JSON.stringify({ error: "INVITATION_ALREADY_SENT" }), { status: 409 }));
      fireEvent.change(screen.getByPlaceholderText("inviteEmailPlaceholder"), {
        target: { value: "carol@example.com" },
      });
      await act(async () => {
        fireEvent.click(screen.getByText("inviteSend"));
      });
      expect(screen.queryByLabelText(/^inviteLinkShownOnce/)).not.toBeInTheDocument();
    });

    it("is not displayed when the invite is refused", async () => {
      mockFetchApi.mockResolvedValue(new Response(JSON.stringify({ error: "INVITATION_ALREADY_SENT" }), { status: 409 }));
      render(<TeamInviteByEmailSection teamId="team-1" onSuccess={vi.fn()} />);
      fireEvent.change(screen.getByPlaceholderText("inviteEmailPlaceholder"), {
        target: { value: "bob@example.com" },
      });
      await act(async () => {
        fireEvent.click(screen.getByText("inviteSend"));
      });
      expect(screen.queryByLabelText(/^inviteLinkShownOnce/)).not.toBeInTheDocument();
    });
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
