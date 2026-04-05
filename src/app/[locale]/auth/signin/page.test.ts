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

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/i18n/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next-intl/server", () => ({
  getTranslations: mockGetTranslations,
  setRequestLocale: mockSetRequestLocale,
}));
vi.mock("@/lib/url-helpers", () => ({
  BASE_PATH: "",
  getAppOrigin: () => "https://example.com",
}));
const { mockParseAllowedGoogleDomains } = vi.hoisted(() => ({
  mockParseAllowedGoogleDomains: vi.fn<() => string[]>(() => []),
}));
vi.mock("@/lib/google-domain", () => ({
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
    mockGetTranslations.mockResolvedValue(fakeT);
    mockSetRequestLocale.mockReturnValue(undefined);
    mockRedirect.mockReturnValue(undefined);
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

  it("calls setRequestLocale with the correct locale", async () => {
    mockAuth.mockResolvedValue(null);

    await SignInPage({ params: makeParams("ja"), searchParams: makeSearchParams() });

    expect(mockSetRequestLocale).toHaveBeenCalledWith("ja");
  });

  describe("provider button visibility", () => {
    // Keys checked by the page: ID + SECRET for Google, URL + ID + SECRET for SAML
    const envKeys = [
      "AUTH_GOOGLE_ID",
      "AUTH_GOOGLE_SECRET",
      "JACKSON_URL",
      "AUTH_JACKSON_ID",
      "AUTH_JACKSON_SECRET",
    ] as const;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const k of envKeys) saved[k] = process.env[k];
    });

    afterEach(() => {
      for (const k of envKeys) {
        if (saved[k] !== undefined) process.env[k] = saved[k];
        else delete process.env[k];
      }
    });

    function setGoogle(enabled: boolean) {
      if (enabled) {
        process.env.AUTH_GOOGLE_ID = "test-id";
        process.env.AUTH_GOOGLE_SECRET = "test-secret";
      } else {
        delete process.env.AUTH_GOOGLE_ID;
        delete process.env.AUTH_GOOGLE_SECRET;
      }
    }

    function setSaml(enabled: boolean) {
      if (enabled) {
        process.env.JACKSON_URL = "http://localhost:5225";
        process.env.AUTH_JACKSON_ID = "test-jackson-id";
        process.env.AUTH_JACKSON_SECRET = "test-jackson-secret";
      } else {
        delete process.env.JACKSON_URL;
        delete process.env.AUTH_JACKSON_ID;
        delete process.env.AUTH_JACKSON_SECRET;
      }
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
      process.env.AUTH_GOOGLE_ID = "test-id";
      delete process.env.AUTH_GOOGLE_SECRET;
      setSaml(false);
      mockAuth.mockResolvedValue(null);

      const result = await SignInPage({ params: makeParams(), searchParams: makeSearchParams() });

      expect(hasProvider(result, "google")).toBe(false);
    });

    it("hides SSO button when AUTH_JACKSON_SECRET is missing", async () => {
      setGoogle(false);
      process.env.JACKSON_URL = "http://localhost:5225";
      process.env.AUTH_JACKSON_ID = "test-jackson-id";
      delete process.env.AUTH_JACKSON_SECRET;
      mockAuth.mockResolvedValue(null);

      const result = await SignInPage({ params: makeParams(), searchParams: makeSearchParams() });

      expect(hasProvider(result, "saml-jackson")).toBe(false);
    });
  });

  describe("Google multi-domain hint", () => {
    const googleEnvKeys = ["AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET"] as const;
    const savedGoogle: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const k of googleEnvKeys) savedGoogle[k] = process.env[k];
    });

    afterEach(() => {
      for (const k of googleEnvKeys) {
        if (savedGoogle[k] !== undefined) process.env[k] = savedGoogle[k];
        else delete process.env[k];
      }
      mockParseAllowedGoogleDomains.mockReturnValue([]);
    });

    it("shows hint when multiple Google Workspace domains are configured", async () => {
      process.env.AUTH_GOOGLE_ID = "test-id";
      process.env.AUTH_GOOGLE_SECRET = "test-secret";
      mockParseAllowedGoogleDomains.mockReturnValue(["example.com", "corp.example.com"]);
      mockAuth.mockResolvedValue(null);

      const result = await SignInPage({ params: makeParams(), searchParams: makeSearchParams() });

      expect(
        hasElement(result, (el) => el.props["data-testid"] === "google-domain-hint"),
      ).toBe(true);
    });

    it("does not show hint when single domain is configured", async () => {
      process.env.AUTH_GOOGLE_ID = "test-id";
      process.env.AUTH_GOOGLE_SECRET = "test-secret";
      mockParseAllowedGoogleDomains.mockReturnValue(["example.com"]);
      mockAuth.mockResolvedValue(null);

      const result = await SignInPage({ params: makeParams(), searchParams: makeSearchParams() });

      expect(
        hasElement(result, (el) => el.props["data-testid"] === "google-domain-hint"),
      ).toBe(false);
    });

    it("does not show hint when no domains are configured", async () => {
      process.env.AUTH_GOOGLE_ID = "test-id";
      process.env.AUTH_GOOGLE_SECRET = "test-secret";
      mockParseAllowedGoogleDomains.mockReturnValue([]);
      mockAuth.mockResolvedValue(null);

      const result = await SignInPage({ params: makeParams(), searchParams: makeSearchParams() });

      expect(
        hasElement(result, (el) => el.props["data-testid"] === "google-domain-hint"),
      ).toBe(false);
    });
  });
});
