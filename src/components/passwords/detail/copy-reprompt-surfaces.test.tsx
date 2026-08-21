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
 * NOT COVERED — the accordion card's quick-copy.
 *
 * An earlier version of this file had a harness here that re-implemented
 * password-card.tsx's `guard` helper instead of rendering the card, so stripping
 * all seven wraps from production left it green. It proved the helper's shape,
 * not that production uses it, which is worse than no test: a vacuous case reads
 * as coverage. It was removed rather than left in place.
 *
 * Rendering the real PasswordCard here hangs — the import alone does, before any
 * assertion runs — and diagnosing that is its own task. The production guard IS
 * applied (password-card.tsx wraps all seven fetchers it hands to
 * EntryActionsMenu, plus the eleven overflow-menu handlers via runCopy), and the
 * same gate is proven end-to-end on the secure-note surface above and on the
 * row/menu surface in use-entry-actions-reprompt.test.tsx. What is missing is a
 * regression pin specific to the card: removing a wrap there reds nothing today.
 */
it.todo("accordion quick-copy: deny/allow through the real PasswordCard render");
