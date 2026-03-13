"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { ImportPagePanel } from "@/components/passwords/password-import";
import { notifyVaultDataChanged } from "@/lib/events";

export default function ImportPage() {
  const router = useRouter();

  const handleComplete = useCallback(() => {
    notifyVaultDataChanged();
    router.refresh();
  }, [router]);

  return <ImportPagePanel onComplete={handleComplete} />;
}
