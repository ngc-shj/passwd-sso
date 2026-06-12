/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
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

  it("shows no entries when tabUrl is null (non-web page) — all types hidden without query", async () => {
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

  // A3a: PASSKEY entry appears in search results as display-only (badge shown, no Fill/Copy/TOTP)
  it("A3a: PASSKEY entry appears in search results as a display-only row with badge", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "pk-1",
          title: "My Passkey Account",
          username: "alice@example.com",
          urlHost: "example.com",
          entryType: EXT_ENTRY_TYPE.PASSKEY,
        },
      ],
    });

    render(<MatchList tabUrl="https://example.com" />);
    const input = await screen.findByPlaceholderText("Search...");
    fireEvent.change(input, { target: { value: "passkey account" } });

    expect(await screen.findByText("My Passkey Account")).toBeInTheDocument();
    expect(screen.getByText("Passkey")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fill" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    expect(screen.queryByRole("button", { name: "TOTP" })).toBeNull();
  });

  // A3b: With empty query, PASSKEY entry is absent from the rendered output
  it("A3b: PASSKEY entry is absent from default view (empty query)", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "login-1",
          title: "Regular Login",
          username: "alice",
          urlHost: "example.com",
          entryType: EXT_ENTRY_TYPE.LOGIN,
        },
        {
          id: "pk-1",
          title: "My Passkey Account",
          username: "alice@example.com",
          urlHost: "example.com",
          entryType: EXT_ENTRY_TYPE.PASSKEY,
        },
      ],
    });

    render(<MatchList tabUrl="https://example.com" />);
    await screen.findByText("Regular Login");
    expect(screen.queryByText("My Passkey Account")).toBeNull();
  });

  // A4: Empty query renders site-context header, matched/other sections; no search results header
  it("A4: empty query renders site-context header and hides search results header", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "login-1",
          title: "Example Login",
          username: "alice",
          urlHost: "example.com",
          entryType: EXT_ENTRY_TYPE.LOGIN,
        },
        {
          id: "card-1",
          title: "My Card",
          username: "",
          urlHost: "",
          entryType: EXT_ENTRY_TYPE.CREDIT_CARD,
        },
        {
          id: "other-login",
          title: "Other Site Login",
          username: "bob",
          urlHost: "other.com",
          entryType: EXT_ENTRY_TYPE.LOGIN,
        },
      ],
    });

    render(<MatchList tabUrl="https://example.com" />);
    await screen.findByText("Example Login");

    expect(screen.getByText("Matches for example.com")).toBeInTheDocument();
    expect(screen.getByText("Other entries")).toBeInTheDocument();
    expect(screen.queryByText("Search results")).toBeNull();
    expect(screen.queryByText("Other Site Login")).toBeNull();
  });

  // A5: Tab-matching entry precedes non-matching entry in DOM order during search
  it("A5: tab-matching entry precedes cross-domain entry in search results", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "other-1",
          title: "GitLab",
          username: "bob",
          urlHost: "gitlab.com",
          entryType: EXT_ENTRY_TYPE.LOGIN,
        },
        {
          id: "match-1",
          title: "GitHub",
          username: "alice",
          urlHost: "github.com",
          entryType: EXT_ENTRY_TYPE.LOGIN,
        },
      ],
    });

    render(<MatchList tabUrl="https://github.com" />);
    const input = await screen.findByPlaceholderText("Search...");
    fireEvent.change(input, { target: { value: "git" } });

    await screen.findByText("GitHub");
    const titles = screen.getAllByRole("listitem").map((li) => li.textContent);
    const githubIdx = titles.findIndex((t) => t?.includes("GitHub"));
    const gitlabIdx = titles.findIndex((t) => t?.includes("GitLab"));
    expect(githubIdx).toBeLessThan(gitlabIdx);
  });

  // A8: Non-empty query renders search results header; site-context header absent; header present even when empty
  it("A8: search results header renders when searching; site-context header suppressed", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "login-1",
          title: "Example",
          username: "alice",
          urlHost: "example.com",
          entryType: EXT_ENTRY_TYPE.LOGIN,
        },
      ],
    });

    render(<MatchList tabUrl="https://example.com" />);
    const input = await screen.findByPlaceholderText("Search...");
    fireEvent.change(input, { target: { value: "zzznomatch" } });

    const header = await screen.findByText("Search results");
    expect(screen.queryByText(/Matches for/)).toBeNull();
    const noResults = screen.getByText(/no results for/i);
    // I7: the no-results message appears beneath the header
    expect(
      header.compareDocumentPosition(noResults) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // A9a: Cross-domain LOGIN search result has Copy and TOTP but no Fill (row-scoped)
  it("A9a: cross-domain LOGIN search result has Copy and TOTP but no Fill", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "aws-1",
          title: "AWS Console",
          username: "alice",
          urlHost: "aws.amazon.com",
          entryType: EXT_ENTRY_TYPE.LOGIN,
        },
      ],
    });

    render(<MatchList tabUrl="https://github.com" />);
    const input = await screen.findByPlaceholderText("Search...");
    fireEvent.change(input, { target: { value: "aws" } });

    const title = await screen.findByText("AWS Console");
    const row = title.closest("li") as HTMLElement;
    const rowScope = within(row);
    expect(rowScope.queryByRole("button", { name: "Fill" })).toBeNull();
    expect(rowScope.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(rowScope.getByRole("button", { name: "TOTP" })).toBeInTheDocument();
  });

  // A9b: CREDIT_CARD search result on a web page has Fill button (row-scoped)
  it("A9b: CREDIT_CARD search result on a web page has Fill button", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "card-1",
          title: "Visa Card",
          username: "",
          urlHost: "",
          entryType: EXT_ENTRY_TYPE.CREDIT_CARD,
        },
      ],
    });

    render(<MatchList tabUrl="https://shop.example.com" />);
    const input = await screen.findByPlaceholderText("Search...");
    fireEvent.change(input, { target: { value: "visa" } });

    const title = await screen.findByText("Visa Card");
    const row = title.closest("li") as HTMLElement;
    const rowScope = within(row);
    expect(rowScope.getByRole("button", { name: "Fill" })).toBeInTheDocument();
    // I7: the "Other entries" header is suppressed while searching
    expect(screen.queryByText("Other entries")).toBeNull();
  });

  // A1: cross-site LOGIN entry appears in search results and no-results is suppressed
  it("A1: cross-site LOGIN entry appears when searching from a different tab host", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "gh-1",
          title: "GitHub",
          username: "alice",
          urlHost: "github.com",
          entryType: EXT_ENTRY_TYPE.LOGIN,
        },
        {
          id: "aws-1",
          title: "AWS Console",
          username: "bob",
          urlHost: "aws.amazon.com",
          entryType: EXT_ENTRY_TYPE.LOGIN,
        },
      ],
    });

    render(<MatchList tabUrl="https://github.com" />);
    const input = await screen.findByPlaceholderText("Search...");
    fireEvent.change(input, { target: { value: "aws" } });

    expect(await screen.findByText("AWS Console")).toBeInTheDocument();
    expect(screen.queryByText(/no results for/i)).toBeNull();
    expect(screen.getByText("Search results")).toBeInTheDocument();
  });

  // A2: tabUrl=null with query renders matching entries; no Fill buttons; Copy available for LOGIN
  it("A2: search with tabUrl=null renders matching entries without Fill buttons", async () => {
    mockSendMessage.mockResolvedValueOnce({
      type: "FETCH_PASSWORDS",
      entries: [
        {
          id: "bank-1",
          title: "Bank Login",
          username: "alice",
          urlHost: "bank.example.com",
          entryType: EXT_ENTRY_TYPE.LOGIN,
        },
      ],
    });

    render(<MatchList tabUrl={null} />);
    const input = await screen.findByPlaceholderText("Search...");
    fireEvent.change(input, { target: { value: "bank" } });

    expect(await screen.findByText("Bank Login")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fill" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });
});
