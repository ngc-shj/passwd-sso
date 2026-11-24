import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";

vi.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));
vi.mock("@/components/settings/vault-action-card", () => ({ VaultActionCard: () => null }));
vi.mock("@/components/vault/recovery-key-dialog", () => ({ RecoveryKeyDialog: () => null }));

import RecoveryKeyPage from "./page";
import { KeyRound } from "lucide-react";
import { VaultActionCard } from "@/components/settings/vault-action-card";
import { RecoveryKeyDialog } from "@/components/vault/recovery-key-dialog";

describe("RecoveryKeyPage", () => {
  it("opens the recovery-key dialog from the vault action card", () => {
    const el = RecoveryKeyPage() as ReactElement<Record<string, unknown>>;
    expect(el.type).toBe(VaultActionCard);
    expect(el.props.Dialog).toBe(RecoveryKeyDialog);
  });

  it("labels the card with the recovery-key strings from the Vault namespace", () => {
    const el = RecoveryKeyPage() as ReactElement<Record<string, unknown>>;
    expect(el.props).toMatchObject({
      title: "Vault.recoveryKey",
      description: "Vault.recoveryKeyDialogDescription",
      buttonLabel: "Vault.recoveryKey",
    });
  });

  it("uses the KeyRound icon for the card and its button", () => {
    const el = RecoveryKeyPage() as ReactElement<Record<string, unknown>>;
    expect(el.props.icon).toBe(KeyRound);
    expect(el.props.buttonIcon).toBe(KeyRound);
  });
});
