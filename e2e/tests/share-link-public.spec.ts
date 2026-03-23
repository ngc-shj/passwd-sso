/**
 * Public share link tests — no authentication required.
 * Tests the /s/[token] route which is served from src/app/s/[token]/page.tsx.
 * Note: the share route has no locale prefix (it's in src/app/s/, not src/app/[locale]/s/).
 */
import { test, expect } from "@playwright/test";

test.describe("Share Link Public Page", () => {
  test("non-existent token shows not-found error", async ({ page }) => {
    // A 64-char hex token that does not exist in the database
    const fakeToken = "a".repeat(64);
    await page.goto(`/s/${fakeToken}`);

    // ShareError component renders with reason="notFound"
    await expect(
      page.getByText(/Link Not Found|リンクが見つかりません/i),
    ).toBeVisible({ timeout: 10_000 });

    // The description should also be visible
    await expect(
      page.getByText(
        /does not exist or has been removed|存在しないか削除されました/i,
      ),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("invalid token format (non-hex) shows not-found error", async ({
    page,
  }) => {
    // The page validates that the token is exactly 64 lowercase hex chars.
    // Anything else triggers the notFound branch immediately.
    await page.goto("/s/invalid-token-format");

    await expect(
      page.getByText(/Link Not Found|リンクが見つかりません/i),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("token shorter than 64 hex chars shows not-found error", async ({
    page,
  }) => {
    // 32 hex chars — valid hex but wrong length
    const shortToken = "deadbeef".repeat(4);
    await page.goto(`/s/${shortToken}`);

    await expect(
      page.getByText(/Link Not Found|リンクが見つかりません/i),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("share page renders without auth cookie", async ({ context, page }) => {
    // Ensure no session cookie is present
    await context.clearCookies();

    const fakeToken = "f".repeat(64);
    await page.goto(`/s/${fakeToken}`);

    // Should render the share page (not redirect to sign-in)
    // A not-found error is the expected outcome for a non-existent token
    await expect(
      page.getByText(/Link Not Found|リンクが見つかりません/i),
    ).toBeVisible({ timeout: 10_000 });

    // Must NOT have been redirected to the sign-in page
    expect(page.url()).not.toContain("/auth/signin");
  });
});
