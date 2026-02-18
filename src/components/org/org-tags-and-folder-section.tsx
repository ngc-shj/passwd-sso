"use client";

import { EntryFolderSelectSection } from "@/components/passwords/entry-folder-select-section";
import { OrgTagSection } from "@/components/org/org-tag-section";
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
    <>
      <OrgTagSection
        title={tagsTitle}
        hint={tagsHint}
        orgId={orgId}
        selectedTags={selectedTags}
        onChange={onTagsChange}
        sectionCardClass={sectionCardClass}
      />

      <EntryFolderSelectSection
        folders={folders}
        value={folderId}
        onChange={onFolderChange}
        sectionCardClass={sectionCardClass}
      />
    </>
  );
}
