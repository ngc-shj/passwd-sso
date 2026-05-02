"use client";

import { useState } from "react";
import { Header } from "./header";
import { Sidebar } from "./sidebar";
import { RecoveryKeyBanner } from "@/components/vault/recovery-key-banner";
import { DelegationRevokeBanner } from "@/components/vault/delegation-revoke-banner";
import { MigrationBanner } from "@/components/settings/migration-banner";
import { ActiveVaultProvider } from "@/lib/vault/active-vault-context";
import { TravelModeProvider } from "@/hooks/use-travel-mode";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <ActiveVaultProvider>
      <TravelModeProvider>
        <div className="fixed inset-0 flex flex-col overflow-hidden">
          <Header onMenuToggle={() => setSidebarOpen(true)} />
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <Sidebar open={sidebarOpen} onOpenChange={setSidebarOpen} />
            <main className="min-h-0 flex-1 overflow-auto">
              <MigrationBanner />
              <RecoveryKeyBanner />
              <DelegationRevokeBanner />
              {children}
            </main>
          </div>
        </div>
      </TravelModeProvider>
    </ActiveVaultProvider>
  );
}
