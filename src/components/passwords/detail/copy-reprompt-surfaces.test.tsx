// @vitest-environment jsdom
/**
 * Deny/allow coverage for the two copy funnels that do NOT go through
 * useEntryActions: the accordion card's own handlers and the secure-note body.
 *
 * Both are exercised through their real CopyButton so the assertion lands on the
 * clipboard mutation. The sibling suites stub CopyButton out, which means
 * reverting either guard leaves them green — that gap is why this file exists.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { InlineDetailData } from "@/types/entry";
import { installClipboard, uninstallClipboard } from "@/__tests__/helpers/mock-clipboard";

vi.mock("next-intl", () => ({
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
  useLocale: () => "en",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Stands in for the passphrase dialog so the assertion is about the GATE — can a
// decrypted value reach the clipboard before verification resolves — rather than
// about the dialog's own crypto, which reprompt-dialog tests separately.
const verified: Array<() => void> = [];
const cancelled: Array<() => void> = [];
vi.mock("@/components/passwords/dialogs/reprompt-dialog", () => ({
  RepromptDialog: ({ onVerified, onCancel }: { onVerified: () => void; onCancel: () => void }) => {
    verified.push(onVerified);
    cancelled.push(onCancel);
    return <div data-testid="reprompt-dialog" />;
  },
}));

import { useReprompt } from "@/hooks/vault/use-reprompt";
import { SecureNoteSection } from "./sections/secure-note-section";
import { EntryActionsMenu } from "./entry-actions-menu";

function makeDetail(requireReprompt: boolean, extra: Record<string, unknown> = {}): InlineDetailData {
  return {
    id: "entry-1",
    requireReprompt,
    entryType: "SECURE_NOTE",
    password: "",
    content: "the whole note is the secret",
    url: null,
    urlHost: null,
    notes: null,
    customFields: [],
    passwordHistory: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...extra,
  } as unknown as InlineDetailData;
}

/** Mounts SecureNoteSection the way PasswordDetailInline does. */
function NoteHarness({ detail }: { detail: InlineDetailData }) {
  const { createGuardedGetter, requireVerification, repromptDialog } = useReprompt();
  return (
    <>
      <SecureNoteSection
        data={detail}
        createGuardedGetter={createGuardedGetter}
        requireVerification={requireVerification}
      />
      {repromptDialog}
    </>
  );
}

describe("secure-note body copy honours requireReprompt", () => {
  let clip: ReturnType<typeof installClipboard>;

  beforeEach(() => {
    verified.length = 0;
    cancelled.length = 0;
    clip = installClipboard();
  });
  afterEach(() => uninstallClipboard());

  function clickCopy() {
    // The section renders exactly one copy control for the body.
    const buttons = screen.getAllByRole("button");
    const copy = buttons.find((b) => (b.getAttribute("aria-label") ?? "").includes("copyNamed"));
    (copy ?? buttons[buttons.length - 1]!).click();
  }

  it("does not write the note body until the passphrase is verified", async () => {
    // Reds against the pre-fix section, which declared createGuardedGetter as a
    // prop and never called it — the one entry type whose entire content is the
    // secret copied with no prompt at all.
    render(<NoteHarness detail={makeDetail(true)} />);
    clickCopy();

    await waitFor(() => expect(screen.getByTestId("reprompt-dialog")).toBeInTheDocument());
    expect(clip.writeText).not.toHaveBeenCalled();

    verified[verified.length - 1]!();
    await waitFor(() =>
      expect(clip.writeText).toHaveBeenCalledWith("the whole note is the secret"),
    );
  });

  it("writes nothing when the prompt is declined", async () => {
    render(<NoteHarness detail={makeDetail(true)} />);
    clickCopy();

    await waitFor(() => expect(screen.getByTestId("reprompt-dialog")).toBeInTheDocument());
    cancelled[cancelled.length - 1]!();

    await waitFor(() => expect(screen.queryByTestId("reprompt-dialog")).not.toBeInTheDocument());
    expect(clip.writeText).not.toHaveBeenCalled();
  });

  it("does not prompt for a note the user never marked", async () => {
    // The allow side: fail-closed must not mean a passphrase on every copy.
    render(<NoteHarness detail={makeDetail(false)} />);
    clickCopy();

    await waitFor(() =>
      expect(clip.writeText).toHaveBeenCalledWith("the whole note is the secret"),
    );
    expect(screen.queryByTestId("reprompt-dialog")).not.toBeInTheDocument();
  });
});

/**
 * The accordion card hands its fetchers straight to EntryActionsMenu, which uses
 * them as CopyButton's getValue for the quick-copy control — a path that is NOT
 * the overflow-menu handlers and was unguarded even after those were fixed.
 * This harness reproduces that handoff with the real menu and the real button.
 */
function CardQuickCopyHarness({ requireReprompt }: { requireReprompt: boolean }) {
  const { createGuardedGetter, repromptDialog } = useReprompt();
  const guard = (getter: () => Promise<string> | string) => async () => {
    const value = await getter();
    return createGuardedGetter("entry-1", requireReprompt, () => value)();
  };
  const noop = () => {};
  return (
    <>
      <EntryActionsMenu
        variant="accelerator"
        entryType="LOGIN"
        username="u"
        urlHost={null}
        isArchived={false}
        fetchPassword={guard(async () => "s3cr3t")}
        fetchCardField={async () => ""}
        fetchIdentityField={async () => ""}
        fetchPasskeyField={async () => ""}
        fetchBankField={async () => ""}
        fetchLicenseField={async () => ""}
        fetchSshField={async () => ""}
        onCopyUsername={noop}
        onCopyPassword={noop}
        onCopyContent={noop}
        onCopyCardNumber={noop}
        onCopyCvv={noop}
        onCopyCredentialId={noop}
        onCopyAccountNumber={noop}
        onCopyLicenseKey={noop}
        onCopyFingerprint={noop}
        onCopyPublicKey={noop}
        onCopyIdNumber={noop}
        onOpenUrl={noop}
        t={(key: string) => key}
      />
      {repromptDialog}
    </>
  );
}

describe("accordion quick-copy honours requireReprompt", () => {
  let clip: ReturnType<typeof installClipboard>;

  beforeEach(() => {
    verified.length = 0;
    cancelled.length = 0;
    clip = installClipboard();
  });
  afterEach(() => uninstallClipboard());

  it("does not write until the passphrase is verified", async () => {
    render(<CardQuickCopyHarness requireReprompt />);
    screen.getByRole("button", { name: "copyPassword" }).click();

    await waitFor(() => expect(screen.getByTestId("reprompt-dialog")).toBeInTheDocument());
    expect(clip.writeText).not.toHaveBeenCalled();

    verified[verified.length - 1]!();
    await waitFor(() => expect(clip.writeText).toHaveBeenCalledWith("s3cr3t"));
  });

  it("writes nothing when the prompt is declined", async () => {
    render(<CardQuickCopyHarness requireReprompt />);
    screen.getByRole("button", { name: "copyPassword" }).click();

    await waitFor(() => expect(screen.getByTestId("reprompt-dialog")).toBeInTheDocument());
    cancelled[cancelled.length - 1]!();

    await waitFor(() => expect(screen.queryByTestId("reprompt-dialog")).not.toBeInTheDocument());
    expect(clip.writeText).not.toHaveBeenCalled();
  });

  it("does not prompt for an entry the user never marked", async () => {
    render(<CardQuickCopyHarness requireReprompt={false} />);
    screen.getByRole("button", { name: "copyPassword" }).click();

    await waitFor(() => expect(clip.writeText).toHaveBeenCalledWith("s3cr3t"));
    expect(screen.queryByTestId("reprompt-dialog")).not.toBeInTheDocument();
  });
});
