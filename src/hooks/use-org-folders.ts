"use client";

import { useEffect, useState } from "react";
import { apiPath } from "@/lib/constants";
import type { OrgFolderItem } from "@/components/org/org-password-form-types";

export function useOrgFolders(open: boolean, orgId: string) {
  const [folders, setFolders] = useState<OrgFolderItem[]>([]);

  useEffect(() => {
    if (!open) return;

    fetch(apiPath.orgFolders(orgId))
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        if (Array.isArray(data)) {
          setFolders(data);
        }
      })
      .catch(() => {});
  }, [open, orgId]);

  return folders;
}
