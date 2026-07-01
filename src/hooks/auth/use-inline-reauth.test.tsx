// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockCanUsePasskeyRecovery, mockReauthenticateWithPasskey } = vi.hoisted(() => ({
  mockCanUsePasskeyRecovery: vi.fn(),
  mockReauthenticateWithPasskey: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/auth/webauthn/can-use-passkey-recovery", () => ({
  canUsePasskeyRecovery: mockCanUsePasskeyRecovery,
}));

vi.mock("@/lib/auth/webauthn/passkey-reauth-client", () => ({
  reauthenticateWithPasskey: mockReauthenticateWithPasskey,
}));

import { useInlineReauth } from "./use-inline-reauth";

// Minimal harness: a button per scenario that calls triggerOnStaleError with a
// retry arg, plus the passkey dialog's onAction (the reauth confirm) wired to a
// button so the test can drive the WebAuthn success path.
function Harness({ onSuccess }: { onSuccess: (arg: string) => Promise<void> }) {
  const reauth = useInlineReauth<string>(onSuccess);
  return (
    <div>
      <button onClick={() => void reauth.triggerOnStaleError("target-A")}>trigger-A</button>
      <button onClick={() => void reauth.triggerOnStaleError("target-B")}>trigger-B</button>
      <button onClick={() => void reauth.reauthDialogProps.onAction()}>confirm</button>
      <button onClick={() => reauth.reauthDialogProps.onOpenChange(false)}>dismiss</button>
      <span data-testid="reauth-open">{String(reauth.reauthDialogProps.open)}</span>
    </div>
  );
}

describe("useInlineReauth retry argument", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Passkey path so onAction drives the reauth ceremony.
    mockCanUsePasskeyRecovery.mockResolvedValue(true);
    mockReauthenticateWithPasskey.mockResolvedValue({ ok: true });
  });

  it("replays onSuccess with the exact arg passed to triggerOnStaleError", async () => {
    const onSuccess = vi.fn(async () => {});
    render(<Harness onSuccess={onSuccess} />);

    fireEvent.click(screen.getByText("trigger-A"));
    await waitFor(() => {
      expect(screen.getByTestId("reauth-open")).toHaveTextContent("true");
    });

    fireEvent.click(screen.getByText("confirm"));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith("target-A");
    });
  });

  it("uses the latest arg when triggerOnStaleError is re-invoked before confirm", async () => {
    const onSuccess = vi.fn(async () => {});
    render(<Harness onSuccess={onSuccess} />);

    fireEvent.click(screen.getByText("trigger-A"));
    fireEvent.click(screen.getByText("trigger-B"));
    await waitFor(() => {
      expect(screen.getByTestId("reauth-open")).toHaveTextContent("true");
    });

    fireEvent.click(screen.getByText("confirm"));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith("target-B");
    });
  });

  it("clears the retry arg on dialog dismissal (no stale replay)", async () => {
    const onSuccess = vi.fn(async () => {});
    render(<Harness onSuccess={onSuccess} />);

    fireEvent.click(screen.getByText("trigger-A"));
    await waitFor(() => {
      expect(screen.getByTestId("reauth-open")).toHaveTextContent("true");
    });

    // Dismiss, then a fresh confirm must not replay the cleared target.
    fireEvent.click(screen.getByText("dismiss"));
    fireEvent.click(screen.getByText("confirm"));

    await waitFor(() => {
      expect(mockReauthenticateWithPasskey).toHaveBeenCalled();
    });
    // onSuccess fires with the cleared arg (undefined), never the stale "target-A".
    expect(onSuccess).not.toHaveBeenCalledWith("target-A");
  });
});
