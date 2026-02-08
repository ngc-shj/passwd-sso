"use client";

import { useTranslations } from "next-intl";
import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";

export function SignOutButton() {
  const t = useTranslations("Auth");

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => signOut({ callbackUrl: "/auth/signin" })}
      className="gap-2"
    >
      <LogOut className="h-4 w-4" />
      {t("signOut")}
    </Button>
  );
}
