"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { ImportDialog } from "@/components/passwords/import-dialog";

export default function ImportPage() {
  const router = useRouter();

  const handleComplete = useCallback(() => {
    window.dispatchEvent(new Event("vault-data-changed"));
    router.refresh();
  }, [router]);

  return <ImportDialog mode="page" onComplete={handleComplete} />;
}

