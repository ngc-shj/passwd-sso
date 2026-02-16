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
vi.mock("@/components/auth/signin-button", () => ({
  SignInButton: () => null,
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
});
