// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { DISPLAY_INITIALS_LENGTH } from "@/lib/validations/common";

const { mockUseSession } = vi.hoisted(() => ({
  mockUseSession: vi.fn(),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => mockUseSession(),
}));

import { UserAvatar } from "./user-avatar";

describe("UserAvatar", () => {
  it("renders a placeholder when no session user is present", () => {
    mockUseSession.mockReturnValueOnce({ data: null });
    const { container } = render(<UserAvatar />);
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("derives initials from name (first character of each whitespace-split token)", () => {
    mockUseSession.mockReturnValueOnce({
      data: { user: { name: "Alice Bob", email: "ab@example.com", image: null } },
    });
    render(<UserAvatar />);
    // initials capped to DISPLAY_INITIALS_LENGTH; should be uppercase
    expect(screen.getByText("AB".slice(0, DISPLAY_INITIALS_LENGTH))).toBeInTheDocument();
  });

  it("falls back to email when name is missing (split on whitespace and @)", () => {
    mockUseSession.mockReturnValueOnce({
      data: { user: { name: null, email: "carol@example.com", image: null } },
    });
    render(<UserAvatar />);
    // "carol@example.com" splits on /[\s@]/ → ["carol", "example.com"]
    // initials: "C" + "E" → "CE", capped at DISPLAY_INITIALS_LENGTH (2).
    expect(screen.getByText("CE".slice(0, DISPLAY_INITIALS_LENGTH))).toBeInTheDocument();
  });

  it("renders the user.image with referrerPolicy='no-referrer'", () => {
    mockUseSession.mockReturnValueOnce({
      data: { user: { name: "Eve", email: "e@e.com", image: "https://cdn/example.png" } },
    });
    const { container } = render(<UserAvatar />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("https://cdn/example.png");
    expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("renders fallback '?' when name and email are both missing", () => {
    mockUseSession.mockReturnValueOnce({
      data: { user: { name: null, email: null, image: null } },
    });
    render(<UserAvatar />);
    expect(screen.getByText("?")).toBeInTheDocument();
  });
});
