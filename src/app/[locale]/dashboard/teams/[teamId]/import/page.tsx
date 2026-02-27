"use client";

import { useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { TeamImportPagePanel } from "@/components/passwords/password-import";

export default function TeamImportPage() {
  const params = useParams<{ teamId: string }>();
  const router = useRouter();

  const handleComplete = useCallback(() => {
    window.dispatchEvent(new Event("vault-data-changed"));
    router.refresh();
  }, [router]);

  return (
    <TeamImportPagePanel
      teamId={params.teamId}
      onComplete={handleComplete}
    />
  );
}
