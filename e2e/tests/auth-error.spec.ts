/**
 * Auth error page tests — no authentication required.
 * Tests src/app/[locale]/auth/error/page.tsx.
 */
import { test, expect } from "@playwright/test";

test.describe("Auth Error Page", () => {
  test("AccessDenied error shows access-denied heading and description", async ({
    page,
  }) => {
    await page.goto("/ja/auth/error?error=AccessDenied");

    // Title: t("errorAccessDenied") = "Access denied"
    await expect(
      page.getByText(/Access denied|アクセスが拒否されました/i),
    ).toBeVisible({ timeout: 10_000 });

    // Description: t("errorAccessDeniedDescription")
    await expect(
      page.getByText(/Sign-in is not allowed for this account|このアカウントではサインインが許可されていません/i),
    ).toBeVisible({ timeout: 5_000 });

    // "Try again" button linking back to sign-in
    await expect(
      page.getByRole("link", { name: /Try again|再試行/i }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("Configuration error shows generic authentication error", async ({
    page,
  }) => {
    await page.goto("/ja/auth/error?error=Configuration");

    // Unknown / Configuration maps to titleKey = "error" → t("error") = "Authentication Error"
    await expect(
      page.getByText(/Authentication Error|認証エラー/i),
    ).toBeVisible({ timeout: 10_000 });

    // Generic description
    await expect(
      page.getByText(/An error occurred during sign in|サインイン中にエラーが発生しました/i),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("Verification error shows magic-link expired message", async ({
    page,
  }) => {
    await page.goto("/ja/auth/error?error=Verification");

    // t("errorVerification") = "Sign-in link is invalid"
    await expect(
      page.getByText(/Sign-in link is invalid|サインインリンクが無効です/i),
    ).toBeVisible({ timeout: 10_000 });

    // t("errorVerificationDescription")
    await expect(
      page.getByText(
        /has expired or has already been used|有効期限が切れたか、既に使用されています/i,
      ),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("unknown error code falls back to generic error", async ({ page }) => {
    await page.goto("/ja/auth/error?error=UnknownCode");

    // Unknown codes are normalised to undefined → generic "Authentication Error" title
    await expect(
      page.getByText(/Authentication Error|認証エラー/i),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("error page without query string shows generic error", async ({
    page,
  }) => {
    await page.goto("/ja/auth/error");

    await expect(
      page.getByText(/Authentication Error|認証エラー/i),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("accessing /dashboard without a session redirects to sign-in", async ({
    context,
    page,
  }) => {
    // Ensure no session cookie is present
    await context.clearCookies();

    await page.goto("/ja/dashboard");

    // Should be redirected to sign-in (proxy.ts enforces auth on /dashboard/*)
    await expect(page).toHaveURL(/\/auth\/signin/, { timeout: 10_000 });
  });

  test("en locale auth error page renders correctly", async ({ page }) => {
    await page.goto("/en/auth/error?error=AccessDenied");

    await expect(
      page.getByText(/Access denied/i),
    ).toBeVisible({ timeout: 10_000 });

    await expect(
      page.getByRole("link", { name: /Try again/i }),
    ).toBeVisible({ timeout: 5_000 });
  });
});
