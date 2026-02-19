"use client";

import { useEffect, useState } from "react";
import { apiPath } from "@/lib/constants";
import type { OrgAttachmentMeta } from "@/components/org/org-attachment-section";

export function useOrgAttachments(open: boolean, orgId: string, entryId?: string) {
  const [attachments, setAttachments] = useState<OrgAttachmentMeta[]>([]);

  useEffect(() => {
    if (!open || !entryId) return;

    fetch(apiPath.orgPasswordAttachments(orgId, entryId))
      .then((res) => (res.ok ? res.json() : []))
      .then((loaded: OrgAttachmentMeta[]) => setAttachments(loaded))
      .catch(() => setAttachments([]));
  }, [open, orgId, entryId]);

  return { attachments, setAttachments };
}
