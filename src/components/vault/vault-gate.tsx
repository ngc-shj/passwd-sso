"use client";

import { useVault } from "@/lib/vault-context";
import { VaultSetupWizard } from "./vault-setup-wizard";
import { VaultLockScreen } from "./vault-lock-screen";
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
 */
export function VaultGate({ children }: VaultGateProps) {
  const { status } = useVault();

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (status === "setup-required") {
    return <VaultSetupWizard />;
  }

  if (status === "locked") {
    return <VaultLockScreen />;
  }

  return <>{children}</>;
}
