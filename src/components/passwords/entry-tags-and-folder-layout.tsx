"use client";

import type { ReactNode } from "react";
import { EntryFolderSelectSection } from "@/components/passwords/entry-folder-select-section";
import { EntryTagsSection } from "@/components/passwords/entry-tags-section";

interface FolderLike {
  id: string;
  name: string;
  parentId: string | null;
}

interface EntryTagsAndFolderLayoutProps {
  tagsTitle: string;
  tagsHint: string;
  tagsInput: ReactNode;
  folders: FolderLike[];
  folderId: string | null;
  onFolderChange: (next: string | null) => void;
  sectionCardClass?: string;
}

export function EntryTagsAndFolderLayout({
  tagsTitle,
  tagsHint,
  tagsInput,
  folders,
  folderId,
  onFolderChange,
  sectionCardClass = "",
}: EntryTagsAndFolderLayoutProps) {
  return (
    <>
      <EntryTagsSection title={tagsTitle} hint={tagsHint} sectionCardClass={sectionCardClass}>
        {tagsInput}
      </EntryTagsSection>

      <EntryFolderSelectSection
        folders={folders}
        value={folderId}
        onChange={onFolderChange}
        sectionCardClass={sectionCardClass}
      />
    </>
  );
}
