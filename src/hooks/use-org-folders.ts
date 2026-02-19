"use client";

import { useEffect, useState } from "react";
import { apiPath } from "@/lib/constants";
import type { OrgFolderItem } from "@/components/org/org-password-form-types";

export function useOrgFolders(open: boolean, orgId: string) {
  const [folders, setFolders] = useState<OrgFolderItem[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    const url = apiPath.orgFolders(orgId);
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (Array.isArray(data)) {
          setFolders(data);
          setFetchError(null);
        }
      })
      .catch((e: unknown) => {
        setFetchError(
          `Failed to load ${url}: ${e instanceof Error ? e.message : "unknown"}`,
        );
      });
  }, [open, orgId]);

  return { folders, fetchError };
}
