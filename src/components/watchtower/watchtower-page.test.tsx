// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { WatchtowerPage } from "./watchtower-page";

const {
  mockUseWatchtower,
  personalDialogProps,
  teamDialogProps,
} = vi.hoisted(() => ({
  mockUseWatchtower: vi.fn(),
  personalDialogProps: vi.fn(),
  teamDialogProps: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  useLocale: () => "en",
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/hooks/use-watchtower", () => ({
  OLD_THRESHOLD_DAYS: 90,
  EXPIRING_THRESHOLD_DAYS: 30,
  useWatchtower: (...args: unknown[]) => mockUseWatchtower(...args),
}));

vi.mock("@/components/passwords/personal-password-edit-dialog-loader", () => ({
  PasswordEditDialogLoader: (props: unknown) => {
    personalDialogProps(props);
    return <div data-testid="personal-edit-dialog" />;
  },
}));

vi.mock("@/components/team/team-edit-dialog-loader", () => ({
  TeamEditDialogLoader: (props: unknown) => {
    teamDialogProps(props);
    return <div data-testid="team-edit-dialog" />;
  },
}));

vi.mock("@/components/watchtower/issue-section", () => ({
  IssueSection: ({ issues, onSelectEntry }: { issues: Array<Record<string, unknown>>; onSelectEntry?: (entry: unknown) => void }) => (
    <div>
      {issues.map((issue) => (
        <button key={String(issue.id)} onClick={() => onSelectEntry?.(issue)}>
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

  it("reruns analysis immediately after saving from the personal edit dialog", () => {
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

    expect(analyze).toHaveBeenCalledWith({
      bypassCooldown: true,
      skipRateLimit: true,
    });
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
});
