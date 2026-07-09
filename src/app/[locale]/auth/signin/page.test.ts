/**
 * SignInPage — Server Component test
 *
 * Covers:
 *   - Authenticated user → redirect to /dashboard
 *   - auth() throws (DB unavailable) → renders sign-in page (no redirect)
 *   - Unauthenticated → renders sign-in page (no redirect)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────
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
  // Non-throwing spy: the real next/navigation redirect throws NEXT_REDIRECT,
  // which would make pre/post-fix behavior indistinguishable in assertions.
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
vi.mock("@/lib/url-helpers", () => ({
  BASE_PATH: "",
  getAppOrigin: () => "https://example.com",
}));
vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({
  evaluateStepUpFreshness: mockEvaluateStepUpFreshness,
  canRecoverSessionWithPasskey: mockCanRecoverSessionWithPasskey,
  STEP_UP_FRESHNESS: { FRESH: "fresh", STALE: "stale", INVALID: "invalid" },
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

// Mock UI components to avoid React DOM rendering in node env
vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: unknown }) => children,
  CardContent: ({ children }: { children: unknown }) => children,
  CardHeader: ({ children }: { children: unknown }) => children,
  CardTitle: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/components/ui/separator", () => ({
  Separator: () => null,
}));
const { mockSignInButton } = vi.hoisted(() => ({
  mockSignInButton: vi.fn(() => null),
}));
vi.mock("@/components/auth/signin-button", () => ({
  SignInButton: mockSignInButton,
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

// ── Import after mocking ───────────────────────────────────
import SignInPage from "./page";

// ── Helpers ────────────────────────────────────────────────
const makeParams = (locale = "en") => Promise.resolve({ locale });
const makeSearchParams = (callbackUrl?: string) =>
  Promise.resolve(callbackUrl !== undefined ? { callbackUrl } : {});
const fakeT = (key: string) => key;

/** Walk a React element tree and return true if any node matches */
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

describe("SignInPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTranslations.mockResolvedValue(fakeT);
    mockSetRequestLocale.mockReturnValue(undefined);
    mockRedirect.mockReturnValue(undefined);
    mockGetSessionTokenFromCookieStore.mockReturnValue("sess-1");
    mockEvaluateStepUpFreshness.mockResolvedValue("fresh");
    mockCanRecoverSessionWithPasskey.mockResolvedValue(false);
    mockSignInReauthPanel.mockReturnValue(null);
  });

  it("redirects to /dashboard when user is authenticated", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", name: "Test" } });

    await SignInPage({ params: makeParams("en"), searchParams: makeSearchParams() });

    expect(mockRedirect).toHaveBeenCalledWith({
      href: "/dashboard",
      locale: "en",
    });
  });

  it("passes correct locale to redirect", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });

    await SignInPage({ params: makeParams("ja"), searchParams: makeSearchParams() });

    expect(mockRedirect).toHaveBeenCalledWith({
      href: "/dashboard",
      locale: "ja",
    });
  });

  it("renders sign-in page when auth() throws (DB unavailable)", async () => {
    mockAuth.mockRejectedValue(new Error("connection refused"));

    const result = await SignInPage({ params: makeParams(), searchParams: makeSearchParams() });

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it("renders sign-in page when user is not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const result = await SignInPage({ params: makeParams(), searchParams: makeSearchParams() });

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it("renders sign-in page when session has no user", async () => {
    mockAuth.mockResolvedValue({});

    const result = await SignInPage({ params: makeParams(), searchParams: makeSearchParams() });

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it("redirects to callbackUrl when authenticated and callbackUrl is present", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });

    await SignInPage({
      params: makeParams("ja"),
      searchParams: makeSearchParams("/ja/dashboard?ext_connect=1"),
    });

    // callbackUrlToHref strips locale prefix (next-intl redirect re-adds it)
    expect(mockRedirect).toHaveBeenCalledWith({
      href: "/dashboard?ext_connect=1",
      locale: "ja",
    });
  });

  it("rejects cross-origin callbackUrl when authenticated", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });

    await SignInPage({
      params: makeParams("en"),
      searchParams: makeSearchParams("https://evil.com/phish"),
    });

    expect(mockRedirect).toHaveBeenCalledWith({
      href: "/dashboard",
      locale: "en",
    });
  });

  describe("step-up-gated API callback (MCP / mobile OAuth)", () => {
    const API_CALLBACK = "https://example.com/api/mcp/authorize?client_id=c&x=1";

    beforeEach(() => {
      mockAuth.mockResolvedValue({ user: { id: "u1" } });
    });

    it("redirects with the basePath/locale-stripped path when the session is fresh", async () => {
      mockEvaluateStepUpFreshness.mockResolvedValue("fresh");

      await SignInPage({
        params: makeParams("ja"),
        searchParams: makeSearchParams(API_CALLBACK),
      });

      // Plain Next redirect (no locale injection); Next re-prepends basePath.
      expect(mockNextRedirect).toHaveBeenCalledWith(
        "/api/mcp/authorize?client_id=c&x=1",
      );
      expect(mockRedirect).not.toHaveBeenCalled();
      // Token plumbing: the freshness core receives the cookie-store token.
      expect(mockEvaluateStepUpFreshness).toHaveBeenCalledWith("sess-1");
      // Fresh path must not do the passkey-recovery credential query.
      expect(mockCanRecoverSessionWithPasskey).not.toHaveBeenCalled();
    });

    it("renders the reauth panel (no redirect) when the session is stale", async () => {
      mockEvaluateStepUpFreshness.mockResolvedValue("stale");
      mockCanRecoverSessionWithPasskey.mockResolvedValue(true);

      const result = await SignInPage({
        params: makeParams("ja"),
        searchParams: makeSearchParams(API_CALLBACK),
      });

      expect(mockNextRedirect).not.toHaveBeenCalled();
      expect(mockRedirect).not.toHaveBeenCalled();
      expect(
        hasElement(
          result,
          (el) =>
            el.type === mockSignInReauthPanel &&
            el.props.callbackHref === "/api/mcp/authorize?client_id=c&x=1" &&
            el.props.canUsePasskey === true,
        ),
      ).toBe(true);
      // Token plumbing: token + authenticated user id, in that order.
      expect(mockEvaluateStepUpFreshness).toHaveBeenCalledWith("sess-1");
      expect(mockCanRecoverSessionWithPasskey).toHaveBeenCalledWith(
        "sess-1",
        "u1",
      );
    });

    it("passes canUsePasskey=false to the panel when the session cannot recover via passkey", async () => {
      mockEvaluateStepUpFreshness.mockResolvedValue("stale");
      mockCanRecoverSessionWithPasskey.mockResolvedValue(false);

      const result = await SignInPage({
        params: makeParams("en"),
        searchParams: makeSearchParams(API_CALLBACK),
      });

      expect(
        hasElement(
          result,
          (el) =>
            el.type === mockSignInReauthPanel &&
            el.props.canUsePasskey === false,
        ),
      ).toBe(true);
    });

    it("falls through to the sign-in form when the session row is gone (invalid)", async () => {
      mockEvaluateStepUpFreshness.mockResolvedValue("invalid");

      const result = await SignInPage({
        params: makeParams("en"),
        searchParams: makeSearchParams(API_CALLBACK),
      });

      expect(mockNextRedirect).not.toHaveBeenCalled();
      expect(mockRedirect).not.toHaveBeenCalled();
      expect(
        hasElement(result, (el) => el.type === mockSignInReauthPanel),
      ).toBe(false);
      expect(result).toBeDefined();
    });

    it("treats a missing session cookie as invalid (form, no freshness query)", async () => {
      mockGetSessionTokenFromCookieStore.mockReturnValue(null);

      const result = await SignInPage({
        params: makeParams("en"),
        searchParams: makeSearchParams(API_CALLBACK),
      });

      expect(mockEvaluateStepUpFreshness).not.toHaveBeenCalled();
      expect(mockNextRedirect).not.toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });

  it("calls setRequestLocale with the correct locale", async () => {
    mockAuth.mockResolvedValue(null);

    await SignInPage({ params: makeParams("ja"), searchParams: makeSearchParams() });

    expect(mockSetRequestLocale).toHaveBeenCalledWith("ja");
  });

  describe("provider button visibility", () => {
    // Keys checked by the page: ID + SECRET for Google, URL + ID + SECRET for
    // SAML. vi.stubEnv with "" reads as falsy for the page's !!(...) checks;
    // afterEach unstubs are wired globally in setup.ts.
    function setGoogle(enabled: boolean) {
      vi.stubEnv("AUTH_GOOGLE_ID", enabled ? "test-id" : "");
      vi.stubEnv("AUTH_GOOGLE_SECRET", enabled ? "test-secret" : "");
    }

    function setSaml(enabled: boolean) {
      vi.stubEnv("JACKSON_URL", enabled ? "http://localhost:5225" : "");
      vi.stubEnv("AUTH_JACKSON_ID", enabled ? "test-jackson-id" : "");
      vi.stubEnv("AUTH_JACKSON_SECRET", enabled ? "test-jackson-secret" : "");
    }

    function hasProvider(tree: unknown, provider: string) {
      return hasElement(
        tree,
        (el) => el.type === mockSignInButton && el.props.provider === provider,
      );
    }

    it("shows only Google button when SAML is not configured", async () => {
      setGoogle(true);
      setSaml(false);
      mockAuth.mockResolvedValue(null);

      const result = await SignInPage({ params: makeParams(), searchParams: makeSearchParams() });

      expect(hasProvider(result, "google")).toBe(true);
      expect(hasProvider(result, "saml-jackson")).toBe(false);
    });

    it("shows only SSO button when Google is not configured", async () => {
      setGoogle(false);
      setSaml(true);
      mockAuth.mockResolvedValue(null);

      const result = await SignInPage({ params: makeParams(), searchParams: makeSearchParams() });

      expect(hasProvider(result, "google")).toBe(false);
      expect(hasProvider(result, "saml-jackson")).toBe(true);
    });

    it("shows both buttons when both are fully configured", async () => {
      setGoogle(true);
      setSaml(true);
      mockAuth.mockResolvedValue(null);

      const result = await SignInPage({ params: makeParams(), searchParams: makeSearchParams() });

      expect(hasProvider(result, "google")).toBe(true);
      expect(hasProvider(result, "saml-jackson")).toBe(true);
    });

    it("shows no buttons when neither is configured", async () => {
      setGoogle(false);
      setSaml(false);
      mockAuth.mockResolvedValue(null);

      const result = await SignInPage({ params: makeParams(), searchParams: makeSearchParams() });

      expect(hasProvider(result, "google")).toBe(false);
      expect(hasProvider(result, "saml-jackson")).toBe(false);
    });

    it("hides Google button when AUTH_GOOGLE_SECRET is missing", async () => {
      vi.stubEnv("AUTH_GOOGLE_ID", "test-id");
      vi.stubEnv("AUTH_GOOGLE_SECRET", "");
      setSaml(false);
      mockAuth.mockResolvedValue(null);

      const result = await SignInPage({ params: makeParams(), searchParams: makeSearchParams() });

      expect(hasProvider(result, "google")).toBe(false);
    });

    it("hides SSO button when AUTH_JACKSON_SECRET is missing", async () => {
      setGoogle(false);
      vi.stubEnv("JACKSON_URL", "http://localhost:5225");
      vi.stubEnv("AUTH_JACKSON_ID", "test-jackson-id");
      vi.stubEnv("AUTH_JACKSON_SECRET", "");
      mockAuth.mockResolvedValue(null);

      const result = await SignInPage({ params: makeParams(), searchParams: makeSearchParams() });

      expect(hasProvider(result, "saml-jackson")).toBe(false);
    });
  });

  describe("Google multi-domain hint", () => {
    afterEach(() => {
      mockParseAllowedGoogleDomains.mockReturnValue([]);
    });

    it("shows hint when multiple Google Workspace domains are configured", async () => {
      vi.stubEnv("AUTH_GOOGLE_ID", "test-id");
      vi.stubEnv("AUTH_GOOGLE_SECRET", "test-secret");
      mockParseAllowedGoogleDomains.mockReturnValue(["example.com", "corp.example.com"]);
      mockAuth.mockResolvedValue(null);

      const result = await SignInPage({ params: makeParams(), searchParams: makeSearchParams() });

      expect(
        hasElement(result, (el) => el.props["data-testid"] === "google-domain-hint"),
      ).toBe(true);
    });

    it("does not show hint when single domain is configured", async () => {
      vi.stubEnv("AUTH_GOOGLE_ID", "test-id");
      vi.stubEnv("AUTH_GOOGLE_SECRET", "test-secret");
      mockParseAllowedGoogleDomains.mockReturnValue(["example.com"]);
      mockAuth.mockResolvedValue(null);

      const result = await SignInPage({ params: makeParams(), searchParams: makeSearchParams() });

      expect(
        hasElement(result, (el) => el.props["data-testid"] === "google-domain-hint"),
      ).toBe(false);
    });

    it("does not show hint when no domains are configured", async () => {
      vi.stubEnv("AUTH_GOOGLE_ID", "test-id");
      vi.stubEnv("AUTH_GOOGLE_SECRET", "test-secret");
      mockParseAllowedGoogleDomains.mockReturnValue([]);
      mockAuth.mockResolvedValue(null);

      const result = await SignInPage({ params: makeParams(), searchParams: makeSearchParams() });

      expect(
        hasElement(result, (el) => el.props["data-testid"] === "google-domain-hint"),
      ).toBe(false);
    });
  });
});
