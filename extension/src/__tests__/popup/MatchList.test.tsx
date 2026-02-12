/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mockSendMessage = vi.fn();

vi.mock("../../lib/messaging", () => ({
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
}));

import { MatchList } from "../../popup/components/MatchList";

describe("MatchList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const clipboard = {
      writeText: vi.fn().mockResolvedValue(undefined),
    };
    Object.assign(navigator, { clipboard });
  });

  it("renders entries after fetch", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "pw-1",
          title: "Example",
          username: "alice",
          urlHost: "example.com",
          entryType: "LOGIN",
        },
      ],
    });

    render(<MatchList tabUrl="https://example.com/login" onLock={vi.fn()} />);

    expect(await screen.findByText("Example")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("example.com")).toBeInTheDocument();
  });

  it("shows error when fetch fails", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: null,
      error: "FETCH_FAILED",
    });

    render(<MatchList tabUrl="https://example.com/login" onLock={vi.fn()} />);
    expect(await screen.findByText(/fetch_failed/i)).toBeInTheDocument();
  });

  it("locks vault on button click", async () => {
    const onLock = vi.fn();
    mockSendMessage
      .mockResolvedValueOnce({ type: "FETCH_PASSWORDS", entries: [] })
      .mockResolvedValueOnce({ type: "LOCK_VAULT", ok: true });

    render(<MatchList tabUrl="https://example.com/login" onLock={onLock} />);

    const lockButton = await screen.findByRole("button", { name: /lock/i });
    fireEvent.click(lockButton);

    await waitFor(() => {
      expect(onLock).toHaveBeenCalled();
    });
  });

  it("copies password on button click", async () => {
    mockSendMessage
      .mockResolvedValueOnce({
        type: "FETCH_PASSWORDS",
        entries: [
          {
            id: "pw-1",
            title: "Example",
            username: "alice",
            urlHost: "example.com",
            entryType: "LOGIN",
          },
        ],
      })
      .mockResolvedValueOnce({
        type: "COPY_PASSWORD",
        password: "secret",
      });

    render(<MatchList tabUrl="https://example.com/login" onLock={vi.fn()} />);

    const copyButton = await screen.findByRole("button", { name: "Copy" });
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("secret");
    });
  });

  it("shows error when password is unavailable", async () => {
    mockSendMessage
      .mockResolvedValueOnce({
        type: "FETCH_PASSWORDS",
        entries: [
          {
            id: "pw-1",
            title: "Example",
            username: "alice",
            urlHost: "example.com",
            entryType: "LOGIN",
          },
        ],
      })
      .mockResolvedValueOnce({
        type: "COPY_PASSWORD",
        password: null,
        error: "NO_PASSWORD",
      });

    render(<MatchList tabUrl="https://example.com/login" onLock={vi.fn()} />);

    const copyButton = await screen.findByRole("button", { name: "Copy" });
    fireEvent.click(copyButton);

    expect(await screen.findByText(/no_password/i)).toBeInTheDocument();
  });

  it("shows generic no-match message for non-http(s) pages", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "pw-1",
          title: "Example",
          username: "alice",
          urlHost: "example.com",
          entryType: "LOGIN",
        },
      ],
    });

    render(<MatchList tabUrl="edge://extensions" onLock={vi.fn()} />);
    expect(await screen.findByText(/no matches for this page/i)).toBeInTheDocument();
  });

  it("shows entries without match header when tabUrl is null", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "pw-1",
          title: "Example",
          username: "alice",
          urlHost: "example.com",
          entryType: "LOGIN",
        },
      ],
    });

    render(<MatchList tabUrl={null} onLock={vi.fn()} />);
    expect(await screen.findByText("Example")).toBeInTheDocument();
    expect(screen.queryByText(/matches for/i)).toBeNull();
  });
});
