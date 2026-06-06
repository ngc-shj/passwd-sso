// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useEntryActions } from "./use-entry-actions";
import type { DisplayEntry } from "@/components/passwords/detail/password-list";
import type { InlineDetailData } from "@/types/entry";
import * as sonner from "sonner";

vi.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
  useLocale: () => "en",
}));

// The hook is vault-agnostic: it takes a `getDetailFor(entry) => () => Promise<detail>`.
// These stubs play the role buildPersonalGetDetail / createDetailFetcher play in production.
const decryptedDetail = {
  id: "entry-1",
  password: "s3cr3t",
  content: "note content",
  url: "https://example.com",
  urlHost: "example.com",
  notes: null,
  cardNumber: "4111111111111111",
  cvv: "123",
  idNumber: "ID123",
  credentialId: "cred-abc",
  username: "user@example.com",
  accountNumber: "00012345",
  routingNumber: "021000021",
  licenseKey: "XXXX-YYYY",
  fingerprint: "ab:cd:ef",
  publicKey: "ssh-rsa AAAA...",
  customFields: [],
  passwordHistory: [],
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
} as unknown as InlineDetailData;

const getDetailFor = () => async () => decryptedDetail;
const lockedGetDetailFor = () => async (): Promise<InlineDetailData> => {
  throw new Error("Vault locked");
};

const minimalEntry: DisplayEntry = {
  id: "entry-1",
  entryType: "LOGIN",
  title: "Test",
  username: "user@example.com",
  urlHost: "example.com",
  snippet: null,
  brand: null,
  lastFour: null,
  cardholderName: null,
  fullName: null,
  idNumberLast4: null,
  relyingPartyId: null,
  bankName: null,
  accountNumberLast4: null,
  softwareName: null,
  licensee: null,
  keyType: null,
  fingerprint: null,
  tags: [],
  isFavorite: false,
  isArchived: false,
  requireReprompt: false,
  travelSafe: false,
  expiresAt: null,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};


describe("useEntryActions", () => {
  let writeText: ReturnType<typeof vi.fn>;
  let readText: ReturnType<typeof vi.fn>;
  let toastSuccess: ReturnType<typeof vi.spyOn>;
  let toastError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    readText = vi.fn().mockResolvedValue("");
    Object.assign(navigator, {
      clipboard: { writeText, readText },
    });
    toastSuccess = vi.spyOn(sonner.toast, "success").mockImplementation(() => "");
    toastError = vi.spyOn(sonner.toast, "error").mockImplementation(() => "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Flush multiple rounds of microtasks for fire-and-forget async chains.
  const flush = async () => {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  };

  it("onCopyPassword writes to clipboard and shows success toast", async () => {
    const { result } = renderHook(() => useEntryActions(getDetailFor));
    const callbacks = result.current(minimalEntry);

    callbacks.onCopyPassword();
    await flush();

    expect(writeText).toHaveBeenCalledWith("s3cr3t");
    expect(toastSuccess).toHaveBeenCalledWith("CopyButton.copied");
  });

  it("onCopyUsername writes username to clipboard and shows success toast", async () => {
    const { result } = renderHook(() => useEntryActions(getDetailFor));
    const callbacks = result.current(minimalEntry);

    callbacks.onCopyUsername();
    await flush();

    expect(writeText).toHaveBeenCalledWith("user@example.com");
    expect(toastSuccess).toHaveBeenCalledWith("CopyButton.copied");
  });

  it("onCopyUsername is a no-op when entry has no username", async () => {
    const entryNoUser: DisplayEntry = { ...minimalEntry, username: null };
    const { result } = renderHook(() => useEntryActions(getDetailFor));
    const callbacks = result.current(entryNoUser);

    callbacks.onCopyUsername();
    await flush();

    expect(writeText).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("schedules clipboard clear after CLIPBOARD_CLEAR_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    // readText returns the copied value so the clear condition fires
    readText.mockResolvedValue("s3cr3t");

    const { result } = renderHook(() => useEntryActions(getDetailFor));
    const callbacks = result.current(minimalEntry);

    callbacks.onCopyPassword();
    await flush();

    // Advance past CLIPBOARD_CLEAR_TIMEOUT_MS (30_000ms)
    await vi.runAllTimersAsync();

    // clipboard.writeText called twice: once for the value, once for the clear
    expect(writeText).toHaveBeenLastCalledWith("");

    vi.useRealTimers();
  });

  it("shows networkError toast when getDetailFor rejects (locked vault / fetch failure)", async () => {
    const { result } = renderHook(() => useEntryActions(lockedGetDetailFor));
    const callbacks = result.current(minimalEntry);

    callbacks.onCopyPassword();
    await flush();

    expect(writeText).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("PasswordCard.networkError");
  });

  it("onOpenUrl opens a window when url is present", async () => {
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);
    const { result } = renderHook(() => useEntryActions(getDetailFor));
    const callbacks = result.current(minimalEntry);

    await callbacks.onOpenUrl();

    expect(windowOpen).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");
    windowOpen.mockRestore();
  });

  it("fetchPassword resolves the decrypted password", async () => {
    const { result } = renderHook(() => useEntryActions(getDetailFor));
    const callbacks = result.current(minimalEntry);

    const pw = await callbacks.fetchPassword();
    expect(pw).toBe("s3cr3t");
  });
});
