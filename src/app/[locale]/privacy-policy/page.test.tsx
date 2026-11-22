// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next-intl", () => {
  const t = (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key;
  t.rich = (key: string, tags: { link: (chunks: ReactNode) => ReactNode }) => (
    <>
      {key} {tags.link("issue tracker")}
    </>
  );
  return { useTranslations: () => t };
});
vi.mock("@/i18n/navigation", async () =>
  (await import("@/__tests__/helpers/mock-app-navigation")).mockI18nNavigation(),
);

import PrivacyPolicyPage from "./page";
import { CRYPTO_CONSTANTS } from "@/lib/crypto/crypto-client";

function section(key: string): HTMLElement {
  const heading = screen.getByRole("heading", { name: `sections.${key}.title` });
  const el = heading.closest("section");
  if (!el) throw new Error(`section ${key} not found`);
  return el;
}

describe("PrivacyPolicyPage", () => {
  it("renders the eight policy sections in order", () => {
    render(<PrivacyPolicyPage />);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(
      [
        "overview",
        "dataCollection",
        "dataAccessed",
        "serverCommunication",
        "permissions",
        "security",
        "changes",
        "contact",
      ].map((key) => `sections.${key}.title`),
    );
  });

  it("states the last-updated date", () => {
    render(<PrivacyPolicyPage />);
    expect(screen.getByText('lastUpdated:{"date":"2026-03-11"}')).toBeInTheDocument();
  });

  it("links back to the home page", () => {
    render(<PrivacyPolicyPage />);
    expect(screen.getByRole("link", { name: "backToHome" })).toHaveAttribute("href", "/");
  });

  it("quotes the real PBKDF2 iteration count in the security section", () => {
    render(<PrivacyPolicyPage />);
    expect(
      within(section("security")).getByText(
        `sections.security.body:${JSON.stringify({ iterations: CRYPTO_CONSTANTS.PBKDF2_ITERATIONS })}`,
      ),
    ).toBeInTheDocument();
  });

  it("links the contact section to the issue tracker in a new tab without an opener", () => {
    render(<PrivacyPolicyPage />);
    const link = within(section("contact")).getByRole("link", { name: "issue tracker" });
    expect(link).toHaveAttribute("href", "https://github.com/ngc-shj/passwd-sso/issues");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("lists the data the extension accesses", () => {
    render(<PrivacyPolicyPage />);
    const items = within(section("dataAccessed")).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(
      ["storage", "activeTab", "clipboard", "forms"].map(
        (item) => `${item} — sections.dataAccessed.items.${item}`,
      ),
    );
  });

  it("lists every extension permission", () => {
    render(<PrivacyPolicyPage />);
    const items = within(section("permissions")).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector("strong")?.textContent)).toEqual([
      "storage",
      "alarms",
      "activeTab",
      "scripting",
      "contextMenus",
      "clipboardWrite",
      "offscreen",
      "hostPermissions",
    ]);
  });

  it("renders plain sections without an item list", () => {
    render(<PrivacyPolicyPage />);
    expect(within(section("overview")).getByText("sections.overview.body")).toBeInTheDocument();
    expect(within(section("overview")).queryByRole("list")).not.toBeInTheDocument();
  });
});
