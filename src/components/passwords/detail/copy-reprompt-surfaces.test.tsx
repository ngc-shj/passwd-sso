// @vitest-environment jsdom
/**
 * Deny/allow coverage for the SECURE-NOTE copy funnel, which does not go through
 * useEntryActions.
 *
 * It is exercised through the real SecureNoteSection and the real CopyButton, so
 * the assertion lands on the clipboard mutation and reverting the guard reds it.
 * The sibling suites stub CopyButton out, which is why this file exists.
 *
 * The accordion card's funnel is covered in password-card.test.tsx (see the
 * note at the end of this file).
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

// The accordion card's quick-copy funnel is covered by password-card.test.tsx,
// which renders the real PasswordCard: "withholds a reprompt-protected password
// until the passphrase is verified", "writes nothing and reports nothing when the
// reprompt is declined" and "gates the quick-copy getter behind the reprompt".
