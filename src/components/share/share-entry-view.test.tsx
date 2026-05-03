// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ENTRY_TYPE, CUSTOM_FIELD_TYPE } from "@/lib/constants";
import { ShareEntryView } from "./share-entry-view";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (!values) return key;
    return `${key}|${Object.entries(values).map(([k, v]) => `${k}=${String(v)}`).join(",")}`;
  },
  useLocale: () => "en",
}));

vi.mock("@/components/passwords/shared/copy-button", () => ({
  CopyButton: ({ getValue }: { getValue: () => string }) => (
    <button type="button" data-testid="copy" data-value={getValue()}>copy</button>
  ),
}));

describe("ShareEntryView", () => {
  it("renders LOGIN-typed fields with title and copy buttons", () => {
    render(
      <ShareEntryView
        data={{ title: "Acme", username: "alice", password: "pw", url: "https://example.com" }}
        entryType={ENTRY_TYPE.LOGIN}
        expiresAt="2025-12-31T00:00:00Z"
        viewCount={1}
        maxViews={null}
      />,
    );
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    // Password is masked by default
    expect(screen.getByText("••••••••")).toBeInTheDocument();
  });

  it("toggles password visibility on Eye click", () => {
    const { container } = render(
      <ShareEntryView
        data={{ title: "Acme", username: "alice", password: "secret-pw" }}
        entryType={ENTRY_TYPE.LOGIN}
        expiresAt="2025-12-31T00:00:00Z"
        viewCount={1}
        maxViews={null}
      />,
    );
    expect(screen.queryByText("secret-pw")).toBeNull();
    // Real Button rendering: real buttons include both copy and reveal toggles.
    // The reveal toggle is a Button with no accessible name (icon-only).
    // Click any button containing an Eye SVG by walking buttons in order until
    // the secret reveals.
    const buttons = Array.from(container.querySelectorAll("button"));
    for (const btn of buttons) {
      fireEvent.click(btn);
      if (screen.queryByText("secret-pw")) return;
    }
    expect(screen.getByText("secret-pw")).toBeInTheDocument();
  });

  it("renders SECURE_NOTE content branch", () => {
    render(
      <ShareEntryView
        data={{ title: "Note 1", content: "body text" }}
        entryType={ENTRY_TYPE.SECURE_NOTE}
        expiresAt="2025-12-31T00:00:00Z"
        viewCount={1}
        maxViews={null}
      />,
    );
    expect(screen.getByText("body text")).toBeInTheDocument();
  });

  it("renders CREDIT_CARD masked card number and CVV", () => {
    render(
      <ShareEntryView
        data={{
          title: "Visa",
          cardholderName: "Alice",
          cardNumber: "4111-1111-1111-1234",
          brand: "Visa",
          expiryMonth: "12",
          expiryYear: "2030",
          cvv: "123",
        }}
        entryType={ENTRY_TYPE.CREDIT_CARD}
        expiresAt="2025-12-31T00:00:00Z"
        viewCount={1}
        maxViews={null}
      />,
    );
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("12/2030")).toBeInTheDocument();
    // Both cardNumber and cvv are masked
    expect(screen.queryByText("4111-1111-1111-1234")).toBeNull();
    expect(screen.queryByText("123")).toBeNull();
  });

  it("renders unsafe javascript: url as plain text rather than anchor", () => {
    render(
      <ShareEntryView
        data={{
          title: "x",
          customFields: [
            { label: "link", value: "javascript:alert(1)", type: CUSTOM_FIELD_TYPE.URL },
          ],
        }}
        entryType={ENTRY_TYPE.LOGIN}
        expiresAt="2025-12-31T00:00:00Z"
        viewCount={1}
        maxViews={null}
      />,
    );
    // Must NOT render as <a href=javascript:...>
    const anchor = screen.queryByRole("link");
    expect(anchor).toBeNull();
  });

  it("renders viewCount metadata when maxViews set", () => {
    render(
      <ShareEntryView
        data={{ title: "x" }}
        entryType={ENTRY_TYPE.LOGIN}
        expiresAt="2025-12-31T00:00:00Z"
        viewCount={3}
        maxViews={5}
      />,
    );
    expect(screen.getByText(/viewCount\|current=3,max=5/)).toBeInTheDocument();
  });
});
