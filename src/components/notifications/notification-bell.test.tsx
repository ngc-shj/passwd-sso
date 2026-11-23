// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

const TRANSLATED_KEYS = new Set(["type_SESSION_EVICTED", "body_SESSION_EVICTED"]);

vi.mock("next-intl", () => {
  const t = (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key;
  t.has = (key: string) => TRANSLATED_KEYS.has(key);
  return { useTranslations: () => t, useLocale: () => "en" };
});

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

// The menu is driven by an explicit toggle so the open → fetch path is reachable without Radix pointer events.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactNode;
    open: boolean;
    onOpenChange: (next: boolean) => void;
  }) => (
    <div>
      <button type="button" data-testid="toggle-menu" onClick={() => onOpenChange(!open)} />
      {children}
    </div>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect?: (e: { preventDefault: () => void }) => void;
  }) => (
    <div role="menuitem" onClick={(e) => onSelect?.(e)}>
      {children}
    </div>
  ),
}));

import { NotificationBell } from "./notification-bell";

const COUNT_PATH = "/api/notifications/count";
const LIST_PATH = "/api/notifications?limit=10";

interface Item {
  id: string;
  type: string;
  title: string;
  body: string;
  metadata: unknown;
  isRead: boolean;
  createdAt: string;
}

function item(overrides: Partial<Item>): Item {
  return {
    id: "n-1",
    type: "SECURITY_ALERT",
    title: "Raw title",
    body: "Raw body",
    metadata: null,
    isRead: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

interface Routes {
  count?: () => Promise<Response>;
  list?: () => Promise<Response>;
  patchAll?: () => Promise<Response>;
  patchOne?: () => Promise<Response>;
  del?: () => Promise<Response>;
}

function route(routes: Routes) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === COUNT_PATH) return (routes.count ?? (() => Promise.resolve(json({ unreadCount: 0 }))))();
    if (url === LIST_PATH) return (routes.list ?? (() => Promise.resolve(json({ items: [] }))))();
    if (url === "/api/notifications" && method === "PATCH") {
      return (routes.patchAll ?? (() => Promise.resolve(json({}))))();
    }
    if (url.startsWith("/api/notifications/") && method === "PATCH") {
      return (routes.patchOne ?? (() => Promise.resolve(json({}))))();
    }
    if (url.startsWith("/api/notifications/") && method === "DELETE") {
      return (routes.del ?? (() => Promise.resolve(json({}))))();
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
}

function bell() {
  return screen.getByLabelText("label");
}

function countCalls() {
  return mockFetch.mock.calls.filter((c) => c[0] === COUNT_PATH).length;
}

function callsWith(url: string, method: string) {
  return mockFetch.mock.calls.filter(
    (c) => c[0] === url && (c[1] as RequestInit | undefined)?.method === method,
  );
}

async function openWith(items: Item[], unreadCount: number, { strict = false } = {}) {
  route({
    count: () => Promise.resolve(json({ unreadCount })),
    list: () => Promise.resolve(json({ items })),
  });
  render(strict ? <StrictMode><NotificationBell /></StrictMode> : <NotificationBell />);
  if (unreadCount > 0) await within(bell()).findByText(String(unreadCount));
  fireEvent.click(screen.getByTestId("toggle-menu"));
}

describe("NotificationBell", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  it("shows the unread count fetched on mount as a badge", async () => {
    route({ count: () => Promise.resolve(json({ unreadCount: 5 })) });
    render(<NotificationBell />);
    expect(await within(bell()).findByText("5")).toBeInTheDocument();
  });

  it("caps the badge at 99+", async () => {
    route({ count: () => Promise.resolve(json({ unreadCount: 150 })) });
    render(<NotificationBell />);
    expect(await within(bell()).findByText("99+")).toBeInTheDocument();
  });

  it("shows no badge and no mark-all action when the count request fails", async () => {
    route({ count: () => Promise.reject(new Error("offline")) });
    render(<NotificationBell />);
    await waitFor(() => expect(countCalls()).toBe(1));
    expect(bell().textContent).toBe("");
    expect(screen.queryByText("markAllAsRead")).not.toBeInTheDocument();
  });

  it("re-polls the unread count every minute", async () => {
    vi.useFakeTimers();
    let unread = 1;
    route({ count: () => Promise.resolve(json({ unreadCount: unread })) });
    render(<NotificationBell />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(within(bell()).getByText("1")).toBeInTheDocument();

    unread = 3;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(countCalls()).toBe(2);
    expect(within(bell()).getByText("3")).toBeInTheDocument();
  });

  it("stops polling while the tab is hidden and refetches when it becomes visible", async () => {
    vi.useFakeTimers();
    route({});
    render(<NotificationBell />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(countCalls()).toBe(1);

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(countCalls()).toBe(1);

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(countCalls()).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(countCalls()).toBe(3);
  });

  it("stops polling after unmount", async () => {
    vi.useFakeTimers();
    route({});
    const { unmount } = render(<NotificationBell />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    unmount();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(countCalls()).toBe(1);
  });

  it("fetches the list with the bell limit when opened and renders translated type and body", async () => {
    await openWith(
      [
        item({
          type: "SESSION_EVICTED",
          metadata: { evictedCount: 2, maxConcurrentSessions: 3 },
        }),
      ],
      1,
    );
    expect(await screen.findByText("type_SESSION_EVICTED")).toBeInTheDocument();
    expect(
      screen.getByText('body_SESSION_EVICTED:{"count":"2","max":"3"}'),
    ).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledWith(LIST_PATH);
  });

  it("fills body placeholders with defaults when metadata is missing", async () => {
    await openWith([item({ type: "SESSION_EVICTED", metadata: null })], 1);
    expect(
      await screen.findByText('body_SESSION_EVICTED:{"count":"0","max":"?"}'),
    ).toBeInTheDocument();
  });

  it("falls back to the stored title and body when no translation exists for the type", async () => {
    await openWith([item({ type: "SECURITY_ALERT", title: "Stored title", body: "Stored body" })], 1);
    expect(await screen.findByText("Stored title")).toBeInTheDocument();
    expect(screen.getByText("Stored body")).toBeInTheDocument();
  });

  it("shows the empty state when the list is empty", async () => {
    await openWith([], 0);
    expect(await screen.findByText("noNotifications")).toBeInTheDocument();
  });

  it("shows the loading state while the list request is pending", async () => {
    route({ list: () => new Promise<Response>(() => {}) });
    render(<NotificationBell />);
    fireEvent.click(screen.getByTestId("toggle-menu"));
    expect(await screen.findByText("loading")).toBeInTheDocument();
  });

  it("falls back to the empty state when the list request fails", async () => {
    route({ list: () => Promise.resolve(json({ error: "x" }, 500)) });
    render(<NotificationBell />);
    fireEvent.click(screen.getByTestId("toggle-menu"));
    expect(await screen.findByText("noNotifications")).toBeInTheDocument();
  });

  it("does not refetch the list when the menu closes", async () => {
    await openWith([], 0);
    await screen.findByText("noNotifications");
    fireEvent.click(screen.getByTestId("toggle-menu"));
    expect(mockFetch.mock.calls.filter((c) => c[0] === LIST_PATH)).toHaveLength(1);
  });

  it("marks an unread notification as read when selected and decrements the badge", async () => {
    await openWith([item({ id: "n-7", title: "Alert" })], 2);
    fireEvent.click(await screen.findByRole("menuitem"));
    await within(bell()).findByText("1");
    expect(callsWith("/api/notifications/n-7", "PATCH")).toHaveLength(1);
  });

  it("does not PATCH when a read notification is selected", async () => {
    await openWith([item({ id: "n-7", isRead: true })], 0);
    fireEvent.click(await screen.findByRole("menuitem"));
    expect(callsWith("/api/notifications/n-7", "PATCH")).toHaveLength(0);
  });

  it("keeps the badge when marking one as read fails", async () => {
    route({
      count: () => Promise.resolve(json({ unreadCount: 2 })),
      list: () => Promise.resolve(json({ items: [item({ id: "n-7" })] })),
      patchOne: () => Promise.resolve(json({}, 500)),
    });
    render(<NotificationBell />);
    await within(bell()).findByText("2");
    fireEvent.click(screen.getByTestId("toggle-menu"));
    fireEvent.click(await screen.findByRole("menuitem"));
    await waitFor(() => expect(callsWith("/api/notifications/n-7", "PATCH")).toHaveLength(1));
    expect(within(bell()).getByText("2")).toBeInTheDocument();
  });

  it("marks all as read and clears the badge", async () => {
    await openWith([item({ id: "a" }), item({ id: "b" })], 2);
    await screen.findAllByRole("menuitem");
    fireEvent.click(screen.getByText("markAllAsRead"));
    await waitFor(() => expect(screen.queryByText("markAllAsRead")).not.toBeInTheDocument());
    expect(bell().textContent).toBe("");
    expect(callsWith("/api/notifications", "PATCH")).toHaveLength(1);
    // Items are now read, so selecting one sends no per-item PATCH.
    fireEvent.click(screen.getAllByRole("menuitem")[0]);
    expect(mockFetch.mock.calls.filter((c) => String(c[0]).startsWith("/api/notifications/a"))).toHaveLength(0);
  });

  it("keeps the badge when mark-all fails", async () => {
    route({
      count: () => Promise.resolve(json({ unreadCount: 2 })),
      patchAll: () => Promise.reject(new Error("offline")),
    });
    render(<NotificationBell />);
    await within(bell()).findByText("2");
    fireEvent.click(screen.getByText("markAllAsRead"));
    await waitFor(() => expect(callsWith("/api/notifications", "PATCH")).toHaveLength(1));
    expect(within(bell()).getByText("2")).toBeInTheDocument();
  });

  it("deletes an unread notification, decrements the badge and does not also mark it read", async () => {
    await openWith([item({ id: "n-1", title: "First" }), item({ id: "n-2", title: "Second" })], 2);
    await screen.findByText("First");
    fireEvent.click(screen.getAllByText("delete")[0]);
    await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
    expect(screen.getByText("Second")).toBeInTheDocument();
    expect(within(bell()).getByText("1")).toBeInTheDocument();
    expect(callsWith("/api/notifications/n-1", "DELETE")).toHaveLength(1);
    expect(callsWith("/api/notifications/n-1", "PATCH")).toHaveLength(0);
  });

  it("deleting a read notification leaves the unread count unchanged", async () => {
    await openWith([item({ id: "n-1", title: "First", isRead: true })], 2);
    await screen.findByText("First");
    fireEvent.click(screen.getByText("delete"));
    await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
    expect(within(bell()).getByText("2")).toBeInTheDocument();
  });

  it("decrements the badge by exactly one when an unread notification is deleted under StrictMode", async () => {
    await openWith(
      [item({ id: "n-1", title: "First" }), item({ id: "n-2", title: "Second" }), item({ id: "n-3", title: "Third" })],
      3,
      { strict: true },
    );
    await screen.findByText("First");
    fireEvent.click(screen.getAllByText("delete")[0]);
    await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
    expect(within(bell()).getByText("2")).toBeInTheDocument();
  });

  it("leaves the badge unchanged when a read notification is deleted under StrictMode", async () => {
    await openWith(
      [item({ id: "n-1", title: "First", isRead: true }), item({ id: "n-2", title: "Second" })],
      3,
      { strict: true },
    );
    await screen.findByText("First");
    fireEvent.click(screen.getAllByText("delete")[0]);
    await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
    expect(within(bell()).getByText("3")).toBeInTheDocument();
  });

  describe("when mark-read is in flight and the notification is then deleted", () => {
    function deferred() {
      let resolve: (res: Response) => void = () => {};
      const promise = new Promise<Response>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    async function clickRowThenDelete() {
      const patch = deferred();
      const del = deferred();
      route({
        count: () => Promise.resolve(json({ unreadCount: 3 })),
        list: () => Promise.resolve(json({ items: [item({ id: "n-1", title: "First" })] })),
        patchOne: () => patch.promise,
        del: () => del.promise,
      });
      render(<NotificationBell />);
      await within(bell()).findByText("3");
      fireEvent.click(screen.getByTestId("toggle-menu"));
      fireEvent.click(await screen.findByRole("menuitem"));
      fireEvent.click(screen.getByText("delete"));
      expect(callsWith("/api/notifications/n-1", "PATCH")).toHaveLength(1);
      expect(callsWith("/api/notifications/n-1", "DELETE")).toHaveLength(1);
      return { patch, del };
    }

    it("decrements once when mark-read succeeds first", async () => {
      const { patch, del } = await clickRowThenDelete();
      await act(async () => {
        patch.resolve(json({}));
      });
      await within(bell()).findByText("2");
      await act(async () => {
        del.resolve(json({}));
      });
      await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
      expect(within(bell()).getByText("2")).toBeInTheDocument();
    });

    it("decrements once when delete succeeds first", async () => {
      const { patch, del } = await clickRowThenDelete();
      await act(async () => {
        del.resolve(json({}));
      });
      await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
      await act(async () => {
        patch.resolve(json({}));
      });
      expect(within(bell()).getByText("2")).toBeInTheDocument();
    });

    it("decrements once when both responses land before React renders either", async () => {
      // Both handlers run in one act, so the second reads the list before the
      // first's write has rendered: only a list kept current at write time
      // (not at render or commit) sees that the item is already accounted for.
      const { patch, del } = await clickRowThenDelete();
      await act(async () => {
        patch.resolve(json({}));
        del.resolve(json({}));
      });
      expect(screen.queryByText("First")).not.toBeInTheDocument();
      expect(within(bell()).getByText("2")).toBeInTheDocument();
    });
  });

  it("keeps the notification when the delete request fails", async () => {
    route({
      count: () => Promise.resolve(json({ unreadCount: 1 })),
      list: () => Promise.resolve(json({ items: [item({ id: "n-1", title: "First" })] })),
      del: () => Promise.resolve(json({}, 500)),
    });
    render(<NotificationBell />);
    await within(bell()).findByText("1");
    fireEvent.click(screen.getByTestId("toggle-menu"));
    fireEvent.click(await screen.findByText("delete"));
    await waitFor(() => expect(callsWith("/api/notifications/n-1", "DELETE")).toHaveLength(1));
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(within(bell()).getByText("1")).toBeInTheDocument();
  });
});
