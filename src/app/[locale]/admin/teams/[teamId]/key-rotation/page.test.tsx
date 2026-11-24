// @vitest-environment jsdom
/**
 * The key-rotation page couples the rotate button to the re-key finish
 * control: a committed rotation remounts the control with autoStart, and a
 * running pass disables the rotate button.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { Suspense, type ReactNode } from "react";
import { act, render } from "@testing-library/react";
import { KeyRound } from "lucide-react";

interface RotateProps {
  teamId: string;
  disabled?: boolean;
  onSuccess?: () => void;
}
interface FinishProps {
  teamId: string;
  autoStart?: boolean;
  onRunningChange?: (running: boolean) => void;
}

const { mockRotateButton, mockFinishControl, mockFinishMount, mockCardHeader } = vi.hoisted(() => ({
  mockRotateButton: vi.fn((_props: RotateProps): ReactNode => null),
  mockFinishControl: vi.fn((_props: FinishProps): ReactNode => null),
  mockFinishMount: vi.fn(),
  mockCardHeader: vi.fn((_props: Record<string, unknown>): ReactNode => null),
}));

vi.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));
vi.mock("@/components/team/security/team-rotate-key-button", () => ({
  TeamRotateKeyButton: mockRotateButton,
}));
vi.mock("@/components/team/security/team-rekey-finish-control", async () => {
  const { useEffect } = await vi.importActual<typeof import("react")>("react");
  return {
    TeamRekeyFinishControl: (props: FinishProps) => {
      useEffect(() => {
        mockFinishMount();
      }, []);
      return mockFinishControl(props);
    },
  };
});
vi.mock("@/components/settings/account/section-card-header", () => ({
  SectionCardHeader: mockCardHeader,
}));

import TeamKeyRotationPage from "@/app/[locale]/admin/teams/[teamId]/key-rotation/page";

function lastRotateProps(): RotateProps {
  const props = mockRotateButton.mock.lastCall?.[0];
  if (!props) throw new Error("TeamRotateKeyButton was not rendered");
  return props;
}

function lastFinishProps(): FinishProps {
  const props = mockFinishControl.mock.lastCall?.[0];
  if (!props) throw new Error("TeamRekeyFinishControl was not rendered");
  return props;
}

async function renderPage() {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <TeamKeyRotationPage params={Promise.resolve({ teamId: "team-5" })} />
      </Suspense>,
    );
  });
}

describe("TeamKeyRotationPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the rotation card header with the Team rotate-key copy", async () => {
    await renderPage();

    expect(mockCardHeader.mock.lastCall?.[0]).toEqual({
      icon: KeyRound,
      title: "Team.rotateKeyTitle",
      description: "Team.rotateKeyDesc",
    });
  });

  it("starts with an enabled rotate button and an idle finish control for the route's team", async () => {
    await renderPage();

    expect(lastRotateProps()).toMatchObject({ teamId: "team-5", disabled: false });
    expect(lastFinishProps()).toMatchObject({ teamId: "team-5", autoStart: false });
    expect(mockFinishMount).toHaveBeenCalledTimes(1);
  });

  it("remounts the finish control with autoStart after a committed rotation", async () => {
    await renderPage();

    await act(async () => {
      lastRotateProps().onSuccess?.();
    });

    expect(lastFinishProps().autoStart).toBe(true);
    expect(mockFinishMount).toHaveBeenCalledTimes(2);
  });

  it("disables the rotate button while a re-key pass runs and re-enables it after", async () => {
    await renderPage();

    await act(async () => {
      lastFinishProps().onRunningChange?.(true);
    });
    expect(lastRotateProps().disabled).toBe(true);

    await act(async () => {
      lastFinishProps().onRunningChange?.(false);
    });
    expect(lastRotateProps().disabled).toBe(false);
  });
});
