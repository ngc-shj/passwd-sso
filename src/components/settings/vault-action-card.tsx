"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Lock as LockIcon } from "lucide-react";
import { useVault } from "@/lib/vault/vault-context";
import { VAULT_STATUS } from "@/lib/constants";
import { Card, CardContent } from "@/components/ui/card";
import { SectionCardHeader } from "@/components/settings/account/section-card-header";
import { Button } from "@/components/ui/button";

type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

interface VaultActionCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
  buttonIcon: LucideIcon;
  buttonLabel: string;
  Dialog: (props: DialogProps) => ReactNode;
}

/**
 * Settings page card that gates a vault-sensitive dialog behind an unlocked
 * vault. When status is LOCKED the action button is disabled and a hint is
 * shown; during LOADING the layout is identical so reload doesn't flash.
 */
export function VaultActionCard({
  icon,
  title,
  description,
  buttonIcon: ButtonIcon,
  buttonLabel,
  Dialog,
}: VaultActionCardProps) {
  const tSettings = useTranslations("Settings");
  const { status: vaultStatus } = useVault();
  const [dialogOpen, setDialogOpen] = useState(false);

  const vaultUnlocked = vaultStatus === VAULT_STATUS.UNLOCKED;
  const vaultLocked = vaultStatus === VAULT_STATUS.LOCKED;

  return (
    <>
      <Card>
        <SectionCardHeader icon={icon} title={title} description={description} />
        <CardContent>
          <Button size="sm" disabled={!vaultUnlocked} onClick={() => setDialogOpen(true)}>
            <ButtonIcon className="h-4 w-4 mr-2" />
            {buttonLabel}
          </Button>
          {vaultLocked && (
            <p className="mt-2 text-xs text-muted-foreground flex items-center gap-1">
              <LockIcon className="h-3 w-3" />
              {tSettings("vaultLockedPlaceholder.description")}
            </p>
          )}
        </CardContent>
      </Card>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
