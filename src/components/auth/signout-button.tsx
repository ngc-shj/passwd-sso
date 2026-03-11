"use client";

import { useTranslations } from "next-intl";
import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";
import { withBasePath } from "@/lib/url-helpers";

export function SignOutButton() {
  const t = useTranslations("Auth");

  const handleSignOut = () => {
    signOut({ callbackUrl: withBasePath("/auth/signin") });
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleSignOut}
      className="gap-2"
    >
      <LogOut className="h-4 w-4" />
      {t("signOut")}
    </Button>
  );
}
