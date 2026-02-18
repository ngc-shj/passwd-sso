"use client";

import { useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { OrgImportPagePanel } from "@/components/passwords/import-dialog";

export default function OrgImportPage() {
  const params = useParams<{ orgId: string }>();
  const router = useRouter();

  const handleComplete = useCallback(() => {
    window.dispatchEvent(new Event("vault-data-changed"));
    router.refresh();
  }, [router]);

  return (
    <OrgImportPagePanel
      orgId={params.orgId}
      onComplete={handleComplete}
    />
  );
}
