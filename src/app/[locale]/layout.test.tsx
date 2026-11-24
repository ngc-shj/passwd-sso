import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement, ReactNode } from "react";

const { mockSetRequestLocale, mockGetTranslations, mockNotFound, mockCookieGet } = vi.hoisted(
  () => ({
    mockSetRequestLocale: vi.fn(),
    mockGetTranslations: vi.fn(),
    mockNotFound: vi.fn(),
    mockCookieGet: vi.fn(),
  }),
);

vi.mock("next-intl/server", () => ({
  getMessages: async () => {
    const { NS_DASHBOARD_ALL } = await import("@/i18n/namespace-groups");
    return Object.fromEntries([...NS_DASHBOARD_ALL, "Admin"].map((ns) => [ns, { key: ns }]));
  },
  getTranslations: mockGetTranslations,
  setRequestLocale: mockSetRequestLocale,
}));
vi.mock("next-intl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next-intl")>()),
  NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("next/navigation", () => ({ notFound: mockNotFound }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: mockCookieGet }) }));
vi.mock("@/components/providers/session-provider", () => ({
  SessionProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/providers/theme-provider", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/vault/vault-context", () => ({
  VaultProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));

import LocaleLayout, { generateMetadata, generateStaticParams } from "./layout";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { SessionProvider } from "@/components/providers/session-provider";
import { VaultProvider } from "@/lib/vault/vault-context";
import { Toaster } from "@/components/ui/sonner";
import { NS_GLOBAL } from "@/i18n/namespace-groups";
import { CSP_NONCE_COOKIE } from "@/lib/security/csp-nonce-names";

type El = ReactElement<{ children: ReactNode; messages?: Record<string, unknown>; nonce?: string }>;

const page = <div data-testid="page" />;

function renderLayout(locale: string): Promise<El> {
  return LocaleLayout({ children: page, params: Promise.resolve({ locale }) }) as Promise<El>;
}

describe("LocaleLayout", () => {
  beforeEach(() => {
    mockNotFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });
    mockCookieGet.mockImplementation((name: string) =>
      name === CSP_NONCE_COOKIE ? { value: "nonce-abc" } : undefined,
    );
  });

  it("rejects an unsupported locale with notFound before setting it", async () => {
    await expect(renderLayout("fr")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(mockSetRequestLocale).not.toHaveBeenCalled();
  });

  it("sets a supported locale as the request locale", async () => {
    await renderLayout("en");
    expect(mockNotFound).not.toHaveBeenCalled();
    expect(mockSetRequestLocale).toHaveBeenCalledWith("en");
  });

  it("serialises only the global namespaces to the client", async () => {
    const el = await renderLayout("ja");
    expect(el.type).toBe(NextIntlClientProvider);
    expect(Object.keys(el.props.messages ?? {}).sort()).toEqual([...NS_GLOBAL].sort());
  });

  it("passes the request's CSP nonce to the theme provider", async () => {
    const theme = (await renderLayout("ja")).props.children as El;
    expect(theme.type).toBe(ThemeProvider);
    expect(theme.props.nonce).toBe("nonce-abc");
  });

  it("nests the page and the toaster inside the session and vault providers", async () => {
    const theme = (await renderLayout("ja")).props.children as El;
    const session = theme.props.children as El;
    const vault = session.props.children as El;
    expect(session.type).toBe(SessionProvider);
    expect(vault.type).toBe(VaultProvider);
    const [first, second] = vault.props.children as ReactElement[];
    expect(first).toBe(page);
    expect(second.type).toBe(Toaster);
  });
});

describe("generateStaticParams", () => {
  it("emits one param set per supported locale", () => {
    expect(generateStaticParams()).toEqual([{ locale: "ja" }, { locale: "en" }]);
  });
});

describe("generateMetadata", () => {
  beforeEach(() => {
    mockGetTranslations.mockResolvedValue((key: string) => `Metadata.${key}`);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("translates the title and description in the Metadata namespace of the route locale", async () => {
    const meta = await generateMetadata({ children: null, params: Promise.resolve({ locale: "en" }) });
    expect(mockGetTranslations).toHaveBeenCalledWith({ locale: "en", namespace: "Metadata" });
    expect(meta.title).toBe("Metadata.title");
    expect(meta.description).toBe("Metadata.description");
  });

  it("prefixes every icon URL with the base path", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/pw");
    vi.resetModules();
    const mod = await import("./layout");
    const meta = await mod.generateMetadata({ children: null, params: Promise.resolve({ locale: "ja" }) });
    expect(meta.icons).toEqual({
      icon: [
        { url: "/pw/favicon.ico", sizes: "any" },
        { url: "/pw/icon.png", type: "image/png", sizes: "32x32" },
        { url: "/pw/icon.svg", type: "image/svg+xml" },
      ],
      apple: "/pw/apple-icon.png",
    });
  });
});
