"use client";

import { EntryFolderSelectSection } from "@/components/passwords/entry-folder-select-section";
import { EntryTagsSection } from "@/components/passwords/entry-tags-section";
import { TagInput, type TagData } from "@/components/tags/tag-input";

interface FolderLike {
  id: string;
  name: string;
  parentId: string | null;
}

interface EntryTagsAndFolderSectionProps {
  tagsTitle: string;
  tagsHint: string;
  selectedTags: TagData[];
  onTagsChange: (next: TagData[]) => void;
  folders: FolderLike[];
  folderId: string | null;
  onFolderChange: (next: string | null) => void;
  sectionCardClass?: string;
}

export function EntryTagsAndFolderSection({
  tagsTitle,
  tagsHint,
  selectedTags,
  onTagsChange,
  folders,
  folderId,
  onFolderChange,
  sectionCardClass = "",
}: EntryTagsAndFolderSectionProps) {
  return (
    <>
      <EntryTagsSection
        title={tagsTitle}
        hint={tagsHint}
        sectionCardClass={sectionCardClass}
      >
        <TagInput selectedTags={selectedTags} onChange={onTagsChange} />
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
