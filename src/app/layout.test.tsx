/**
 * The root layout sets the document language from the request locale and
 * publishes the request's CSP nonce in a meta tag for client code that must
 * nonce a runtime-created <style>.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

const { mockGetLocale, mockGetCspNonce } = vi.hoisted(() => ({
  mockGetLocale: vi.fn(),
  mockGetCspNonce: vi.fn(),
}));

vi.mock("next-intl/server", () => ({ getLocale: mockGetLocale }));
vi.mock("@/lib/security/csp-nonce.server", () => ({ getCspNonce: mockGetCspNonce }));

import RootLayout from "@/app/layout";
import { CSP_NONCE_META_NAME } from "@/lib/security/csp-nonce-names";

type El = ReactElement<{ children: El | El[]; [key: string]: unknown }>;

async function renderLayout(): Promise<El> {
  return (await RootLayout({ children: <main data-testid="app" /> })) as El;
}

function childrenOf(el: El): El[] {
  const { children } = el.props;
  return Array.isArray(children) ? children : [children];
}

describe("RootLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLocale.mockResolvedValue("en");
    mockGetCspNonce.mockResolvedValue("nonce-abc123");
  });

  it("sets the html lang to the request locale", async () => {
    const html = await renderLayout();

    expect(html.type).toBe("html");
    expect(html.props.lang).toBe("en");
  });

  it("publishes the request's CSP nonce in the head meta tag", async () => {
    const [head] = childrenOf(await renderLayout());
    const meta = childrenOf(head).find((child) => child?.type === "meta");

    expect(head.type).toBe("head");
    expect(meta?.props).toEqual({ name: CSP_NONCE_META_NAME, content: "nonce-abc123" });
  });

  it("renders the children inside body", async () => {
    const [, body] = childrenOf(await renderLayout());

    expect(body.type).toBe("body");
    expect((body.props.children as El).props).toEqual({ "data-testid": "app" });
  });
});
