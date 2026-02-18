"use client";

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useVault } from "@/lib/vault-context";

interface RepromptDialogProps {
  open: boolean;
  onVerified: () => void;
  onCancel: () => void;
}

export function RepromptDialog({ open, onVerified, onCancel }: RepromptDialogProps) {
  const t = useTranslations("RepromptDialog");
  const { verifyPassphrase } = useVault();
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState(false);
  const [verifying, setVerifying] = useState(false);

  const handleVerify = useCallback(async () => {
    if (!passphrase || verifying) return;
    setVerifying(true);
    setError(false);
    try {
      const ok = await verifyPassphrase(passphrase);
      if (ok) {
        setPassphrase("");
        onVerified();
      } else {
        setError(true);
      }
    } finally {
      setVerifying(false);
    }
  }, [passphrase, verifying, verifyPassphrase, onVerified]);

  const handleCancel = useCallback(() => {
    setPassphrase("");
    setError(false);
    onCancel();
  }, [onCancel]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleVerify();
      }
    },
    [handleVerify],
  );

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !verifying) handleCancel(); }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reprompt-passphrase">{t("label")}</Label>
          <Input
            id="reprompt-passphrase"
            type="password"
            value={passphrase}
            onChange={(e) => {
              setPassphrase(e.target.value);
              setError(false);
            }}
            onKeyDown={handleKeyDown}
            autoFocus
            autoComplete="off"
          />
          {error && (
            <p className="text-destructive text-sm">{t("incorrect")}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={verifying}>
            {t("cancel")}
          </Button>
          <Button onClick={handleVerify} disabled={!passphrase || verifying}>
            {t("verify")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
