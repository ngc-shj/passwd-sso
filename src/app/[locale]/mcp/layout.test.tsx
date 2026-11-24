import { describe, it, expect, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

const { mockSetRequestLocale } = vi.hoisted(() => ({ mockSetRequestLocale: vi.fn() }));

vi.mock("next-intl/server", () => ({
  // Every namespace any layout picks from, so the provider's subset is the layout's own choice.
  getMessages: async () => {
    const groups = await import("@/i18n/namespace-groups");
    const all = new Set<string>(["Auth", "Extension", "Dashboard"]);
    for (const group of Object.values(groups)) group.forEach((ns) => all.add(ns));
    return Object.fromEntries([...all].map((ns) => [ns, { key: ns }]));
  },
  setRequestLocale: mockSetRequestLocale,
}));
vi.mock("next-intl", () => ({
  NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
}));

import McpLayout from "./layout";
import { NextIntlClientProvider } from "next-intl";
import { NS_MCP_CONSENT } from "@/i18n/namespace-groups";
const children = <div data-testid="page" />;

async function renderLayout(): Promise<ReactElement<{ messages: Record<string, unknown>; children: ReactNode }>> {
  return (await McpLayout({
    children,
    params: Promise.resolve({ locale: "ja" }),
  })) as ReactElement<{ messages: Record<string, unknown>; children: ReactNode }>;
}

describe("McpLayout", () => {
  it("sets the request locale from the route params", async () => {
    await renderLayout();
    expect(mockSetRequestLocale).toHaveBeenCalledWith("ja");
  });

  it("hands the client provider only the MCP consent namespaces", async () => {
    const el = await renderLayout();
    expect(el.type).toBe(NextIntlClientProvider);
    expect(Object.keys(el.props.messages).sort()).toEqual([...NS_MCP_CONSENT].sort());
  });

  it("renders the page inside the provider", async () => {
    const el = await renderLayout();
    expect(el.props.children).toBe(children);
  });
});
