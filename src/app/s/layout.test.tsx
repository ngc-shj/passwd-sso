/**
 * The public share layout has no locale route segment, so it picks the locale
 * from Accept-Language and ships only the public-share namespaces under it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { NextIntlClientProvider } from "next-intl";
import { Toaster } from "@/components/ui/sonner";
import enShare from "../../../messages/en/Share.json";
import jaShare from "../../../messages/ja/Share.json";

const { mockHeaders } = vi.hoisted(() => ({ mockHeaders: vi.fn() }));

vi.mock("next/headers", () => ({ headers: mockHeaders }));

import ShareLayout from "@/app/s/layout";

interface ProviderProps {
  locale: string;
  messages: Record<string, unknown>;
  children: ReactElement[];
}

async function renderLayout(acceptLanguage: string | null): Promise<ReactElement<ProviderProps>> {
  const headers = new Headers();
  if (acceptLanguage !== null) headers.set("accept-language", acceptLanguage);
  mockHeaders.mockResolvedValue(headers);
  return (await ShareLayout({ children: <div data-testid="share-page" /> })) as ReactElement<ProviderProps>;
}

describe("ShareLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("provides the Accept-Language locale's public-share messages", async () => {
    const el = await renderLayout("en-US,ja;q=0.5");

    expect(el.type).toBe(NextIntlClientProvider);
    expect(el.props.locale).toBe("en");
    expect(el.props.messages.Share).toEqual(enShare);
  });

  it("ships only the public-share namespaces", async () => {
    const el = await renderLayout("en");

    expect(Object.keys(el.props.messages).sort()).toEqual(["Common", "CopyButton", "Share"]);
  });

  it("falls back to the default locale without an Accept-Language header", async () => {
    const el = await renderLayout(null);

    expect(el.props.locale).toBe("ja");
    expect(el.props.messages.Share).toEqual(jaShare);
  });

  it("renders the page followed by the toaster", async () => {
    const el = await renderLayout("en");
    const [page, toaster] = el.props.children;

    expect(page.props).toEqual({ "data-testid": "share-page" });
    expect(toaster.type).toBe(Toaster);
  });
});
