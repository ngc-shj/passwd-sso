// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { WatchtowerPage } from "./watchtower-page";

const {
  mockUseWatchtower,
  personalDialogProps,
  teamDialogProps,
  toastMessageMock,
  vaultUser,
} = vi.hoisted(() => ({
  vaultUser: { id: "user-1" as string | null },
  mockUseWatchtower: vi.fn(),
  personalDialogProps: vi.fn(),
  teamDialogProps: vi.fn(),
  toastMessageMock: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  useLocale: () => "en",
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: {
    message: (...args: unknown[]) => toastMessageMock(...args),
  },
}));

vi.mock("@/hooks/use-watchtower", () => ({
  OLD_THRESHOLD_DAYS: 90,
  EXPIRING_THRESHOLD_DAYS: 30,
  useWatchtower: (...args: unknown[]) => mockUseWatchtower(...args),
}));

vi.mock("@/components/passwords/dialogs/personal-password-edit-dialog-loader", () => ({
  PasswordEditDialogLoader: (props: unknown) => {
    personalDialogProps(props);
    return <div data-testid="personal-edit-dialog" />;
  },
}));

vi.mock("@/components/team/management/team-edit-dialog-loader", () => ({
  TeamEditDialogLoader: (props: unknown) => {
    teamDialogProps(props);
    return <div data-testid="team-edit-dialog" />;
  },
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ userId: vaultUser.id }),
}));

vi.mock("@/components/watchtower/issue-section", () => ({
  IssueSection: ({
    issues,
    onSelectEntry,
    canSelectEntry,
  }: {
    issues: Array<Record<string, unknown>>;
    onSelectEntry?: (entry: unknown) => void;
    canSelectEntry?: (entry: unknown) => boolean;
  }) => (
    <div>
      {issues.map((issue) => (
        <button
          key={String(issue.id)}
          disabled={canSelectEntry?.(issue) === false}
          onClick={() => onSelectEntry?.(issue)}
        >
          select-{String(issue.id)}
        </button>
      ))}
    </div>
  ),
  ReusedSection: () => null,
  DuplicateSection: () => null,
}));

describe("WatchtowerPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vaultUser.id = "user-1";
    mockUseWatchtower.mockReturnValue({
      report: {
        totalPasswords: 1,
        overallScore: 80,
        breached: [
          {
            id: "entry-1",
            title: "GitHub",
            username: "user@example.com",
            scope: "personal",
            severity: "critical",
            details: "count:1",
          },
        ],
        weak: [],
        reused: [],
        old: [],
        unsecured: [],
        duplicate: [],
        expiring: [],
        analyzedAt: new Date("2026-03-03T00:00:00Z"),
      },
      loading: false,
      progress: { current: 0, total: 0, step: "" },
      analyze: vi.fn(),
      canAnalyze: true,
      cooldownRemainingMs: 0,
      unavailableReason: null,
    });
  });

  it("does not rerun analysis after saving from the personal edit dialog", () => {
    const analyze = vi.fn();
    mockUseWatchtower.mockReturnValue({
      report: {
        totalPasswords: 1,
        overallScore: 80,
        breached: [
          {
            id: "entry-1",
            title: "GitHub",
            username: "user@example.com",
            scope: "personal",
            severity: "critical",
            details: "count:1",
          },
        ],
        weak: [],
        reused: [],
        old: [],
        unsecured: [],
        duplicate: [],
        expiring: [],
        analyzedAt: new Date("2026-03-03T00:00:00Z"),
      },
      loading: false,
      progress: { current: 0, total: 0, step: "" },
      analyze,
      canAnalyze: true,
      cooldownRemainingMs: 0,
      unavailableReason: null,
    });

    render(<WatchtowerPage scope={{ type: "personal" }} />);

    fireEvent.click(screen.getByText("select-entry-1"));

    const onSaved = personalDialogProps.mock.calls.at(-1)?.[0]?.onSaved as (() => void);
    act(() => {
      onSaved();
    });

    expect(analyze).not.toHaveBeenCalled();
    expect(toastMessageMock).toHaveBeenCalledWith("refreshAfterEdit");
  });

  it("does not rerun analysis when the personal edit dialog closes without saving", () => {
    const analyze = vi.fn();
    mockUseWatchtower.mockReturnValue({
      report: {
        totalPasswords: 1,
        overallScore: 80,
        breached: [
          {
            id: "entry-1",
            title: "GitHub",
            username: "user@example.com",
            scope: "personal",
            severity: "critical",
            details: "count:1",
          },
        ],
        weak: [],
        reused: [],
        old: [],
        unsecured: [],
        duplicate: [],
        expiring: [],
        analyzedAt: new Date("2026-03-03T00:00:00Z"),
      },
      loading: false,
      progress: { current: 0, total: 0, step: "" },
      analyze,
      canAnalyze: true,
      cooldownRemainingMs: 0,
      unavailableReason: null,
    });

    render(<WatchtowerPage scope={{ type: "personal" }} />);

    fireEvent.click(screen.getByText("select-entry-1"));

    const onOpenChange = personalDialogProps.mock.calls.at(-1)?.[0]?.onOpenChange as ((open: boolean) => void);
    act(() => {
      onOpenChange(false);
    });

    expect(analyze).not.toHaveBeenCalled();
  });

  describe("team scope", () => {
    const teamReport = {
      totalPasswords: 2,
      overallScore: 60,
      breached: [
        {
          id: "team-entry-1",
          title: "AWS Console",
          username: "admin@corp.com",
          scope: "team" as const,
          teamId: "team-abc",
          createdById: "user-2",
          severity: "critical" as const,
          details: "count:3",
        },
      ],
      weak: [
        {
          id: "team-entry-2",
          title: "Staging DB",
          username: "root",
          scope: "team" as const,
          teamId: "team-abc",
          createdById: "user-1",
          severity: "medium" as const,
          details: "entropy:25",
        },
      ],
      reused: [],
      old: [],
      unsecured: [],
      duplicate: [],
      expiring: [],
      analyzedAt: new Date("2026-03-03T00:00:00Z"),
    };

    it("renders with team scope and passes scope to useWatchtower", () => {
      mockUseWatchtower.mockReturnValue({
        report: teamReport,
        loading: false,
        progress: { current: 0, total: 0, step: "" },
        analyze: vi.fn(),
        canAnalyze: true,
        cooldownRemainingMs: 0,
        unavailableReason: null,
      });

      render(<WatchtowerPage scope={{ type: "team", teamId: "team-abc" }} />);

      expect(mockUseWatchtower).toHaveBeenCalledWith({
        type: "team",
        teamId: "team-abc",
      });
    });

    it("passes correct teamId to TeamEditDialogLoader when a team entry is selected", () => {
      mockUseWatchtower.mockReturnValue({
        report: teamReport,
        loading: false,
        progress: { current: 0, total: 0, step: "" },
        analyze: vi.fn(),
        canAnalyze: true,
        cooldownRemainingMs: 0,
        unavailableReason: null,
      });

      render(<WatchtowerPage scope={{ type: "team", teamId: "team-abc" }} teamRole="OWNER" />);

      fireEvent.click(screen.getByText("select-team-entry-1"));

      expect(teamDialogProps).toHaveBeenCalled();
      const lastCall = teamDialogProps.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(lastCall.teamId).toBe("team-abc");
      expect(lastCall.id).toBe("team-entry-1");
      expect(lastCall.open).toBe(true);
    });

    it("does not render personal edit dialog when a team entry is selected", () => {
      mockUseWatchtower.mockReturnValue({
        report: teamReport,
        loading: false,
        progress: { current: 0, total: 0, step: "" },
        analyze: vi.fn(),
        canAnalyze: true,
        cooldownRemainingMs: 0,
        unavailableReason: null,
      });

      render(<WatchtowerPage scope={{ type: "team", teamId: "team-abc" }} teamRole="OWNER" />);

      fireEvent.click(screen.getByText("select-team-entry-1"));

      expect(screen.getByTestId("team-edit-dialog")).toBeInTheDocument();
      expect(screen.queryByTestId("personal-edit-dialog")).not.toBeInTheDocument();
    });

    it("does not rerun analysis after saving from the team edit dialog", () => {
      const analyze = vi.fn();
      mockUseWatchtower.mockReturnValue({
        report: teamReport,
        loading: false,
        progress: { current: 0, total: 0, step: "" },
        analyze,
        canAnalyze: true,
        cooldownRemainingMs: 0,
        unavailableReason: null,
      });

      render(<WatchtowerPage scope={{ type: "team", teamId: "team-abc" }} teamRole="OWNER" />);

      fireEvent.click(screen.getByText("select-team-entry-1"));

      const onSaved = teamDialogProps.mock.calls.at(-1)?.[0]?.onSaved as (() => void);
      act(() => {
        onSaved();
      });

      expect(analyze).not.toHaveBeenCalled();
      expect(toastMessageMock).toHaveBeenCalledWith("refreshAfterEdit");
    });

    it("does not rerun analysis when the team edit dialog closes without saving", () => {
      const analyze = vi.fn();
      mockUseWatchtower.mockReturnValue({
        report: teamReport,
        loading: false,
        progress: { current: 0, total: 0, step: "" },
        analyze,
        canAnalyze: true,
        cooldownRemainingMs: 0,
        unavailableReason: null,
      });

      render(<WatchtowerPage scope={{ type: "team", teamId: "team-abc" }} teamRole="OWNER" />);

      fireEvent.click(screen.getByText("select-team-entry-1"));

      const onOpenChange = teamDialogProps.mock.calls.at(-1)?.[0]?.onOpenChange as ((open: boolean) => void);
      act(() => {
        onOpenChange(false);
      });

      expect(analyze).not.toHaveBeenCalled();
    });
    // #1014: the routes let a MEMBER write only entries they created
    // (ONLY_OWN_ENTRIES); team-entry-1 is user-2's, team-entry-2 is user-1's.
    it.each([
      ["OWNER", "team-entry-1", true],
      ["ADMIN", "team-entry-1", true],
      ["MEMBER", "team-entry-2", true],
      ["MEMBER", "team-entry-1", false],
    ] as const)("%s selecting %s opens the team edit dialog: %s", (role, entryId, opens) => {
      mockUseWatchtower.mockReturnValue({
        report: teamReport,
        loading: false,
        progress: { current: 0, total: 0, step: "" },
        analyze: vi.fn(),
        canAnalyze: true,
        cooldownRemainingMs: 0,
        unavailableReason: null,
      });

      render(<WatchtowerPage scope={{ type: "team", teamId: "team-abc" }} teamRole={role} />);
      const button = screen.getByText(`select-${entryId}`);
      expect(button).toHaveProperty("disabled", !opens);
      fireEvent.click(button);

      expect(screen.queryByTestId("team-edit-dialog") !== null).toBe(opens);
    });

    it.each([
      ["no team role", undefined, "user-1", "user-1"],
      ["no session user", "OWNER", null, "user-1"],
      ["an entry with no recorded creator", "OWNER", "user-1", null],
    ] as const)("does not open a team entry with %s", (_label, role, userId, createdById) => {
      vaultUser.id = userId;
      mockUseWatchtower.mockReturnValue({
        report: { ...teamReport, breached: [{ ...teamReport.breached[0], createdById }] },
        loading: false,
        progress: { current: 0, total: 0, step: "" },
        analyze: vi.fn(),
        canAnalyze: true,
        cooldownRemainingMs: 0,
        unavailableReason: null,
      });

      render(<WatchtowerPage scope={{ type: "team", teamId: "team-abc" }} teamRole={role} />);
      fireEvent.click(screen.getByText("select-team-entry-1"));

      expect(screen.queryByTestId("team-edit-dialog")).toBeNull();
    });
  });
});
