// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";

const { mockSessionProvider, sessionState } = vi.hoisted(() => ({
  mockSessionProvider: vi.fn(({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  )),
  sessionState: {
    status: "unauthenticated" as "loading" | "authenticated" | "unauthenticated",
    data: null as { user?: { id?: string } } | null,
  },
}));

vi.mock("next-auth/react", () => ({
  SessionProvider: mockSessionProvider,
  useSession: () => ({ ...sessionState, update: vi.fn() }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
}));

vi.mock("@/lib/constants", () => ({
  API_PATH: { API_ROOT: "/api" },
}));

import { ExpectedUserSync, SessionProvider } from "./session-provider";
import { fetchApi, _resetExpectedUserForTests } from "@/lib/url-helpers";

describe("SessionProvider", () => {
  it("passes basePath with NEXT_PUBLIC_BASE_PATH prefix to NextAuthSessionProvider", () => {
    render(
      <SessionProvider>
        <div>child</div>
      </SessionProvider>,
    );

    expect(mockSessionProvider).toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const props = (mockSessionProvider.mock.calls as any[])[0][0];
    const envBasePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(
      /\/$/,
      "",
    );
    expect(props.basePath).toBe(`${envBasePath}/api/auth`);
  });

  it("defaults basePath to /api/auth when NEXT_PUBLIC_BASE_PATH is empty", () => {
    // getAuthBasePath reads env at call time, so vi.stubEnv is sufficient
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
    mockSessionProvider.mockClear();

    render(
      <SessionProvider>
        <div>child</div>
      </SessionProvider>,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const props = (mockSessionProvider.mock.calls as any[])[0][0];
    expect(props.basePath).toBe("/api/auth");

    vi.unstubAllEnvs();
  });
});

describe("ExpectedUserSync", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const sentUser = async (): Promise<string | null> => {
    fetchSpy.mockClear();
    await fetchApi("/api/vault/status");
    const init = fetchSpy.mock.calls[0][1] as RequestInit | undefined;
    return new Headers(init?.headers).get("x-passwd-expected-user");
  };

  const ORIGIN = "https://app.example.com";
  let location: { origin: string; pathname: string; search: string; href: string };
  let originalLocation: Location;

  beforeEach(() => {
    _resetExpectedUserForTests();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response());
    originalLocation = window.location;
    location = { origin: ORIGIN, pathname: "/ja/dashboard", search: "?tab=1", href: "unchanged" };
    Object.defineProperty(window, "location", { value: location, writable: true, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", { value: originalLocation, writable: true, configurable: true });
    fetchSpy.mockRestore();
    sessionState.status = "unauthenticated";
    sessionState.data = null;
  });

  it("names the session user once authenticated, not while loading", async () => {
    sessionState.status = "loading";
    const { rerender } = render(<ExpectedUserSync />);
    expect(await sentUser()).toBeNull();

    sessionState.status = "authenticated";
    sessionState.data = { user: { id: "user-a" } };
    rerender(<ExpectedUserSync />);
    expect(await sentUser()).toBe("user-a");
  });

  it("stays bound to the first user and reloads the page when another is named", async () => {
    sessionState.status = "authenticated";
    sessionState.data = { user: { id: "user-a" } };
    const { rerender } = render(<ExpectedUserSync />);
    expect(await sentUser()).toBe("user-a");
    expect(location.href).toBe("unchanged");

    sessionState.data = { user: { id: "user-b" } };
    rerender(<ExpectedUserSync />);
    expect(await sentUser()).toBe("user-a");
    expect(location.href).toBe(`${ORIGIN}/ja/dashboard?tab=1`);
  });

  // A sign-in on a page that started signed out (passkey verify, then a
  // client-side push) binds; it is not a switch.
  it("binds a page that started signed out to the user who signs in, without reloading", async () => {
    const { rerender } = render(<ExpectedUserSync />);
    expect(await sentUser()).toBeNull();

    sessionState.status = "authenticated";
    sessionState.data = { user: { id: "user-a" } };
    rerender(<ExpectedUserSync />);
    expect(await sentUser()).toBe("user-a");
    expect(location.href).toBe("unchanged");
  });

  // An ended session keeps the last user: what the page still holds must not
  // be sent unbound under whatever cookie arrives next.
  it("keeps the last user through a refetch and after the session ends", async () => {
    sessionState.status = "authenticated";
    sessionState.data = { user: { id: "user-a" } };
    const { rerender } = render(<ExpectedUserSync />);

    sessionState.status = "loading";
    rerender(<ExpectedUserSync />);
    expect(await sentUser()).toBe("user-a");

    sessionState.status = "unauthenticated";
    sessionState.data = null;
    rerender(<ExpectedUserSync />);
    expect(await sentUser()).toBe("user-a");
    expect(location.href).toBe("unchanged");
  });
});
