// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockFetchApi, mockToastError, mockToastApiError } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockToastError: vi.fn(),
  mockToastApiError: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (path: string, init?: RequestInit) => mockFetchApi(path, init),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
}));

vi.mock("@/lib/ui/dynamic-styles", () => ({
  getTagColorClass: (color: string | null) => (color ? `tag-color-${color}` : null),
}));

vi.mock("@/lib/http/toast-api-error", () => ({
  toastApiError: (...args: unknown[]) => mockToastApiError(...args),
}));

vi.mock("@/lib/format/tag-tree", () => ({
  buildTagPathMap: (tags: { id: string; name: string }[]) =>
    new Map(tags.map((t) => [t.id, t.name])),
}));

vi.mock("sonner", () => ({
  toast: { error: mockToastError },
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, className }: React.ComponentProps<"span">) => (
    <span className={className}>{children}</span>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, disabled, onClick, type }: React.ComponentProps<"button">) => (
    <button type={type} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/input", () => {
  // forwardRef not strictly required by the component (it accesses .current via
  // useRef inside React); use forwardRef so the ref actually attaches.
  const Input = React.forwardRef<
    HTMLInputElement,
    React.ComponentProps<"input">
  >(({ value, onChange, onKeyDown, placeholder, ...rest }, ref) => (
    <input
      ref={ref}
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      aria-label="tag-search"
      {...rest}
    />
  ));
  Input.displayName = "InputMock";
  return { Input };
});

import { TagInput, type TagData } from "./tag-input";

const allTags: TagData[] = [
  { id: "t1", name: "work", color: null, depth: 0 },
  { id: "t2", name: "personal", color: "blue", depth: 0 },
];

describe("TagInput", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
    mockToastError.mockReset();
    mockToastApiError.mockReset();
  });

  it("renders selected tags with name", async () => {
    mockFetchApi.mockResolvedValue({ ok: true, json: async () => allTags });

    const onChange = vi.fn();
    render(<TagInput selectedTags={[allTags[0]]} onChange={onChange} />);

    expect(screen.getByText("work")).toBeInTheDocument();
  });

  it("opens dropdown on add-tag click and lists unselected tags", async () => {
    mockFetchApi.mockResolvedValue({ ok: true, json: async () => allTags });

    render(<TagInput selectedTags={[]} onChange={vi.fn()} />);

    await waitFor(() => {
      expect(mockFetchApi).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText("addTag"));

    await waitFor(() => {
      expect(screen.getByLabelText("tag-search")).toBeInTheDocument();
    });
    expect(screen.getByText("personal")).toBeInTheDocument();
  });

  it("filters by input value (case-insensitive)", async () => {
    mockFetchApi.mockResolvedValue({ ok: true, json: async () => allTags });

    render(<TagInput selectedTags={[]} onChange={vi.fn()} />);
    await waitFor(() => expect(mockFetchApi).toHaveBeenCalled());

    fireEvent.click(screen.getByText("addTag"));
    fireEvent.change(screen.getByLabelText("tag-search"), {
      target: { value: "PER" },
    });

    expect(screen.getByText("personal")).toBeInTheDocument();
    // 'work' should be filtered out
    const workMatches = screen.queryAllByText("work");
    expect(workMatches).toHaveLength(0);
  });

  it("calls onChange with concatenated tag when an existing tag is clicked", async () => {
    mockFetchApi.mockResolvedValue({ ok: true, json: async () => allTags });
    const onChange = vi.fn();

    render(<TagInput selectedTags={[]} onChange={onChange} />);
    await waitFor(() => expect(mockFetchApi).toHaveBeenCalled());

    fireEvent.click(screen.getByText("addTag"));
    await waitFor(() => screen.getByText("work"));
    fireEvent.click(screen.getByText("work"));

    expect(onChange).toHaveBeenCalledWith([allTags[0]]);
  });

  it("creates a new tag on POST when user types a non-existing name and clicks create", async () => {
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => allTags,
    });
    mockFetchApi.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "t3", name: "new", color: null }),
    });
    const onChange = vi.fn();

    render(<TagInput selectedTags={[]} onChange={onChange} />);
    await waitFor(() => expect(mockFetchApi).toHaveBeenCalled());

    fireEvent.click(screen.getByText("addTag"));
    fireEvent.change(screen.getByLabelText("tag-search"), {
      target: { value: "new" },
    });

    fireEvent.click(screen.getByText(/createTag/));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    expect(mockFetchApi).toHaveBeenCalledTimes(2);
  });

  it("shows toast.error when input exceeds TAG_NAME_MAX_LENGTH", async () => {
    mockFetchApi.mockResolvedValue({ ok: true, json: async () => allTags });

    render(<TagInput selectedTags={[]} onChange={vi.fn()} />);
    await waitFor(() => expect(mockFetchApi).toHaveBeenCalled());

    fireEvent.click(screen.getByText("addTag"));
    // 51 chars (max is 50)
    fireEvent.change(screen.getByLabelText("tag-search"), {
      target: { value: "a".repeat(51) },
    });

    fireEvent.click(screen.getByText(/createTag/));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("nameTooLong");
    });
  });

  it("removes a selected tag when its X button is clicked", async () => {
    mockFetchApi.mockResolvedValue({ ok: true, json: async () => allTags });
    const onChange = vi.fn();

    render(
      <TagInput selectedTags={[allTags[0], allTags[1]]} onChange={onChange} />,
    );

    // Get all buttons; the X-removers are the 2nd and 3rd buttons after addTag
    const buttons = screen.getAllByRole("button");
    // Find the X button inside the badge for "work"
    // Find first button without text content (icon-only)
    const xButtons = buttons.filter((b) => b.textContent === "");
    expect(xButtons.length).toBeGreaterThan(0);
    fireEvent.click(xButtons[0]);

    expect(onChange).toHaveBeenCalledWith([allTags[1]]);
  });
});
