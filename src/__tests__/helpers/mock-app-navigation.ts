/**
 * mock-app-navigation — shared helpers for mocking BOTH navigation modules
 * used by components in this codebase:
 *
 *   1. `next/navigation`   — raw Next.js client navigation. Used in components
 *      that don't need locale-aware routing (e.g., admin tools, vault gate).
 *      Surfaces: useRouter, useSearchParams, usePathname.
 *
 *   2. `@/i18n/navigation` — next-intl wrapper. Used by ~80% of components
 *      for locale-aware routing. Re-exports `Link`, `redirect`, `usePathname`,
 *      `useRouter`, `getPathname` via `createNavigation(routing)`.
 *
 * Each batch's test files use whichever factory matches the component's
 * import path. Mock the wrong module and the component's `useRouter` import
 * resolves to the real implementation, which fails in jsdom because the
 * Next.js router context isn't installed.
 *
 * Usage:
 *   import {
 *     mockNextNavigation,
 *     mockI18nNavigation,
 *   } from "@/__tests__/helpers/mock-app-navigation";
 *
 *   vi.mock("next/navigation", () => mockNextNavigation());
 *   vi.mock("@/i18n/navigation", () => mockI18nNavigation());
 *
 * Pass overrides via the optional argument:
 *   const router = vi.fn(...);
 *   vi.mock("@/i18n/navigation", () => mockI18nNavigation({ push: router }));
 */
import { vi } from "vitest";
import type { ComponentProps, ReactNode } from "react";

export interface MockRouterMethods {
  push: ReturnType<typeof vi.fn>;
  replace: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  back: ReturnType<typeof vi.fn>;
  forward: ReturnType<typeof vi.fn>;
  prefetch: ReturnType<typeof vi.fn>;
}

export function createMockRouter(
  overrides: Partial<MockRouterMethods> = {},
): MockRouterMethods {
  return {
    push: overrides.push ?? vi.fn(),
    replace: overrides.replace ?? vi.fn(),
    refresh: overrides.refresh ?? vi.fn(),
    back: overrides.back ?? vi.fn(),
    forward: overrides.forward ?? vi.fn(),
    prefetch: overrides.prefetch ?? vi.fn(),
  };
}

export interface NextNavigationMockOptions {
  router?: Partial<MockRouterMethods>;
  pathname?: string;
  searchParams?: URLSearchParams | string | Record<string, string>;
}

/**
 * Factory for `vi.mock("next/navigation", () => mockNextNavigation(...))`.
 * Returns the module shape with `useRouter`, `useSearchParams`, `usePathname`.
 */
export function mockNextNavigation(opts: NextNavigationMockOptions = {}) {
  const router = createMockRouter(opts.router);
  const pathname = opts.pathname ?? "/";
  const searchParams = normalizeSearchParams(opts.searchParams);

  return {
    useRouter: () => router,
    useSearchParams: () => searchParams,
    usePathname: () => pathname,
    // Static utility re-exports occasionally used by client components.
    redirect: vi.fn(),
    notFound: vi.fn(),
    permanentRedirect: vi.fn(),
  };
}

export interface I18nNavigationMockOptions {
  router?: Partial<MockRouterMethods>;
  pathname?: string;
  /**
   * Override for `Link`. Default is a passthrough anchor that forwards
   * `href` and children — sufficient for assertion-by-text/role tests.
   */
  Link?: (props: ComponentProps<"a"> & { href: string }) => ReactNode;
}

/**
 * Factory for `vi.mock("@/i18n/navigation", () => mockI18nNavigation(...))`.
 * Returns the same surface as `src/i18n/navigation.ts`'s named exports.
 */
export function mockI18nNavigation(opts: I18nNavigationMockOptions = {}) {
  const router = createMockRouter(opts.router);
  const pathname = opts.pathname ?? "/";

  // Default Link: render an anchor that forwards href + children. Tests using
  // `getByRole("link", { name: ... })` work without further configuration.
  const DefaultLink = ({
    href,
    children,
    ...rest
  }: ComponentProps<"a"> & { href: string }) => {
    return {
      type: "a",
      props: { href, ...rest, children },
      key: null,
    } as unknown as ReactNode;
  };

  return {
    Link: opts.Link ?? DefaultLink,
    useRouter: () => router,
    usePathname: () => pathname,
    redirect: vi.fn(),
    getPathname: vi.fn((args: { href: string }) => args.href),
  };
}

function normalizeSearchParams(
  input: URLSearchParams | string | Record<string, string> | undefined,
): URLSearchParams {
  if (input instanceof URLSearchParams) return input;
  if (typeof input === "string") return new URLSearchParams(input);
  if (input && typeof input === "object") return new URLSearchParams(input);
  return new URLSearchParams();
}

/**
 * mockTeamMismatch — companion factory for §Sec-3 cross-tenant tests.
 * Exported here (rather than in mock-team-auth.ts) because most cross-tenant
 * tests pair team-vault context with router/navigation mocks; co-locating
 * keeps the import surface coherent.
 *
 * Returns a useTeamVault stub whose `currentTeamId !== resourceTeamId`,
 * suitable for mocking `@/lib/team/team-vault-context`.
 */
export interface TeamMismatchOptions {
  actorTeamId: string;
  resourceTeamId: string;
}

export function mockTeamMismatch(opts: TeamMismatchOptions) {
  return {
    useTeamVault: () => ({
      currentTeamId: opts.actorTeamId,
      // The component reads currentTeamId; the test asserts the mismatch
      // produces an empty / fallback render rather than the resource view.
      isUnlocked: false,
      teamKey: null,
    }),
    teamId: opts.resourceTeamId,
  };
}
