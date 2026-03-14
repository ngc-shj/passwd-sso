"use client";

import { useVault } from "@/lib/vault-context";
import { VAULT_STATUS } from "@/lib/constants";
import { VaultSetupWizard } from "./vault-setup-wizard";
import { VaultLockScreen } from "./vault-lock-screen";
import { AutoExtensionConnect } from "@/components/extension/auto-extension-connect";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";

interface VaultGateProps {
  children: React.ReactNode;
}

/**
 * Wraps dashboard content and shows the appropriate vault screen:
 * - Loading spinner while checking vault status
 * - Setup wizard if vault is not yet configured
 * - Lock screen if vault is locked
 * - Children if vault is unlocked
 *
 * When the current URL is a team/emergency-access invite page,
 * a contextual message is shown alongside the setup wizard so
 * the user understands why vault setup is required.
 */
export function VaultGate({ children }: VaultGateProps) {
  const { status } = useVault();
  const pathname = usePathname();
  const t = useTranslations("Vault");

  if (status === VAULT_STATUS.LOADING) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (status === VAULT_STATUS.SETUP_REQUIRED) {
    // Detect invite routes to show contextual guidance.
    // Uses usePathname() intentionally — the route paths are stable
    // and App Router layouts cannot pass props to child pages.
    const isInvitePage = /\/dashboard\/(teams|emergency-access)\/invite\//.test(pathname);
    const contextMessage = isInvitePage ? t("setupInviteContext") : undefined;

    return <VaultSetupWizard contextMessage={contextMessage} />;
  }

  if (status === VAULT_STATUS.LOCKED) {
    return <VaultLockScreen />;
  }

  return (
    <>
      <AutoExtensionConnect />
      {children}
    </>
  );
}
