"use client";

import { EntryTagsAndFolderLayout } from "@/components/passwords/entry-tags-and-folder-layout";
import type { FolderLike } from "@/components/passwords/folder-like";
import { TagInput, type TagData } from "@/components/tags/tag-input";

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
    <EntryTagsAndFolderLayout
      tagsTitle={tagsTitle}
      tagsHint={tagsHint}
      tagsInput={<TagInput selectedTags={selectedTags} onChange={onTagsChange} />}
      folders={folders}
      folderId={folderId}
      onFolderChange={onFolderChange}
      sectionCardClass={sectionCardClass}
    />
  );
}
