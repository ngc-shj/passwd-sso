// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

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

vi.mock("@/components/passwords/shared/copy-button", () => ({
  CopyButton: ({ getValue }: { getValue: () => string }) => (
    <button data-copy-value={getValue()}>Copy</button>
  ),
}));

vi.mock("@/lib/format/format-datetime", () => ({
  formatDateTime: (iso: string) => iso,
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
  withBasePath: (path: string) => path,
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

describe("ShareSendView protected FILE download", () => {
  let clickedDownloads: string[];

  beforeEach(() => {
    mockFetch.mockReset();
    clickedDownloads = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clickedDownloads.push(`${this.download}|${this.href}`);
    });
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn(() => "blob:mock-url"),
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderProtected(filename: string | null = "report.pdf") {
    render(
      <ShareSendView
        sendType="FILE"
        name="My File"
        filename={filename}
        sizeBytes={10}
        token="tok456"
        expiresAt="2025-12-31T00:00:00Z"
        viewCount={0}
        maxViews={null}
        accessToken="acc-1"
      />
    );
  }

  it("renders a download button instead of a direct link", () => {
    renderProtected();
    expect(screen.queryByRole("link", { name: /sendDownload/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sendDownload/ })).toBeInTheDocument();
  });

  it("fetches the file with the access token and saves it under the filename", async () => {
    mockFetch.mockResolvedValue(new Response(new Blob(["data"]), { status: 200 }));
    renderProtected();
    fireEvent.click(screen.getByRole("button", { name: /sendDownload/ }));

    await waitFor(() => expect(clickedDownloads).toEqual(["report.pdf|blob:mock-url"]));
    expect(mockFetch).toHaveBeenCalledWith("/s/tok456/download", {
      headers: { Authorization: "Bearer acc-1" },
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
    expect(screen.queryByText("contentLoadError")).not.toBeInTheDocument();
  });

  it("saves as 'download' when the send has no filename", async () => {
    mockFetch.mockResolvedValue(new Response(new Blob(["data"]), { status: 200 }));
    renderProtected(null);
    fireEvent.click(screen.getByRole("button", { name: /sendDownload/ }));
    await waitFor(() => expect(clickedDownloads).toEqual(["download|blob:mock-url"]));
  });

  it("shows a load error and saves nothing when the download is refused", async () => {
    mockFetch.mockResolvedValue(new Response("", { status: 403 }));
    renderProtected();
    fireEvent.click(screen.getByRole("button", { name: /sendDownload/ }));
    expect(await screen.findByText("contentLoadError")).toBeInTheDocument();
    expect(clickedDownloads).toEqual([]);
  });

  it("shows a load error when the download request throws", async () => {
    mockFetch.mockRejectedValue(new Error("network"));
    renderProtected();
    fireEvent.click(screen.getByRole("button", { name: /sendDownload/ }));
    expect(await screen.findByText("contentLoadError")).toBeInTheDocument();
  });

  it("clears a previous load error when a retry succeeds", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 500 }));
    mockFetch.mockResolvedValueOnce(new Response(new Blob(["data"]), { status: 200 }));
    renderProtected();
    const button = screen.getByRole("button", { name: /sendDownload/ });
    fireEvent.click(button);
    await screen.findByText("contentLoadError");
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByText("contentLoadError")).not.toBeInTheDocument());
    expect(clickedDownloads).toHaveLength(1);
  });
});

describe("ShareSendView TEXT copy", () => {
  it("hands the send text to the copy button", () => {
    render(
      <ShareSendView
        sendType="TEXT"
        name="Test"
        text="copy me"
        token="tok"
        expiresAt="2025-06-01T00:00:00Z"
        viewCount={0}
        maxViews={null}
      />
    );
    expect(screen.getByText("Copy")).toHaveAttribute("data-copy-value", "copy me");
  });
});
