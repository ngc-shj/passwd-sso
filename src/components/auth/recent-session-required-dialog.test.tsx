// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockSignOut } = vi.hoisted(() => ({ mockSignOut: vi.fn() }));

vi.mock("next-auth/react", () => ({ signOut: mockSignOut }));
vi.mock("next-intl", () => ({ useLocale: () => "ja" }));

import { RecentSessionRequiredDialog } from "./recent-session-required-dialog";
import { withBasePath } from "@/lib/url-helpers";

function renderDialog(open = true) {
  const onOpenChange = vi.fn();
  render(
    <RecentSessionRequiredDialog
      actionLabel="Sign in again"
      cancelLabel="Cancel"
      description="Your session is too old"
      onOpenChange={onOpenChange}
      open={open}
      title="Recent sign-in required"
    />,
  );
  return { onOpenChange };
}

describe("RecentSessionRequiredDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.pushState({}, "", "/ja/dashboard/settings?tab=keys");
  });

  afterEach(() => {
    window.history.pushState({}, "", "/");
  });

  it("renders the given title and description when open", () => {
    renderDialog();
    expect(screen.getByText("Recent sign-in required")).toBeInTheDocument();
    expect(screen.getByText("Your session is too old")).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    renderDialog(false);
    expect(screen.queryByText("Recent sign-in required")).not.toBeInTheDocument();
  });

  it("signs out with a callback to the locale sign-in page that returns to the current path and query", async () => {
    mockSignOut.mockResolvedValue(undefined);
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));

    await waitFor(() => expect(mockSignOut).toHaveBeenCalledTimes(1));
    const expected = `${withBasePath("/ja/auth/signin")}?callbackUrl=${encodeURIComponent(
      "/ja/dashboard/settings?tab=keys",
    )}`;
    expect(mockSignOut).toHaveBeenCalledWith({ callbackUrl: expected });
  });

  it("disables both buttons while the sign-out redirect is in flight", async () => {
    mockSignOut.mockReturnValue(new Promise(() => {}));
    renderDialog();

    const action = screen.getByRole("button", { name: "Sign in again" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(action).toBeEnabled();
    expect(cancel).toBeEnabled();

    fireEvent.click(action);

    await waitFor(() => expect(action).toBeDisabled());
    expect(cancel).toBeDisabled();
  });

  it("reports a close request through onOpenChange when cancelled", () => {
    const { onOpenChange } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
