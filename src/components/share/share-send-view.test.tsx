// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children, ...props }: React.ComponentProps<"div">) => (
    <div {...props}>{children}</div>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    asChild,
    ...rest
  }: React.ComponentProps<"button"> & { asChild?: boolean }) =>
    asChild ? <>{children}</> : <button {...rest}>{children}</button>,
}));

vi.mock("@/components/passwords/copy-button", () => ({
  CopyButton: () => <button>Copy</button>,
}));

vi.mock("@/lib/format-datetime", () => ({
  formatDateTime: (iso: string) => iso,
}));

import { ShareSendView } from "./share-send-view";

describe("ShareSendView", () => {
  it("renders TEXT send with name, text content, and copy button", () => {
    render(
      <ShareSendView
        sendType="TEXT"
        name="My Secret"
        text="secret text content"
        token="tok123"
        expiresAt="2025-12-31T00:00:00Z"
        viewCount={1}
        maxViews={5}
      />
    );

    expect(screen.getByText("My Secret")).toBeInTheDocument();
    expect(screen.getByText("secret text content")).toBeInTheDocument();
    expect(screen.getByText("Copy")).toBeInTheDocument();
    expect(screen.getByText(/viewCount/)).toBeInTheDocument();
  });

  it("renders FILE send with metadata and download button", () => {
    render(
      <ShareSendView
        sendType="FILE"
        name="My File"
        filename="report.pdf"
        sizeBytes={1024 * 1024}
        token="tok456"
        expiresAt="2025-12-31T00:00:00Z"
        viewCount={0}
        maxViews={null}
      />
    );

    expect(screen.getByText("My File")).toBeInTheDocument();
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByText("1.0 MB")).toBeInTheDocument();

    const downloadLink = screen.getByRole("link", { name: /sendDownload/ });
    expect(downloadLink).toHaveAttribute("href", "/s/tok456/download");
  });

  it("shows expires at info", () => {
    render(
      <ShareSendView
        sendType="TEXT"
        name="Test"
        text="hello"
        token="tok789"
        expiresAt="2025-06-01T00:00:00Z"
        viewCount={0}
        maxViews={null}
      />
    );

    expect(screen.getByText(/expiresAt/)).toBeInTheDocument();
  });

  it("does not show view count when maxViews is null", () => {
    render(
      <ShareSendView
        sendType="TEXT"
        name="Test"
        text="hello"
        token="tok000"
        expiresAt="2025-06-01T00:00:00Z"
        viewCount={0}
        maxViews={null}
      />
    );

    expect(screen.queryByText(/viewCount/)).not.toBeInTheDocument();
  });
});
