// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render } from "@testing-library/react";

import { Favicon } from "./favicon";

// ── Hoisted mocks ──────────────────────────────────────────
const { mockUseSession } = vi.hoisted(() => ({
  mockUseSession: vi.fn(),
}));

vi.mock("next-auth/react", () => ({
  useSession: mockUseSession,
}));

// ── Helpers ────────────────────────────────────────────────
const sessionOff = {
  data: { user: { id: "u1", fetchFavicons: false }, expires: "2099-01-01" },
  status: "authenticated" as const,
  update: vi.fn(),
};

const sessionOn = {
  data: { user: { id: "u1", fetchFavicons: true }, expires: "2099-01-01" },
  status: "authenticated" as const,
  update: vi.fn(),
};

const sessionLoading = {
  data: null,
  status: "loading" as const,
  update: vi.fn(),
};

describe("Favicon", () => {
  beforeEach(() => {
    mockUseSession.mockReturnValue(sessionOff);
  });

  // ── Three render states ─────────────────────────────────

  it("loading state: renders neutral placeholder — no img and no globe svg", () => {
    mockUseSession.mockReturnValue(sessionLoading);
    const { container } = render(<Favicon host="example.com" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("resolved OFF: renders globe svg and no img when fetchFavicons is false", () => {
    mockUseSession.mockReturnValue(sessionOff);
    const { container } = render(<Favicon host="example.com" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("resolved ON: renders img pointing at the same-origin proxy", () => {
    mockUseSession.mockReturnValue(sessionOn);
    const { container } = render(<Favicon host="example.com" size={16} />);
    const img = container.querySelector("img");
    expect(img).toBeInTheDocument();
    const src = img?.getAttribute("src") ?? "";
    expect(src.startsWith("/api/user/favicon?")).toBe(true);
    expect(img?.getAttribute("referrerPolicy")).toBe("no-referrer");
  });

  // ── Bucket-snapping (F6/F7) ─────────────────────────────

  it("size=28 → proxy size=64 (not 56)", () => {
    mockUseSession.mockReturnValue(sessionOn);
    const { container } = render(<Favicon host="x.com" size={28} />);
    const src = container.querySelector("img")?.getAttribute("src") ?? "";
    expect(src).toContain("size=64");
    expect(src).not.toContain("size=56");
  });

  it("size=12 → proxy size=32 (not 24)", () => {
    mockUseSession.mockReturnValue(sessionOn);
    const { container } = render(<Favicon host="x.com" size={12} />);
    const src = container.querySelector("img")?.getAttribute("src") ?? "";
    expect(src).toContain("size=32");
    expect(src).not.toContain("size=24");
  });

  // ── RT7-a: no third-party URL (restriction test) ────────

  it("proxy src is same-origin — never an absolute third-party URL", () => {
    mockUseSession.mockReturnValue(sessionOn);
    const { container } = render(<Favicon host="example.com" size={16} />);
    const src = container.querySelector("img")?.getAttribute("src") ?? "";
    expect(src).not.toMatch(/^https?:\/\//);
    expect(src).not.toContain("google");
    expect(src.startsWith("/api/user/favicon")).toBe(true);
  });

  // ── onError → Globe fallback ─────────────────────────────

  it("falls back to globe svg when img onError fires (resolved ON)", () => {
    mockUseSession.mockReturnValue(sessionOn);
    const { container } = render(<Favicon host="bad.example" />);
    const img = container.querySelector("img");
    expect(img).toBeInTheDocument();

    fireEvent.error(img as HTMLImageElement);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  // ── Null host with ON preference ─────────────────────────

  it("renders globe when host is null even with fetchFavicons ON", () => {
    mockUseSession.mockReturnValue(sessionOn);
    const { container } = render(<Favicon host={null} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});
