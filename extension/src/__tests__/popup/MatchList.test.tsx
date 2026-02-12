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

    render(<MatchList onLock={vi.fn()} />);

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

    render(<MatchList onLock={vi.fn()} />);
    expect(await screen.findByText(/fetch_failed/i)).toBeInTheDocument();
  });

  it("locks vault on button click", async () => {
    const onLock = vi.fn();
    mockSendMessage
      .mockResolvedValueOnce({ type: "FETCH_PASSWORDS", entries: [] })
      .mockResolvedValueOnce({ type: "LOCK_VAULT", ok: true });

    render(<MatchList onLock={onLock} />);

    const lockButton = await screen.findByRole("button", { name: /lock/i });
    fireEvent.click(lockButton);

    await waitFor(() => {
      expect(onLock).toHaveBeenCalled();
    });
  });
});
