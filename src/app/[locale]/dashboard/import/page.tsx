"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { ImportPagePanel } from "@/components/passwords/password-import";

export default function ImportPage() {
  const router = useRouter();

  const handleComplete = useCallback(() => {
    window.dispatchEvent(new Event("vault-data-changed"));
    router.refresh();
  }, [router]);

  return <ImportPagePanel onComplete={handleComplete} />;
}
