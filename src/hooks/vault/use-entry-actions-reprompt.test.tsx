// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useEntryActions } from "./use-entry-actions";
import type { DisplayEntry } from "@/components/passwords/detail/password-list";
import type { InlineDetailData } from "@/types/entry";
import { installClipboard, uninstallClipboard } from "@/__tests__/helpers/mock-clipboard";

vi.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
  useLocale: () => "en",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The real dialog needs the vault context to verify a passphrase. Standing in
// for it keeps this test about the GATE — whether a decrypted value can reach
// the clipboard before verification resolves — rather than about the dialog's
// own crypto, which reprompt-dialog has its own tests for.
const verified: Array<() => void> = [];
const cancelled: Array<() => void> = [];
vi.mock("@/components/passwords/dialogs/reprompt-dialog", () => ({
  RepromptDialog: ({ onVerified, onCancel }: { onVerified: () => void; onCancel: () => void }) => {
    verified.push(onVerified);
    cancelled.push(onCancel);
    return <div data-testid="reprompt-dialog" />;
  },
}));

function makeDetail(requireReprompt: boolean): InlineDetailData {
  return {
    id: "entry-1",
    requireReprompt,
    entryType: "LOGIN",
    password: "s3cr3t",
    url: null,
    urlHost: null,
    notes: null,
    customFields: [],
    passwordHistory: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  } as unknown as InlineDetailData;
}

const entry = { id: "entry-1", username: "u" } as unknown as DisplayEntry;

/** Renders the hook exactly as EntryListView does: callbacks plus a mounted dialog. */
function Harness({ detail }: { detail: InlineDetailData }) {
  const { buildCallbacks, repromptDialog } = useEntryActions(() => async () => detail);
  const callbacks = buildCallbacks(entry);
  return (
    <>
      <button onClick={() => callbacks.onCopyPassword()}>copy</button>
      {repromptDialog}
    </>
  );
}

describe("row / overflow-menu copy honours requireReprompt", () => {
  let clip: ReturnType<typeof installClipboard>;

  beforeEach(() => {
    verified.length = 0;
    cancelled.length = 0;
    clip = installClipboard();
  });
  afterEach(() => uninstallClipboard());

  it("does not write the secret until the passphrase is verified", async () => {
    // Reds against the pre-fix hook, which passed the raw getter straight to the
    // clipboard: the row and ⋮ menu released a decrypted secret from an entry the
    // user had explicitly marked, with no prompt at all.
    render(<Harness detail={makeDetail(true)} />);
    screen.getByText("copy").click();

    await waitFor(() => expect(screen.getByTestId("reprompt-dialog")).toBeDefined());
    expect(clip.writeText).not.toHaveBeenCalled();

    verified[verified.length - 1]!();
    await waitFor(() => expect(clip.writeText).toHaveBeenCalledWith("s3cr3t"));
  });

  it("writes nothing and stays silent when the prompt is declined", async () => {
    render(<Harness detail={makeDetail(true)} />);
    screen.getByText("copy").click();

    await waitFor(() => expect(screen.getByTestId("reprompt-dialog")).toBeDefined());
    cancelled[cancelled.length - 1]!();

    await waitFor(() => expect(screen.queryByTestId("reprompt-dialog")).toBeNull());
    expect(clip.writeText).not.toHaveBeenCalled();
  });

  it("does not prompt for an entry the user never marked", async () => {
    // The allow side: fail-closed must not mean a passphrase on every copy.
    render(<Harness detail={makeDetail(false)} />);
    screen.getByText("copy").click();

    await waitFor(() => expect(clip.writeText).toHaveBeenCalledWith("s3cr3t"));
    expect(screen.queryByTestId("reprompt-dialog")).toBeNull();
  });
});
