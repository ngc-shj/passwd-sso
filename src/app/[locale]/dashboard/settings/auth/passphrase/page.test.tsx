import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";

vi.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));
vi.mock("@/components/settings/vault-action-card", () => ({ VaultActionCard: () => null }));
vi.mock("@/components/vault/change-passphrase-dialog", () => ({ ChangePassphraseDialog: () => null }));

import PassphrasePage from "./page";
import { Lock } from "lucide-react";
import { VaultActionCard } from "@/components/settings/vault-action-card";
import { ChangePassphraseDialog } from "@/components/vault/change-passphrase-dialog";

describe("PassphrasePage", () => {
  it("opens the change-passphrase dialog from the vault action card", () => {
    const el = PassphrasePage() as ReactElement<Record<string, unknown>>;
    expect(el.type).toBe(VaultActionCard);
    expect(el.props.Dialog).toBe(ChangePassphraseDialog);
  });

  it("labels the card with the change-passphrase strings from the Vault namespace", () => {
    const el = PassphrasePage() as ReactElement<Record<string, unknown>>;
    expect(el.props).toMatchObject({
      title: "Vault.changePassphrase",
      description: "Vault.changePassphraseDescription",
      buttonLabel: "Vault.changePassphraseButton",
    });
  });

  it("uses the Lock icon for the card and its button", () => {
    const el = PassphrasePage() as ReactElement<Record<string, unknown>>;
    expect(el.props.icon).toBe(Lock);
    expect(el.props.buttonIcon).toBe(Lock);
  });
});
