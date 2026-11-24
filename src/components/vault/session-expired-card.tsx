"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LogIn } from "lucide-react";

export function SessionExpiredCard() {
  const t = useTranslations("Vault");
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-muted/30 to-background p-4">
      <Card className="w-full max-w-sm rounded-xl border">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <LogIn className="h-6 w-6 text-muted-foreground" />
          </div>
          <CardTitle>{t("sessionExpired")}</CardTitle>
          <CardDescription>{t("sessionExpiredDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            className="w-full"
            onClick={() => router.push("/auth/signin")}
          >
            <LogIn className="h-4 w-4 mr-2" />
            {t("goToSignIn")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
