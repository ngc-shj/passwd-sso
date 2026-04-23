"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault/vault-context";
import { API_PATH } from "@/lib/constants/auth/api-path";
import { fetchApi } from "@/lib/url-helpers";
import { VAULT_STATUS } from "@/lib/constants";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Shield } from "lucide-react";

export function DelegationRevokeBanner() {
  const t = useTranslations("MachineIdentity.delegation");
  const { status } = useVault();
  const router = useRouter();
  const [count, setCount] = useState(0);

  const fetchCount = useCallback(async (): Promise<number | undefined> => {
    try {
      const res = await fetchApi(API_PATH.VAULT_DELEGATION);
      if (!res.ok) return undefined;
      const data = await res.json();
      return data.sessions?.length ?? 0;
    } catch {
      return undefined;
    }
  }, []);

  useEffect(() => {
    if (status !== VAULT_STATUS.UNLOCKED) return;
    let cancelled = false;
    const load = async () => {
      const n = await fetchCount();
      if (!cancelled && n !== undefined) setCount(n);
    };
    load();
    const interval = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [status, fetchCount]);

  if (count === 0) return null;

  return (
    <div className="mx-4 mt-4 flex items-center gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm md:mx-6 md:mt-6">
      <Shield className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <p className="flex-1 text-amber-800 dark:text-amber-300">
        {t("bannerActive", { count })}
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => router.push("/dashboard/settings/mcp/delegation")}
      >
        {t("bannerManage")}
      </Button>
    </div>
  );
}
