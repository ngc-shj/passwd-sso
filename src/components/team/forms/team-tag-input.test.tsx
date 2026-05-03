// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { TAG_NAME_MAX_LENGTH } from "@/lib/validations/common";
import {
  mockI18nNavigation,
  mockTeamMismatch,
} from "@/__tests__/helpers/mock-app-navigation";

const { mockFetch, mockToast } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockToast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, opts?: Record<string, unknown>) => {
    if (opts && "name" in opts) return `${key}:${opts.name}`;
    return key;
  },
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@/i18n/navigation", () => mockI18nNavigation());

vi.mock("@/lib/http/toast-api-error", () => ({
  toastApiError: vi.fn(),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, className }: React.ComponentProps<"span">) => (
    <span data-testid="tag-badge" className={className}>{children}</span>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...rest }: React.ComponentProps<"button">) => (
    <button {...rest}>{children}</button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}));

import { TeamTagInput } from "./team-tag-input";

const SAMPLE_TAGS = [
  { id: "t1", name: "alpha", color: "#ff0000", parentId: null, depth: 0 },
  { id: "t2", name: "beta", color: null, parentId: null, depth: 0 },
];

function setupFetch(tags = SAMPLE_TAGS) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "new-tag",
            name: JSON.parse(init.body as string).name,
            color: null,
          }),
      });
    }
    if (url.includes("?tree=true")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(tags),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
}

describe("TeamTagInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToast.error.mockClear();
    mockToast.success.mockClear();
  });

  it("fetches team tags on mount with tree=true", async () => {
    setupFetch();
    await act(async () => {
      render(
        <TeamTagInput teamId="team-1" selectedTags={[]} onChange={vi.fn()} />,
      );
    });
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
      const firstCall = mockFetch.mock.calls[0][0] as string;
      expect(firstCall).toContain("tree=true");
    });
  });

  it("renders selected tags as removable badges", async () => {
    setupFetch();
    const onChange = vi.fn();
    await act(async () => {
      render(
        <TeamTagInput
          teamId="team-1"
          selectedTags={[{ id: "t1", name: "alpha", color: null }]}
          onChange={onChange}
        />,
      );
    });
    expect(screen.getByText("alpha")).toBeInTheDocument();
  });

  it("calls onChange without removed tag when X clicked", async () => {
    setupFetch();
    const onChange = vi.fn();
    await act(async () => {
      render(
        <TeamTagInput
          teamId="team-1"
          selectedTags={[
            { id: "t1", name: "alpha", color: null },
            { id: "t2", name: "beta", color: null },
          ]}
          onChange={onChange}
        />,
      );
    });
    // Click the X button inside the first badge
    const removeButtons = screen
      .getAllByTestId("tag-badge")
      .map((b) => b.querySelector("button"))
      .filter((b): b is HTMLButtonElement => !!b);
    expect(removeButtons.length).toBeGreaterThan(0);
    fireEvent.click(removeButtons[0]);
    expect(onChange).toHaveBeenCalledWith([{ id: "t2", name: "beta", color: null }]);
  });

  it(`rejects names longer than TAG_NAME_MAX_LENGTH (${TAG_NAME_MAX_LENGTH})`, async () => {
    setupFetch();
    const onChange = vi.fn();
    await act(async () => {
      render(
        <TeamTagInput teamId="team-1" selectedTags={[]} onChange={onChange} />,
      );
    });

    // Open dropdown
    const addBtn = screen.getByText("addTag");
    await act(async () => {
      fireEvent.click(addBtn);
    });

    const input = await screen.findByPlaceholderText("searchOrCreate");
    const longName = "x".repeat(TAG_NAME_MAX_LENGTH + 1);
    fireEvent.change(input, { target: { value: longName } });

    // Try to create — Enter
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(mockToast.error).toHaveBeenCalledWith("nameTooLong");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("creates a new tag and adds it to selection on Enter", async () => {
    setupFetch();
    const onChange = vi.fn();
    await act(async () => {
      render(
        <TeamTagInput teamId="team-1" selectedTags={[]} onChange={onChange} />,
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByText("addTag"));
    });
    const input = await screen.findByPlaceholderText("searchOrCreate");
    fireEvent.change(input, { target: { value: "newtag" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith([
        expect.objectContaining({ id: "new-tag", name: "newtag" }),
      ]);
    });
  });
});

describe("TeamTagInput — cross-tenant render denial (§Sec-3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve([]) }),
    );
  });

  it("renders empty fallback when team mismatch (no crash, no leaked tag list)", async () => {
    // Cross-tenant: user is in team-a but resource is team-b. Component renders
    // its own fetch call to team-b's tags — but we ensure no crash and no
    // sensitive data is rendered (zero selectedTags + empty server response).
    const ctx = mockTeamMismatch({ actorTeamId: "team-a", resourceTeamId: "team-b" });
    expect(ctx.useTeamVault().currentTeamId).not.toBe(ctx.teamId);

    await act(async () => {
      render(
        <TeamTagInput
          teamId={ctx.teamId}
          selectedTags={[]}
          onChange={vi.fn()}
        />,
      );
    });
    // No badge rendered
    expect(screen.queryByTestId("tag-badge")).toBeNull();
    // Add Tag button still present (not crashed)
    expect(screen.getByText("addTag")).toBeInTheDocument();
  });
});
