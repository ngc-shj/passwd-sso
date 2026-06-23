// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockFetch, mockToast, mockUseSession, mockUpdate } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
  mockUseSession: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("next-auth/react", () => ({ useSession: mockUseSession }));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

import ProfilePage from "./page";

function sessionState(
  status: "loading" | "authenticated",
  fetchFavicons?: boolean,
) {
  return {
    status,
    update: mockUpdate,
    data:
      status === "authenticated"
        ? { user: { id: "user-1", fetchFavicons } }
        : undefined,
  };
}

describe("ProfilePage — site-icons toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
  });

  it("reflects the persisted ON preference once the session resolves after first paint (F1 regression)", async () => {
    // First paint: session is still loading (SessionProvider has no server-seeded
    // session), so the toggle must NOT lock to the pre-resolution default.
    mockUseSession.mockReturnValue(sessionState("loading"));
    const { rerender } = render(<ProfilePage />);
    const toggle = () => screen.getByRole("switch");
    expect(toggle()).not.toBeChecked();

    // Session resolves to an opted-IN user → the toggle must re-sync to ON.
    mockUseSession.mockReturnValue(sessionState("authenticated", true));
    rerender(<ProfilePage />);
    await waitFor(() => expect(toggle()).toBeChecked());
  });

  it("stays OFF for an opted-out user", async () => {
    mockUseSession.mockReturnValue(sessionState("authenticated", false));
    render(<ProfilePage />);
    await waitFor(() => expect(screen.getByRole("switch")).not.toBeChecked());
  });

  it("optimistically flips ON and PUTs the new value, then refreshes the session", async () => {
    mockUseSession.mockReturnValue(sessionState("authenticated", false));
    render(<ProfilePage />);
    const toggle = screen.getByRole("switch");

    fireEvent.click(toggle);
    expect(toggle).toBeChecked(); // optimistic, before the PUT resolves

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/user/favicon-pref"),
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ fetchFavicons: true }),
        }),
      ),
    );
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
  });

  it("rolls back the optimistic state when the PUT fails", async () => {
    mockUseSession.mockReturnValue(sessionState("authenticated", false));
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
    render(<ProfilePage />);
    const toggle = screen.getByRole("switch");

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked()); // reverted
    expect(mockToast.error).toHaveBeenCalled();
  });
});
