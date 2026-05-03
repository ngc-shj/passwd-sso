import { describe, it, expect, vi } from "vitest";

// `next-intl/navigation`'s real `createNavigation` reaches into Next's
// `next/navigation` runtime module which is not statically resolvable by
// vite outside the Next bundler. Mock at this single boundary so the
// wrapper module can be imported and its export surface verified.
//
// Wrapper-under-test contract (`navigation.ts`): pass `routing` into
// `createNavigation` and re-export the returned helpers verbatim.

const { mockCreateNavigation, capturedRouting } = vi.hoisted(() => {
  const captured = { routing: undefined as unknown };
  const fn = vi.fn((routing: unknown) => {
    captured.routing = routing;
    return {
      Link: function Link() { return null; },
      redirect: vi.fn(),
      usePathname: vi.fn(() => "/"),
      useRouter: vi.fn(() => ({ push: vi.fn() })),
      getPathname: vi.fn(({ locale, href }: { locale: string; href: string }) => `/${locale}${href}`),
    };
  });
  return { mockCreateNavigation: fn, capturedRouting: captured };
});

vi.mock("next-intl/navigation", () => ({
  createNavigation: mockCreateNavigation,
}));

import * as navigation from "./navigation";
import { routing } from "./routing";

describe("i18n/navigation wrapper", () => {
  it("forwards the project routing config to createNavigation", () => {
    // The setup file clears mock call history each test (vi.clearAllMocks in
    // beforeEach) but the captured-routing side-channel survives — it was
    // recorded when the module first imported. Assert via the side-channel
    // rather than the call count.
    expect(capturedRouting.routing).toBe(routing);
  });

  it("re-exports the full next-intl navigation surface", () => {
    expect(navigation.Link).toBeDefined();
    expect(navigation.redirect).toBeDefined();
    expect(navigation.usePathname).toBeDefined();
    expect(navigation.useRouter).toBeDefined();
    expect(navigation.getPathname).toBeDefined();
  });

  it("redirect, usePathname, useRouter, getPathname are callable", () => {
    expect(typeof navigation.redirect).toBe("function");
    expect(typeof navigation.usePathname).toBe("function");
    expect(typeof navigation.useRouter).toBe("function");
    expect(typeof navigation.getPathname).toBe("function");
  });

  it("getPathname is the helper returned by createNavigation (no extra wrapping)", () => {
    const result = navigation.getPathname({ href: "/dashboard", locale: "en" });
    // Mock returns `/{locale}{href}` — assert the wrapper does not transform it.
    expect(result).toBe("/en/dashboard");
  });

  it("Link is exposed as a renderable value (function or React forwardRef object)", () => {
    const link = navigation.Link as unknown;
    const isCallable = typeof link === "function";
    const isExoticForwardRef =
      typeof link === "object" && link !== null && "$$typeof" in link;
    expect(isCallable || isExoticForwardRef).toBe(true);
  });
});
