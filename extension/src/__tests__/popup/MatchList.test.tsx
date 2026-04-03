/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EXT_ENTRY_TYPE } from "../../lib/constants";

const mockSendMessage = vi.fn();
const mockGetSettings = vi.fn();

vi.mock("../../lib/messaging", () => ({
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
}));
vi.mock("../../lib/storage", () => ({
  getSettings: () => mockGetSettings(),
}));

import { MatchList } from "../../popup/components/MatchList";

describe("MatchList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockResolvedValue({ clipboardClearSeconds: 30 });
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
          entryType: EXT_ENTRY_TYPE.LOGIN,
        },
      ],
    });

    render(<MatchList tabUrl="https://example.com/login" />);

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

    render(<MatchList tabUrl="https://example.com/login" />);
    expect(await screen.findByText(/failed to load entries/i)).toBeInTheDocument();
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
            entryType: EXT_ENTRY_TYPE.LOGIN,
          },
        ],
      })
      .mockResolvedValueOnce({
        type: "COPY_PASSWORD",
        password: "secret",
      });

    render(<MatchList tabUrl="https://example.com/login" />);

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
            entryType: EXT_ENTRY_TYPE.LOGIN,
          },
        ],
      })
      .mockResolvedValueOnce({
        type: "COPY_PASSWORD",
        password: null,
        error: "NO_PASSWORD",
      });

    render(<MatchList tabUrl="https://example.com/login" />);

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
            entryType: EXT_ENTRY_TYPE.LOGIN,
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

    render(<MatchList tabUrl="https://example.com/login" />);

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
          entryType: EXT_ENTRY_TYPE.LOGIN,
        },
      ],
    });

    render(<MatchList tabUrl="edge://extensions" />);
    expect(await screen.findByText(/no matches for this page/i)).toBeInTheDocument();
  });

  it("shows no entries when tabUrl is null (non-web page)", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "pw-1",
          title: "Example",
          username: "alice",
          urlHost: "example.com",
          entryType: EXT_ENTRY_TYPE.LOGIN,
        },
      ],
    });

    render(<MatchList tabUrl={null} />);
    // Search box should appear (entries exist) but no entries listed
    await screen.findByPlaceholderText("Search...");
    expect(screen.queryByText("Example")).toBeNull();
  });

  it("hides copy/fill buttons for non-login entries", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "pw-1",
          title: "Note",
          username: "",
          urlHost: "example.com",
          entryType: "SECURE_NOTE",
        },
      ],
    });

    render(<MatchList tabUrl="https://example.com" />);
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
            entryType: EXT_ENTRY_TYPE.LOGIN,
          },
        ],
      })
      .mockResolvedValueOnce({ type: "AUTOFILL", ok: true });

    render(<MatchList tabUrl="https://example.com/login" />);

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
            entryType: EXT_ENTRY_TYPE.LOGIN,
          },
        ],
      })
      .mockResolvedValueOnce({ type: "AUTOFILL", ok: false, error: "AUTOFILL_FAILED" });

    render(<MatchList tabUrl="https://example.com/login" />);

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
          entryType: EXT_ENTRY_TYPE.LOGIN,
        },
      ],
    });

    render(<MatchList tabUrl="https://example.com/login" />);

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
          entryType: EXT_ENTRY_TYPE.LOGIN,
        },
        {
          id: "pw-2",
          title: "Google",
          username: "bob",
          urlHost: "google.com",
          entryType: EXT_ENTRY_TYPE.LOGIN,
        },
      ],
    });

    render(<MatchList tabUrl="https://github.com" />);
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
          entryType: EXT_ENTRY_TYPE.LOGIN,
        },
      ],
    });

    render(<MatchList tabUrl="https://other.com" />);
    const input = await screen.findByPlaceholderText("Search...");
    fireEvent.change(input, { target: { value: "nope" } });
    expect(await screen.findByText(/no results for/i)).toBeInTheDocument();
  });

  it("shows TOTP button for LOGIN entries", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "pw-1",
          title: "Example",
          username: "alice",
          urlHost: "example.com",
          entryType: EXT_ENTRY_TYPE.LOGIN,
        },
      ],
    });

    render(<MatchList tabUrl="https://example.com/login" />);
    expect(await screen.findByRole("button", { name: "TOTP" })).toBeInTheDocument();
  });

  it("does not show TOTP button for non-login entries", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "pw-1",
          title: "Note",
          username: "",
          urlHost: "example.com",
          entryType: "SECURE_NOTE",
        },
      ],
    });

    render(<MatchList tabUrl="https://example.com" />);
    await screen.findByText("Note");
    expect(screen.queryByRole("button", { name: "TOTP" })).toBeNull();
  });

  it("copies TOTP code and shows success toast", async () => {
    mockSendMessage
      .mockResolvedValueOnce({
        type: "FETCH_PASSWORDS",
        entries: [
          {
            id: "pw-1",
            title: "Example",
            username: "alice",
            urlHost: "example.com",
            entryType: EXT_ENTRY_TYPE.LOGIN,
          },
        ],
      })
      .mockResolvedValueOnce({
        type: "COPY_TOTP",
        code: "123456",
      });

    render(<MatchList tabUrl="https://example.com/login" />);

    const totpButton = await screen.findByRole("button", { name: "TOTP" });
    fireEvent.click(totpButton);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("123456");
    });
    expect(await screen.findByRole("status")).toHaveTextContent(/TOTP code copied/i);
  });

  it("shows error toast when TOTP is not configured", async () => {
    mockSendMessage
      .mockResolvedValueOnce({
        type: "FETCH_PASSWORDS",
        entries: [
          {
            id: "pw-1",
            title: "Example",
            username: "alice",
            urlHost: "example.com",
            entryType: EXT_ENTRY_TYPE.LOGIN,
          },
        ],
      })
      .mockResolvedValueOnce({
        type: "COPY_TOTP",
        code: null,
        error: "NO_TOTP",
      });

    render(<MatchList tabUrl="https://example.com/login" />);

    const totpButton = await screen.findByRole("button", { name: "TOTP" });
    fireEvent.click(totpButton);

    expect(await screen.findByRole("status")).toHaveTextContent(
      /no totp configured for this entry/i,
    );
  });

  it("schedules clipboard clear 30s after TOTP copy", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    mockSendMessage
      .mockResolvedValueOnce({
        type: "FETCH_PASSWORDS",
        entries: [
          {
            id: "pw-1",
            title: "Example",
            username: "alice",
            urlHost: "example.com",
            entryType: EXT_ENTRY_TYPE.LOGIN,
          },
        ],
      })
      .mockResolvedValueOnce({
        type: "COPY_TOTP",
        code: "654321",
      });

    render(<MatchList tabUrl="https://example.com/login" />);

    const totpButton = await screen.findByRole("button", { name: "TOTP" });
    fireEvent.click(totpButton);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("654321");
    });

    const clearCall = setTimeoutSpy.mock.calls.find(
      (call) => call[1] === 30_000,
    );
    expect(clearCall).toBeDefined();

    setTimeoutSpy.mockRestore();
  });

  it("shows team badge for entries with teamName", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "pw-1",
          title: "Team Entry",
          username: "alice",
          urlHost: "example.com",
          entryType: EXT_ENTRY_TYPE.LOGIN,
          teamId: "team-1",
          teamName: "Engineering",
        },
      ],
    });

    render(<MatchList tabUrl="https://example.com" />);
    expect(await screen.findByText("Team Entry")).toBeInTheDocument();
    expect(screen.getByText("Engineering")).toBeInTheDocument();
  });

  it("does not show team badge for personal entries", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "pw-1",
          title: "Personal Entry",
          username: "alice",
          urlHost: "example.com",
          entryType: EXT_ENTRY_TYPE.LOGIN,
        },
      ],
    });

    render(<MatchList tabUrl="https://example.com" />);
    expect(await screen.findByText("Personal Entry")).toBeInTheDocument();
    const badges = document.querySelectorAll(".text-purple-700");
    expect(badges).toHaveLength(0);
  });

  it("passes teamId in COPY_PASSWORD message for team entries", async () => {
    mockSendMessage
      .mockResolvedValueOnce({
        type: "FETCH_PASSWORDS",
        entries: [
          {
            id: "pw-1",
            title: "Team Entry",
            username: "alice",
            urlHost: "example.com",
            entryType: EXT_ENTRY_TYPE.LOGIN,
            teamId: "team-1",
            teamName: "Engineering",
          },
        ],
      })
      .mockResolvedValueOnce({
        type: "COPY_PASSWORD",
        password: "secret",
      });

    render(<MatchList tabUrl="https://example.com/login" />);

    const copyButton = await screen.findByRole("button", { name: "Copy" });
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith({
        type: "COPY_PASSWORD",
        entryId: "pw-1",
        teamId: "team-1",
      });
    });
  });

  it("passes teamId in AUTOFILL message for team entries", async () => {
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    mockSendMessage
      .mockResolvedValueOnce({
        type: "FETCH_PASSWORDS",
        entries: [
          {
            id: "pw-1",
            title: "Team Entry",
            username: "alice",
            urlHost: "example.com",
            entryType: EXT_ENTRY_TYPE.LOGIN,
            teamId: "team-1",
            teamName: "Engineering",
          },
        ],
      })
      .mockResolvedValueOnce({ type: "AUTOFILL", ok: true });

    render(<MatchList tabUrl="https://example.com/login" />);

    const fillButton = await screen.findByRole("button", { name: "Fill" });
    fireEvent.click(fillButton);
    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith({
        type: "AUTOFILL",
        entryId: "pw-1",
        tabId: 1,
        teamId: "team-1",
      });
    });
    closeSpy.mockRestore();
  });

  it("passes teamId in COPY_TOTP message for team entries", async () => {
    mockSendMessage
      .mockResolvedValueOnce({
        type: "FETCH_PASSWORDS",
        entries: [
          {
            id: "pw-1",
            title: "Team Entry",
            username: "alice",
            urlHost: "example.com",
            entryType: EXT_ENTRY_TYPE.LOGIN,
            teamId: "team-1",
            teamName: "Engineering",
          },
        ],
      })
      .mockResolvedValueOnce({
        type: "COPY_TOTP",
        code: "123456",
      });

    render(<MatchList tabUrl="https://example.com/login" />);

    const totpButton = await screen.findByRole("button", { name: "TOTP" });
    fireEvent.click(totpButton);

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith({
        type: "COPY_TOTP",
        entryId: "pw-1",
        teamId: "team-1",
      });
    });
  });

  it("uses unique keys for team entries with same id as personal entries", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "pw-1",
          title: "Personal",
          username: "alice",
          urlHost: "example.com",
          entryType: EXT_ENTRY_TYPE.LOGIN,
        },
        {
          id: "pw-1",
          title: "Team Copy",
          username: "alice",
          urlHost: "example.com",
          entryType: EXT_ENTRY_TYPE.LOGIN,
          teamId: "team-1",
          teamName: "Engineering",
        },
      ],
    });

    render(<MatchList tabUrl="https://example.com" />);
    expect(await screen.findByText("Personal")).toBeInTheDocument();
    expect(screen.getByText("Team Copy")).toBeInTheDocument();
  });

  it("hides non-matching LOGIN entries when tabUrl is set", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "login-match",
          title: "Matched Login",
          username: "alice",
          urlHost: "example.com",
          entryType: EXT_ENTRY_TYPE.LOGIN,
        },
        {
          id: "login-other",
          title: "Other Login",
          username: "bob",
          urlHost: "other.com",
          entryType: EXT_ENTRY_TYPE.LOGIN,
        },
        {
          id: "card-1",
          title: "My Card",
          username: "",
          urlHost: "",
          entryType: EXT_ENTRY_TYPE.CREDIT_CARD,
        },
      ],
    });

    render(<MatchList tabUrl="https://example.com" />);

    expect(await screen.findByText("Matched Login")).toBeInTheDocument();
    expect(screen.getByText("My Card")).toBeInTheDocument();
    expect(screen.queryByText("Other Login")).toBeNull();
  });

  it("shows no entries when tabUrl is null (non-web page)", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "login-1",
          title: "Login Entry",
          username: "alice",
          urlHost: "example.com",
          entryType: EXT_ENTRY_TYPE.LOGIN,
        },
        {
          id: "card-1",
          title: "Card Entry",
          username: "",
          urlHost: "",
          entryType: EXT_ENTRY_TYPE.CREDIT_CARD,
        },
      ],
    });

    render(<MatchList tabUrl={null} />);

    await screen.findByPlaceholderText("Search...");
    expect(screen.queryByText("Login Entry")).toBeNull();
    expect(screen.queryByText("Card Entry")).toBeNull();
  });
});
