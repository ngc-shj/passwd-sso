// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  useTranslations: () => (key: string) => key,
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
    teamMembersSearch: (id: string) => `/api/teams/${id}/members/search`,
    teamMembers: (id: string) => `/api/teams/${id}/members`,
  },
}));

vi.mock("@/components/member-info", () => ({
  MemberInfo: ({ name, email }: { name: string | null; email: string | null }) => (
    <div data-testid="member-info">{name ?? email}</div>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled }: React.ComponentProps<"button">) => (
    <button onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
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

import { TeamAddFromTenantSection } from "../team-add-from-tenant-section";

describe("TeamAddFromTenantSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces search: does not call fetchApi before 300ms", () => {
    mockFetchApi.mockResolvedValue({ json: async () => [], signal: { aborted: false } });

    render(<TeamAddFromTenantSection teamId="team-1" onSuccess={vi.fn()} />);

    const input = screen.getByPlaceholderText("searchTenantMembers");
    fireEvent.change(input, { target: { value: "alice" } });

    // Advance only 200ms — debounce has not fired yet
    vi.advanceTimersByTime(200);

    expect(mockFetchApi).not.toHaveBeenCalled();
  });

  it("calls fetchApi POST on Add button click with correct userId and role", async () => {
    // Return search results on first call, success on second (POST)
    mockFetchApi
      .mockResolvedValueOnce({
        json: async () => [{ userId: "user-1", name: "Alice", email: "alice@example.com", image: null }],
        signal: { aborted: false },
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });

    const onSuccess = vi.fn();
    render(<TeamAddFromTenantSection teamId="team-1" onSuccess={onSuccess} />);

    const input = screen.getByPlaceholderText("searchTenantMembers");
    fireEvent.change(input, { target: { value: "alice" } });

    // Fire the debounce timer
    await act(async () => {
      vi.advanceTimersByTime(350);
      await Promise.resolve();
    });

    // Wait for fetchApi to be called for search
    await waitFor(() => {
      expect(mockFetchApi).toHaveBeenCalledWith(
        expect.stringContaining("/members/search"),
        expect.objectContaining({ signal: expect.any(Object) }),
      );
    });

    // Resolve the search promise and wait for render update
    await act(async () => {
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("member-info")).toBeInTheDocument();
    });

    const addBtn = screen.getByText("addButton");
    await act(async () => {
      fireEvent.click(addBtn);
      await Promise.resolve();
    });

    await waitFor(() => {
      const postCall = mockFetchApi.mock.calls.find(
        (c: unknown[]) => (c[1] as Record<string, unknown>)?.method === "POST",
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse((postCall![1] as Record<string, unknown>).body as string);
      expect(body.userId).toBe("user-1");
      expect(body.role).toBe("MEMBER");
    });
  });
});
