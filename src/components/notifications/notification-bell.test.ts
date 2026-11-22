import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));
vi.mock("@/components/ui/button", () => ({
  Button: () => null,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: () => null,
  DropdownMenuContent: () => null,
  DropdownMenuItem: () => null,
  DropdownMenuLabel: () => null,
  DropdownMenuSeparator: () => null,
  DropdownMenuTrigger: () => null,
}));
vi.mock("@/lib/format/format-datetime", () => ({
  formatRelativeTime: () => "1 hour ago",
}));

describe("NotificationBell module", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-03-01T12:00:00Z") });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports NotificationBell component", async () => {
    const mod = await import("./notification-bell");
    expect(mod.NotificationBell).toBeDefined();
    expect(typeof mod.NotificationBell).toBe("function");
  });
});
