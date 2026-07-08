/**
 * SignInPage — basePath regression tests (separate file).
 *
 * The main page.test.ts mocks `@/lib/url-helpers` with `BASE_PATH: ""` at
 * module scope, which is exactly why the /passwd-sso/passwd-sso/api/...
 * doubling shipped unnoticed: the doubling cannot manifest under an empty
 * basePath. vi.mock is hoisted/static — one factory per module per file —
 * so the non-empty-basePath matrix lives here (mirrors the proven
 * callback-url-basepath.test.ts pattern).
 *
 * Covers:
 *  - L1: API callback redirect passes the basePath-STRIPPED path to Next's
 *    redirect() (Next re-prepends basePath; qualified input doubles it).
 *  - inverse-L1 (T8): the reauth panel receives the basePath-QUALIFIED path
 *    (window.location.assign gets no framework re-prepend).
 *  - I2: the non-API branch still strips basePath+locale for the intl
 *    redirect.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockAuth, mockRedirect, mockGetTranslations, mockSetRequestLocale } =
  vi.hoisted(() => ({
    mockAuth: vi.fn(),
    mockRedirect: vi.fn(),
    mockGetTranslations: vi.fn(),
    mockSetRequestLocale: vi.fn(),
  }));
const {
  mockNextRedirect,
  mockEvaluateStepUpFreshness,
  mockCanRecoverSessionWithPasskey,
  mockGetSessionTokenFromCookieStore,
  mockSignInReauthPanel,
} = vi.hoisted(() => ({
  // Non-throwing spy — the real redirect throws NEXT_REDIRECT, which would
  // make the doubled and fixed argument indistinguishable (green-on-both).
  mockNextRedirect: vi.fn(),
  mockEvaluateStepUpFreshness: vi.fn(),
  mockCanRecoverSessionWithPasskey: vi.fn(),
  mockGetSessionTokenFromCookieStore: vi.fn(),
  mockSignInReauthPanel: vi.fn(() => null),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/i18n/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next/navigation", () => ({ redirect: mockNextRedirect }));
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => undefined }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: mockGetTranslations,
  setRequestLocale: mockSetRequestLocale,
}));
// The load-bearing difference from page.test.ts: a NON-EMPTY basePath.
// callback-url.ts binds BASE_PATH from this module at import time.
vi.mock("@/lib/url-helpers", () => ({
  BASE_PATH: "/passwd-sso",
  getAppOrigin: () => "https://example.com",
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  evaluateStepUpFreshness: mockEvaluateStepUpFreshness,
  canRecoverSessionWithPasskey: mockCanRecoverSessionWithPasskey,
}));
vi.mock("@/app/api/sessions/helpers", () => ({
  getSessionTokenFromCookieStore: mockGetSessionTokenFromCookieStore,
}));
vi.mock("@/components/auth/signin-reauth-panel", () => ({
  SignInReauthPanel: mockSignInReauthPanel,
}));
const { mockParseAllowedGoogleDomains } = vi.hoisted(() => ({
  mockParseAllowedGoogleDomains: vi.fn<() => string[]>(() => []),
}));
vi.mock("@/lib/url/google-domain", () => ({
  parseAllowedGoogleDomains: mockParseAllowedGoogleDomains,
}));
vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: unknown }) => children,
  CardContent: ({ children }: { children: unknown }) => children,
  CardHeader: ({ children }: { children: unknown }) => children,
  CardTitle: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/components/ui/separator", () => ({
  Separator: () => null,
}));
vi.mock("@/components/auth/signin-button", () => ({
  SignInButton: () => null,
}));
vi.mock("lucide-react", () => ({
  Shield: () => null,
  ChevronDown: () => null,
}));
vi.mock("@/components/auth/security-key-signin-form", () => ({
  SecurityKeySignInForm: () => null,
}));
vi.mock("@/components/ui/app-icon", () => ({
  AppIcon: () => null,
}));

import SignInPage from "./page";

const makeParams = (locale = "ja") => Promise.resolve({ locale });
const makeSearchParams = (callbackUrl?: string) =>
  Promise.resolve(callbackUrl !== undefined ? { callbackUrl } : {});

function hasElement(
  node: unknown,
  predicate: (el: { type: unknown; props: Record<string, unknown> }) => boolean,
): boolean {
  if (node == null || typeof node !== "object") return false;
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type && el.props && predicate(el as { type: unknown; props: Record<string, unknown> }))
    return true;
  const children = el.props?.children;
  if (children == null) return false;
  const arr = Array.isArray(children) ? children : [children];
  return arr.some((child: unknown) => hasElement(child, predicate));
}

describe("SignInPage under BASE_PATH=/passwd-sso", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTranslations.mockResolvedValue((key: string) => key);
    mockSetRequestLocale.mockReturnValue(undefined);
    mockRedirect.mockReturnValue(undefined);
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockGetSessionTokenFromCookieStore.mockReturnValue("sess-1");
    mockEvaluateStepUpFreshness.mockResolvedValue("fresh");
    mockCanRecoverSessionWithPasskey.mockResolvedValue(false);
    mockSignInReauthPanel.mockReturnValue(null);
  });

  it("passes the basePath-STRIPPED path to Next redirect for a fresh API callback (L1)", async () => {
    await SignInPage({
      params: makeParams("ja"),
      searchParams: makeSearchParams(
        "https://example.com/passwd-sso/api/mcp/authorize?x=1",
      ),
    });

    // Pre-fix code passed the basePath-qualified path straight through
    // (/passwd-sso/api/mcp/authorize?x=1) and Next re-prepended basePath →
    // /passwd-sso/passwd-sso/api/... → 404. The stripped form is the fix.
    expect(mockNextRedirect).toHaveBeenCalledWith("/api/mcp/authorize?x=1");
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("passes the basePath-QUALIFIED path to the reauth panel for a stale API callback (inverse-L1)", async () => {
    mockEvaluateStepUpFreshness.mockResolvedValue("stale");
    mockCanRecoverSessionWithPasskey.mockResolvedValue(true);

    const result = await SignInPage({
      params: makeParams("ja"),
      searchParams: makeSearchParams(
        "https://example.com/passwd-sso/api/mcp/authorize?x=1",
      ),
    });

    // window.location.assign gets NO framework basePath re-prepend — the
    // panel must receive the qualified path (sign-flip of the L1 case).
    expect(
      hasElement(
        result,
        (el) =>
          el.type === mockSignInReauthPanel &&
          el.props.callbackHref === "/passwd-sso/api/mcp/authorize?x=1" &&
          el.props.canUsePasskey === true,
      ),
    ).toBe(true);
    expect(mockNextRedirect).not.toHaveBeenCalled();
  });

  it("still strips basePath+locale for the non-API intl redirect (I2)", async () => {
    await SignInPage({
      params: makeParams("ja"),
      searchParams: makeSearchParams(
        "https://example.com/passwd-sso/ja/dashboard?x=1",
      ),
    });

    expect(mockRedirect).toHaveBeenCalledWith({
      href: "/dashboard?x=1",
      locale: "ja",
    });
    expect(mockNextRedirect).not.toHaveBeenCalled();
  });
});
