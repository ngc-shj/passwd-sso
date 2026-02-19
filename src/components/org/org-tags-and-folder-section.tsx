"use client";

import { EntryTagsAndFolderLayout } from "@/components/passwords/entry-tags-and-folder-layout";
import { OrgTagInput } from "@/components/org/org-tag-input";
import type { OrgFolderItem } from "@/components/org/org-password-form-types";
import type { OrgTagData } from "@/components/org/org-tag-input";

interface OrgTagsAndFolderSectionProps {
  tagsTitle: string;
  tagsHint: string;
  orgId: string;
  selectedTags: OrgTagData[];
  onTagsChange: (tags: OrgTagData[]) => void;
  folders: OrgFolderItem[];
  folderId: string | null;
  onFolderChange: (folderId: string | null) => void;
  sectionCardClass?: string;
}

export function OrgTagsAndFolderSection({
  tagsTitle,
  tagsHint,
  orgId,
  selectedTags,
  onTagsChange,
  folders,
  folderId,
  onFolderChange,
  sectionCardClass = "",
}: OrgTagsAndFolderSectionProps) {
  return (
    <EntryTagsAndFolderLayout
      tagsTitle={tagsTitle}
      tagsHint={tagsHint}
      tagsInput={<OrgTagInput orgId={orgId} selectedTags={selectedTags} onChange={onTagsChange} />}
      folders={folders}
      folderId={folderId}
      onFolderChange={onFolderChange}
      sectionCardClass={sectionCardClass}
    />
  );
}
