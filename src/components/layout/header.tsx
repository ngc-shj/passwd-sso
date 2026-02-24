"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { useTranslations } from "next-intl";
import { Building2, KeyRound, Lock, Menu, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UserAvatar } from "@/components/auth/user-avatar";
import { SignOutButton } from "@/components/auth/signout-button";
import { LanguageSwitcher } from "./language-switcher";
import { useVault } from "@/lib/vault-context";
import { APP_NAME, VAULT_STATUS } from "@/lib/constants";
import { ChangePassphraseDialog } from "@/components/vault/change-passphrase-dialog";
import { RecoveryKeyDialog } from "@/components/vault/recovery-key-dialog";
import { useActiveVault } from "@/lib/active-vault-context";

interface HeaderProps {
  onMenuToggle: () => void;
}

export function Header({ onMenuToggle }: HeaderProps) {
  const { data: session } = useSession();
  const { status: vaultStatus, lock } = useVault();
  const t = useTranslations("Vault");
  const tDash = useTranslations("Dashboard");
  const activeVault = useActiveVault();
  const [mounted, setMounted] = useState(false);
  const [changePassOpen, setChangePassOpen] = useState(false);
  const [recoveryKeyOpen, setRecoveryKeyOpen] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  return (
    <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-14 items-center gap-4 px-4">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={onMenuToggle}
        >
          <Menu className="h-5 w-5" />
        </Button>

        {activeVault && (
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground md:hidden">
            {activeVault.type === "personal" ? (
              <>
                <Lock className="h-4 w-4 shrink-0" />
                <span className="truncate max-w-[8rem]">
                  {tDash("personalVaultShort")}
                </span>
              </>
            ) : (
              <>
                <Building2 className="h-4 w-4 shrink-0" />
                <span className="truncate max-w-[8rem]">
                  {activeVault.orgName}
                </span>
              </>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 font-semibold">
          <KeyRound className="h-5 w-5" />
          <span className="hidden sm:inline">{APP_NAME}</span>
        </div>

        <div className="flex-1" />

        {mounted && <LanguageSwitcher />}

        {mounted ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="gap-2 px-2">
                <UserAvatar />
                <span className="hidden sm:inline text-sm">
                  {session?.user?.name}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem className="text-xs text-muted-foreground" disabled>
                {session?.user?.email}
              </DropdownMenuItem>
              {vaultStatus === VAULT_STATUS.UNLOCKED && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setChangePassOpen(true)}>
                    <RefreshCw className="h-4 w-4" />
                    {t("changePassphrase")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setRecoveryKeyOpen(true)}>
                    <ShieldCheck className="h-4 w-4" />
                    {t("recoveryKey")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={lock}>
                    <Lock className="h-4 w-4" />
                    {t("lockVault")}
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <SignOutButton />
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button variant="ghost" className="gap-2 px-2">
            <div className="h-8 w-8 rounded-full bg-muted animate-pulse" />
          </Button>
        )}
      </div>
      <ChangePassphraseDialog
        open={changePassOpen}
        onOpenChange={setChangePassOpen}
      />
      <RecoveryKeyDialog
        open={recoveryKeyOpen}
        onOpenChange={setRecoveryKeyOpen}
      />
    </header>
  );
}
