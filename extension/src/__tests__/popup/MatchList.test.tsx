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
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 1 }]),
      },
    });
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
    expect(await screen.findByText(/failed to load entries/i)).toBeInTheDocument();
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
    expect(await screen.findByRole("status")).toHaveTextContent("Password copied");
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

    expect(await screen.findByRole("status")).toHaveTextContent(
      "No password available for this entry."
    );
  });

  it("shows error when clipboard write fails", async () => {
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
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("denied")
    );

    render(<MatchList tabUrl="https://example.com/login" onLock={vi.fn()} />);

    const copyButton = await screen.findByRole("button", { name: "Copy" });
    fireEvent.click(copyButton);

    expect(await screen.findByRole("status")).toHaveTextContent(/clipboard write failed/i);
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

  it("hides copy/fill buttons for non-login entries", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "pw-1",
          title: "Note",
          username: "",
          urlHost: "",
          entryType: "SECURE_NOTE",
        },
      ],
    });

    render(<MatchList tabUrl={null} onLock={vi.fn()} />);
    await screen.findByText("Note");
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Fill" })).toBeNull();
  });

  it("triggers autofill on Fill click", async () => {
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
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
      .mockResolvedValueOnce({ type: "AUTOFILL", ok: true });

    render(<MatchList tabUrl="https://example.com/login" onLock={vi.fn()} />);

    const fillButton = await screen.findByRole("button", { name: "Fill" });
    fireEvent.click(fillButton);
    await waitFor(() => {
      expect(closeSpy).toHaveBeenCalled();
    });
    closeSpy.mockRestore();
  });

  it("shows error when autofill fails", async () => {
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
      .mockResolvedValueOnce({ type: "AUTOFILL", ok: false, error: "AUTOFILL_FAILED" });

    render(<MatchList tabUrl="https://example.com/login" onLock={vi.fn()} />);

    const fillButton = await screen.findByRole("button", { name: "Fill" });
    fireEvent.click(fillButton);

    expect(await screen.findByRole("status")).toHaveTextContent(/autofill failed/i);
  });

  it("shows error when no active tab is available", async () => {
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn().mockResolvedValue([]),
      },
    });
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

    const fillButton = await screen.findByRole("button", { name: "Fill" });
    fireEvent.click(fillButton);

    expect(await screen.findByRole("status")).toHaveTextContent(/no active tab found/i);
  });

  it("filters entries by search query", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "pw-1",
          title: "GitHub",
          username: "alice",
          urlHost: "github.com",
          entryType: "LOGIN",
        },
        {
          id: "pw-2",
          title: "Google",
          username: "bob",
          urlHost: "google.com",
          entryType: "LOGIN",
        },
      ],
    });

    render(<MatchList tabUrl={null} onLock={vi.fn()} />);
    const input = await screen.findByPlaceholderText("Search...");
    fireEvent.change(input, { target: { value: "git" } });
    expect(await screen.findByText("GitHub")).toBeInTheDocument();
    expect(screen.queryByText("Google")).toBeNull();
  });

  it("shows no results message when search yields no entries", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "pw-1",
          title: "GitHub",
          username: "alice",
          urlHost: "github.com",
          entryType: "LOGIN",
        },
      ],
    });

    render(<MatchList tabUrl={null} onLock={vi.fn()} />);
    const input = await screen.findByPlaceholderText("Search...");
    fireEvent.change(input, { target: { value: "nope" } });
    expect(await screen.findByText(/no results for/i)).toBeInTheDocument();
  });
});
