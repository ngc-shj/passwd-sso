/**
 * SignInPage — Server Component test
 *
 * Covers:
 *   - Authenticated user → redirect to /dashboard
 *   - auth() throws (DB unavailable) → renders sign-in page (no redirect)
 *   - Unauthenticated → renders sign-in page (no redirect)
 */

import { describe, it, expect, beforeEach } from "vitest";

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
  KeyRound: () => null,
}));

// ── Import after mocking ───────────────────────────────────
import SignInPage from "./page";

// ── Helpers ────────────────────────────────────────────────
const makeParams = (locale = "en") => Promise.resolve({ locale });
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

    await SignInPage({ params: makeParams("en") });

    expect(mockRedirect).toHaveBeenCalledWith({
      href: "/dashboard",
      locale: "en",
    });
  });

  it("passes correct locale to redirect", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });

    await SignInPage({ params: makeParams("ja") });

    expect(mockRedirect).toHaveBeenCalledWith({
      href: "/dashboard",
      locale: "ja",
    });
  });

  it("renders sign-in page when auth() throws (DB unavailable)", async () => {
    mockAuth.mockRejectedValue(new Error("connection refused"));

    const result = await SignInPage({ params: makeParams() });

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it("renders sign-in page when user is not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const result = await SignInPage({ params: makeParams() });

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it("renders sign-in page when session has no user", async () => {
    mockAuth.mockResolvedValue({});

    const result = await SignInPage({ params: makeParams() });

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it("calls setRequestLocale with the correct locale", async () => {
    mockAuth.mockResolvedValue(null);

    await SignInPage({ params: makeParams("ja") });

    expect(mockSetRequestLocale).toHaveBeenCalledWith("ja");
  });

  describe("provider button visibility", () => {
    const origGoogleId = process.env.AUTH_GOOGLE_ID;
    const origJacksonUrl = process.env.JACKSON_URL;

    afterEach(() => {
      // Restore original env
      if (origGoogleId !== undefined) process.env.AUTH_GOOGLE_ID = origGoogleId;
      else delete process.env.AUTH_GOOGLE_ID;
      if (origJacksonUrl !== undefined) process.env.JACKSON_URL = origJacksonUrl;
      else delete process.env.JACKSON_URL;
    });

    function hasProvider(tree: unknown, provider: string) {
      return hasElement(
        tree,
        (el) => el.type === mockSignInButton && el.props.provider === provider,
      );
    }

    it("shows only Google button when JACKSON_URL is not set", async () => {
      process.env.AUTH_GOOGLE_ID = "test-id";
      delete process.env.JACKSON_URL;
      mockAuth.mockResolvedValue(null);

      const result = await SignInPage({ params: makeParams() });

      expect(hasProvider(result, "google")).toBe(true);
      expect(hasProvider(result, "saml-jackson")).toBe(false);
    });

    it("shows only SSO button when AUTH_GOOGLE_ID is not set", async () => {
      delete process.env.AUTH_GOOGLE_ID;
      process.env.JACKSON_URL = "http://localhost:5225";
      mockAuth.mockResolvedValue(null);

      const result = await SignInPage({ params: makeParams() });

      expect(hasProvider(result, "google")).toBe(false);
      expect(hasProvider(result, "saml-jackson")).toBe(true);
    });

    it("shows both buttons when both are configured", async () => {
      process.env.AUTH_GOOGLE_ID = "test-id";
      process.env.JACKSON_URL = "http://localhost:5225";
      mockAuth.mockResolvedValue(null);

      const result = await SignInPage({ params: makeParams() });

      expect(hasProvider(result, "google")).toBe(true);
      expect(hasProvider(result, "saml-jackson")).toBe(true);
    });

    it("shows no buttons when neither is configured", async () => {
      delete process.env.AUTH_GOOGLE_ID;
      delete process.env.JACKSON_URL;
      mockAuth.mockResolvedValue(null);

      const result = await SignInPage({ params: makeParams() });

      expect(hasProvider(result, "google")).toBe(false);
      expect(hasProvider(result, "saml-jackson")).toBe(false);
    });
  });
});
