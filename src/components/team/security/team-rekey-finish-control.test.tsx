// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { RekeyPassResult, RekeyRunnerDeps } from "@/lib/team/rekey-runner";

const { mockFetch, mockRunRekeyPass, mockResolveTeamKey, mockInvalidateTeamKey, mockCanUsePasskeyRecovery } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockRunRekeyPass: vi.fn(),
  mockResolveTeamKey: vi.fn(),
  mockInvalidateTeamKey: vi.fn(),
  mockCanUsePasskeyRecovery: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, opts?: Record<string, unknown>) =>
    opts ? `${key}:${JSON.stringify(opts)}` : key,
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@/lib/team/team-vault-core", () => ({
  useTeamVault: () => ({ resolveTeamKey: mockResolveTeamKey, invalidateTeamKey: mockInvalidateTeamKey }),
}));

// The runner is unit-tested on its own (rekey-runner.test.ts); here it is a
// stand-in returning a chosen result.
vi.mock("@/lib/team/rekey-runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/team/rekey-runner")>()),
  runRekeyPass: (deps: RekeyRunnerDeps) => mockRunRekeyPass(deps),
}));

import "@/__tests__/helpers/passkey-reauth-mocks";

vi.mock("@/lib/auth/webauthn/can-use-passkey-recovery", () => ({
  canUsePasskeyRecovery: mockCanUsePasskeyRecovery,
}));

vi.mock("@/lib/auth/webauthn/passkey-reauth-client", () => ({
  reauthenticateWithPasskey: vi.fn(async () => ({ ok: true })),
}));

import { TeamRekeyFinishControl } from "./team-rekey-finish-control";

const LIST = {
  pendingCount: 7,
  stateCounts: { ready: 3, needs_rekeyer_holder: 2, holder_cannot_rekey: 1, unrecoverable: 1 },
  holders: { "2": [{ id: "u-y", name: "Yamada", email: "y@example.com" }] },
  retainedHistoryCount: 4,
  entryIds: ["e1"],
  versionHolders: {},
};

function listResponse(list: unknown = LIST, status = 200) {
  return new Response(JSON.stringify(list), { status });
}

function passResult(overrides: Partial<RekeyPassResult> = {}): RekeyPassResult {
  return {
    status: "completed",
    rekeyed: ["e1", "e2"],
    undecryptable: [],
    keyInvalid: [],
    notHeld: [],
    skipped: [],
    retained: [],
    attemptedByVersion: new Map(),
    ...overrides,
  };
}

describe("TeamRekeyFinishControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
  });

  it("shows the pending count, state counts, holders, retained history and the Finish re-key (N) button", async () => {
    mockFetch.mockImplementation(async () => listResponse());
    render(<TeamRekeyFinishControl teamId="team-1" />);

    expect(await screen.findByRole("button", { name: 'rekeyFinishButton:{"count":7}' })).toBeEnabled();
    expect(screen.getByText('rekeyPendingCount:{"count":7}')).toBeInTheDocument();
    expect(screen.getByText('rekeyStateReady:{"count":3}')).toBeInTheDocument();
    expect(screen.getByText('rekeyOlderKeyHolders:{"holders":"Yamada"}')).toBeInTheDocument();
    expect(screen.getByText('rekeyStateHolderCannotRekey:{"count":1}')).toBeInTheDocument();
    expect(screen.getByText('rekeyStateUnrecoverable:{"count":1}')).toBeInTheDocument();
    expect(screen.getByText('rekeyRetainedHistory:{"count":4}')).toBeInTheDocument();
  });

  it("is not offered to a caller the list refuses (403)", async () => {
    mockFetch.mockImplementation(async () => listResponse({ error: "FORBIDDEN" }, 403));
    const { container } = render(<TeamRekeyFinishControl teamId="team-1" />);

    await act(async () => {});

    expect(container).toBeEmptyDOMElement();
  });

  it("disables the button when nothing is pending", async () => {
    mockFetch.mockImplementation(async () => listResponse({ ...LIST, pendingCount: 0, entryIds: [] }));
    render(<TeamRekeyFinishControl teamId="team-1" />);

    expect(await screen.findByRole("button", { name: 'rekeyFinishButton:{"count":0}' })).toBeDisabled();
    expect(screen.getByText("rekeyNothingPending")).toBeInTheDocument();
  });

  it("drives the pass for the team and shows the final report: key_invalid names holder Y without delete, unrecoverable with a deactivated-holder delete warning", async () => {
    mockFetch.mockImplementation(async () => listResponse());
    mockRunRekeyPass.mockResolvedValue(passResult({
      keyInvalid: [{ entryId: "k1", teamKeyVersion: 1 }],
      list: {
        ...LIST,
        pendingCount: 2,
        stateCounts: { ready: 0, needs_rekeyer_holder: 0, holder_cannot_rekey: 0, unrecoverable: 1 },
        versionHolders: {
          1: { callerHolds: true, activeHolderCount: 2, holders: [{ id: "y", name: "Yamada", email: null, canRekey: true }], deactivatedHolderCount: 0 },
          3: { callerHolds: false, activeHolderCount: 0, holders: [], deactivatedHolderCount: 1 },
        },
      },
    }));
    render(<TeamRekeyFinishControl teamId="team-1" />);

    const button = await screen.findByRole("button", { name: 'rekeyFinishButton:{"count":7}' });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(mockRunRekeyPass).toHaveBeenCalledWith(expect.objectContaining({ teamId: "team-1" }));
    expect(screen.getByText('rekeyCompleted:{"count":2}')).toBeInTheDocument();
    const report = screen.getByRole("region", { name: "rekeyReportTitle" });
    const items = Array.from(report.querySelectorAll(":scope > ul > li"));
    const keyInvalid = items.find((li) => li.textContent?.includes("rekeyIssueKeyInvalid"));
    const unrecoverable = items.find((li) => li.textContent?.includes("rekeyIssueUnrecoverable"));
    // No raw team key version in the issue or the holder list (only the key suspicion names one).
    expect(keyInvalid).toHaveTextContent('rekeyIssueKeyInvalid:{"count":1}');
    expect(keyInvalid).toHaveTextContent('rekeyExitAnotherHolderNamed:{"holders":"Yamada"}');
    expect(keyInvalid).not.toHaveTextContent("rekeyExitDelete");
    expect(unrecoverable).toHaveTextContent("rekeyExitDelete");
    expect(unrecoverable).toHaveTextContent("rekeyExitDeleteDeactivatedHolder");
  });

  it("shows no delete warning when no deactivated member holds the unrecoverable version (control)", async () => {
    mockFetch.mockImplementation(async () => listResponse());
    mockRunRekeyPass.mockResolvedValue(passResult({
      list: {
        ...LIST,
        pendingCount: 1,
        stateCounts: { ready: 0, needs_rekeyer_holder: 0, holder_cannot_rekey: 0, unrecoverable: 1 },
        versionHolders: { 3: { callerHolds: false, activeHolderCount: 0, holders: [], deactivatedHolderCount: 0 } },
      },
    }));
    render(<TeamRekeyFinishControl teamId="team-1" />);
    const button = await screen.findByRole("button", { name: 'rekeyFinishButton:{"count":7}' });
    await act(async () => {
      fireEvent.click(button);
    });

    const report = screen.getByRole("region", { name: "rekeyReportTitle" });
    expect(report).toHaveTextContent("rekeyExitDelete");
    expect(report).not.toHaveTextContent("rekeyExitDeleteDeactivatedHolder");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports a refused stop with the server's code message", async () => {
    mockFetch.mockImplementation(async () => listResponse());
    mockRunRekeyPass.mockResolvedValue(passResult({
      status: "stopped",
      rekeyed: [],
      stop: { reason: "refused", code: "ACTOR_NOT_PERMITTED", entryId: "e1" },
    }));
    render(<TeamRekeyFinishControl teamId="team-1" />);

    const button = await screen.findByRole("button", { name: 'rekeyFinishButton:{"count":7}' });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(screen.getByText('rekeyStopped:{"count":0}')).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "rekeyReportTitle" })).toHaveTextContent("actorNotPermitted");
  });

  it("starts the pass on mount after a rotation (autoStart)", async () => {
    mockFetch.mockImplementation(async () => listResponse());
    mockRunRekeyPass.mockResolvedValue(passResult());
    render(<TeamRekeyFinishControl teamId="team-1" autoStart />);

    expect(await screen.findByText('rekeyCompleted:{"count":2}')).toBeInTheDocument();
    expect(mockRunRekeyPass).toHaveBeenCalledTimes(1);
  });

  it("opens re-authentication when the pass needs step-up", async () => {
    mockFetch.mockImplementation(async () => listResponse());
    mockRunRekeyPass.mockImplementation(async (deps: RekeyRunnerDeps) => {
      void deps.reauthenticate();
      return new Promise(() => {});
    });
    render(<TeamRekeyFinishControl teamId="team-1" />);

    const button = await screen.findByRole("button", { name: 'rekeyFinishButton:{"count":7}' });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(await screen.findByTestId("recent-session-dialog")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("rekeyRunning");
  });
});
