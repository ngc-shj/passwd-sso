// @vitest-environment jsdom
// Renders the page under the real next-intl provider with exactly the messages
// the vault-reset layout loads, so a string from a namespace the layout omits
// shows up as its "Namespace.key" fallback instead of being hidden by an
// identity translator mock (page.test.tsx).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { loadNamespaces } from "@/i18n/messages";
import { NS_VAULT_RESET } from "@/i18n/namespace-groups";
import { VAULT_CONFIRMATION_PHRASE } from "@/lib/constants/vault";
import enAuth from "../../../../messages/en/Auth.json";
import enVaultReset from "../../../../messages/en/VaultReset.json";

const { mockFetch, mockCanUsePasskeyRecovery } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockCanUsePasskeyRecovery: vi.fn(),
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
  withBasePath: (p: string) => p,
  hardNavigate: vi.fn(),
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));

vi.mock("@/lib/auth/webauthn/can-use-passkey-recovery", () => ({
  canUsePasskeyRecovery: mockCanUsePasskeyRecovery,
}));

import VaultResetPage from "./page";

async function renderWithLayoutMessages() {
  const messages = await loadNamespaces("en", NS_VAULT_RESET);
  render(
    <NextIntlClientProvider
      locale="en"
      messages={messages}
      onError={() => {}}
    >
      <VaultResetPage />
    </NextIntlClientProvider>,
  );
}

describe("VaultResetPage with the vault-reset layout's messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
  });

  it("renders its own heading from the loaded VaultReset namespace", async () => {
    await renderWithLayoutMessages();
    expect(
      screen.getByRole("heading", { name: enVaultReset.title }),
    ).toBeInTheDocument();
  });

  it("titles the step-up dialog with the translated Auth copy", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
    });
    await renderWithLayoutMessages();

    fireEvent.change(screen.getByLabelText(enVaultReset.confirmationLabel), {
      target: { value: VAULT_CONFIRMATION_PHRASE.DELETE_VAULT },
    });
    fireEvent.click(screen.getByRole("button", { name: enVaultReset.resetButton }));

    expect(
      await screen.findByRole("alertdialog", { name: enAuth.recentSessionTitle }),
    ).toBeInTheDocument();
  });
});
